import { FramePipeline, type PipelineStats } from './masker';
import { VoiceChain } from './voice';
import { fetchLatestBeacon } from '../core/beacon';
import { exportPublicKey } from '../core/crypto';
import { randomHex } from '../core/encoding';
import { locateCell } from '../core/geo';
import { APP_VERSION, type Beacon, type Cell, type Header } from '../core/types';
import { RecordingSink, signerFor, type RecordingRow, type Settings } from '../storage/repo';
import type { Agora } from '../net/agora';

const CHUNK_MS = 2000;
const BEACON_REFRESH_MS = 15_000;
const FPS = 24;

export interface SessionStatus {
  camera: 'off' | 'starting' | 'on' | 'denied' | 'error';
  recording: boolean;
  startedAt: number | null;
  chunksSaved: number;
  rid: string | null;
  live: boolean; // streaming to a room
  saving: boolean; // writing a signed recording on this phone
  pipeline: PipelineStats;
  beacon: { state: 'off' | 'fetching' | 'ok' | 'failed'; round: number | null };
  cell: Cell | null;
  locationState: 'off' | 'locating' | 'ok' | 'unavailable';
  error: string | null;
}

function pickMime(withAudio: boolean): string {
  const candidates = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

/**
 * One Witness session: camera preview with live protection, and recording on demand.
 * Everything happens on this device.
 */
export class WitnessSession {
  readonly video = document.createElement('video');
  readonly pipeline: FramePipeline;
  private camStream: MediaStream | null = null;
  private voice = new VoiceChain();
  private recorder: MediaRecorder | null = null;
  private sink: RecordingSink | null = null;
  private beacon: Beacon | null = null;
  private beaconTimer: number | null = null;
  private beaconAbort: AbortController | null = null;
  private stopResolve: ((row: RecordingRow | null) => void) | null = null;
  private liveOnlyStop: (() => Promise<void>) | null = null;
  /** Set by the app: the room we are in, if any. */
  agora: Agora | null = null;
  status: SessionStatus;
  onChange: (s: SessionStatus) => void = () => {};

  constructor(private settings: Settings) {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.pipeline = new FramePipeline(this.video, settings.faces);
    this.status = {
      camera: 'off',
      recording: false,
      startedAt: null,
      chunksSaved: 0,
      rid: null,
      live: false,
      saving: false,
      pipeline: this.pipeline.stats,
      beacon: { state: 'off', round: null },
      cell: null,
      locationState: 'off',
      error: null,
    };
    this.pipeline.onStats = (p) => {
      this.status.pipeline = p;
      this.emit();
    };
    this.pipeline.setOverlay(() => this.overlayLines());
  }

  private emit() {
    this.onChange(this.status);
  }

  private overlayLines(): string[] {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z';
    const lines = [`VoxPop witness  ${now}`];
    if (this.status.rid) lines.push(`rec ${this.status.rid.slice(0, 12)}  #${this.status.chunksSaved}`);
    if (this.beacon) lines.push(`drand ${this.beacon.round}  ${this.beacon.randomness.slice(0, 16)}`);
    return lines;
  }

  /** Must be called from a user tap (camera, microphone and audio need a gesture). */
  async startCamera(): Promise<void> {
    if (this.status.camera === 'on' || this.status.camera === 'starting') return;
    this.status.camera = 'starting';
    this.status.error = null;
    this.emit();
    try {
      this.camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.settings.camera, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: this.settings.audio === 'muted' ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as DOMException).name;
      this.status.camera = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error';
      this.status.error = (e as Error).message;
      this.emit();
      return;
    }
    this.video.srcObject = this.camStream;
    await this.video.play().catch(() => {});
    this.status.camera = 'on';
    this.pipeline.start();
    this.emit();
    if (this.settings.faces !== 'unmasked') {
      this.pipeline.loadDetector().catch((e) => {
        this.status.error = `Face protection failed to load: ${(e as Error).message}`;
        this.emit();
      });
    }
    void this.refreshLocation();
    this.startBeacon();
  }

  private async refreshLocation() {
    if (this.settings.location === 'off') {
      this.status.cell = null;
      this.status.locationState = 'off';
      return this.emit();
    }
    this.status.locationState = 'locating';
    this.emit();
    this.status.cell = await locateCell(this.settings.location);
    this.status.locationState = this.status.cell ? 'ok' : 'unavailable';
    this.emit();
  }

  private startBeacon() {
    if (!this.settings.beacon) {
      this.status.beacon = { state: 'off', round: null };
      return;
    }
    const tick = async () => {
      this.beaconAbort?.abort();
      this.beaconAbort = new AbortController();
      if (!this.beacon) this.status.beacon = { state: 'fetching', round: null };
      this.emit();
      try {
        this.beacon = await fetchLatestBeacon(this.beaconAbort.signal);
        this.status.beacon = { state: 'ok', round: this.beacon.round };
      } catch {
        // Keep the last good beacon: it is still a valid "no earlier than" proof.
        if (!this.beacon) this.status.beacon = { state: 'failed', round: null };
      }
      this.emit();
    };
    void tick();
    this.beaconTimer = window.setInterval(tick, BEACON_REFRESH_MS);
  }

  canRecord(): { ok: boolean; reason?: string } {
    if (this.status.camera !== 'on') return { ok: false, reason: 'Start the camera first.' };
    const st = this.pipeline.stats.state;
    if (this.settings.faces !== 'unmasked' && st !== 'protected') return { ok: false, reason: 'Waiting for face protection to be ready.' };
    if (!('MediaRecorder' in window) && !this.agora?.joined) return { ok: false, reason: 'This browser cannot record video.' };
    return { ok: true };
  }

  /**
   * Starts recording, going live, or both:
   *  - not in a room: record and save on this phone (the original Witness mode);
   *  - in a room: go live to everyone there, and also save unless "Save on this
   *    phone" is off. Live and recorded pictures are the same covered frames.
   */
  async startRecording(): Promise<void> {
    const can = this.canRecord();
    if (!can.ok) throw new Error(can.reason);
    const live = !!this.agora?.joined;
    const saving = !live || this.settings.saveLive;
    const audioTrack = await this.voice.build(this.camStream, this.settings.audio);
    const mime = pickMime(!!audioTrack);
    if (saving && !mime) throw new Error('No supported video format for recording.');
    const canvasStream = this.pipeline.output.captureStream(FPS);
    const tracks = [...canvasStream.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])];
    const stream = new MediaStream(tracks);
    const startedAt = Date.now();

    const cleanup = () => {
      this.voice.stop();
      canvasStream.getTracks().forEach((t) => t.stop());
      this.recorder = null;
      this.sink = null;
      this.liveOnlyStop = null;
      this.status.recording = false;
      this.status.live = false;
      this.status.saving = false;
      this.status.startedAt = null;
      this.status.rid = null;
      this.emit();
    };

    if (!saving) {
      // Live only: nothing is written to this phone.
      this.agora!.startBroadcast(stream, null, null);
      this.liveOnlyStop = async () => {
        await this.agora?.endBroadcast(null);
        cleanup();
      };
      this.status.recording = true;
      this.status.live = true;
      this.status.saving = false;
      this.status.startedAt = startedAt;
      this.status.chunksSaved = 0;
      this.status.rid = null;
      this.emit();
      return;
    }

    const rid = randomHex(16);
    const signer = await signerFor(this.settings.identity);
    const header: Header = {
      v: 1,
      kind: 'header',
      r: rid,
      alg: signer.alg,
      pub: await exportPublicKey(signer.publicKey),
      mime,
      t: startedAt,
      cell: this.status.cell,
      app: APP_VERSION,
      identity: this.settings.identity,
      faces: this.settings.faces,
      audio: audioTrack ? this.settings.audio : 'muted',
    };
    this.sink = await RecordingSink.create(signer, header);
    const sink = this.sink;
    if (live) this.agora!.startBroadcast(stream, sink, sink.header);

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 64_000 });
    this.recorder = rec;
    // Chunks are processed strictly in arrival order, each saved before the next.
    let chain: Promise<void> = Promise.resolve();
    rec.ondataavailable = (ev) => {
      if (!ev.data.size) return;
      const blob = ev.data;
      const beacon = this.beacon;
      chain = chain.then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const signed = await sink.push(bytes, beacon);
        if (!signed) this.status.error = `Saving failed: ${sink.error?.message ?? 'unknown error'}`;
        else {
          this.status.chunksSaved += 1;
          if (live) this.agora?.pieceSaved(signed, beacon);
        }
        this.emit();
      });
    };
    rec.onstop = async () => {
      await chain; // the last chunk is saved before the seal is written
      let row: RecordingRow | null = null;
      try {
        row = await sink.finish();
      } catch (e) {
        this.status.error = `Sealing failed: ${(e as Error).message}`;
      }
      if (live) await this.agora?.endBroadcast(row?.seal ?? null);
      cleanup();
      this.stopResolve?.(row);
      this.stopResolve = null;
    };
    rec.onerror = () => {
      if (rec.state !== 'inactive') rec.stop();
    };
    this.status.recording = true;
    this.status.live = live;
    this.status.saving = true;
    this.status.startedAt = startedAt;
    this.status.chunksSaved = 0;
    this.status.rid = rid;
    this.emit();
    rec.start(CHUNK_MS);
  }

  stopRecording(): Promise<RecordingRow | null> {
    if (this.liveOnlyStop) return this.liveOnlyStop().then(() => null);
    if (!this.recorder || this.recorder.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      this.recorder!.stop();
    });
  }

  updateSettings(s: Settings) {
    const needsRestart = s.audio !== this.settings.audio || s.camera !== this.settings.camera;
    const locChanged = s.location !== this.settings.location;
    const beaconChanged = s.beacon !== this.settings.beacon;
    this.settings = s;
    this.pipeline.setMode(s.faces);
    if (s.faces !== 'unmasked' && this.status.camera === 'on') void this.pipeline.loadDetector().catch(() => {});
    if (this.status.recording) return; // other changes apply to the next recording
    if (locChanged && this.status.camera === 'on') void this.refreshLocation();
    if (beaconChanged) {
      this.stopBeacon();
      if (this.status.camera === 'on') this.startBeacon();
    }
    if (needsRestart && this.status.camera === 'on') {
      this.stopCamera();
      void this.startCamera();
    }
  }

  private stopBeacon() {
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    this.beaconAbort?.abort();
    this.beacon = null;
    this.status.beacon = { state: 'off', round: null };
  }

  stopCamera() {
    this.pipeline.stop();
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.camStream = null;
    this.video.srcObject = null;
    this.stopBeacon();
    this.status.camera = 'off';
    this.emit();
  }

  async destroy() {
    await this.stopRecording();
    this.stopCamera();
    this.pipeline.destroy();
    this.voice.stop();
  }
}
