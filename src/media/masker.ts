import type { DetectorRequest, DetectorResponse } from './detector.worker';
import DetectorWorker from './detector.worker?worker';
import { maskRect, type Box } from './yunet';

export type ProtectionState = 'loading' | 'protected' | 'obscured' | 'unmasked';

export interface PipelineStats {
  state: ProtectionState;
  faces: number;
  detectMs: number;
  fps: number;
  threads: number;
  error: string | null;
}

export type FaceMode = 'masked' | 'masked-fast' | 'unmasked';

const HOLD_FRAMES = 3; // keep masks from the last 3 checked frames: covers single-frame misses
const MASK_COLOR = '#26343d';

/**
 * Camera → checked frame → output canvas.
 *
 * Safety rule: a camera frame is drawn on the output canvas (the only thing
 * the recorder ever sees) only AFTER the detector has finished checking that
 * exact frame and its faces are covered. If the detector is loading, slow to
 * start, or fails, frames are drawn heavily obscured instead (fail closed).
 * Raw camera pixels are never stored and never reach the recorder.
 */
export class FramePipeline {
  readonly output: HTMLCanvasElement;
  private readonly work = document.createElement('canvas');
  private readonly wctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly tiny = document.createElement('canvas');
  private worker: Worker | null = null;
  private ready = false;
  private running = false;
  private nextId = 1;
  private pending: { id: number; resolve: (b: Box[] | null) => void } | null = null;
  private history: Box[][] = [];
  private frames = 0;
  private fpsT = performance.now();
  private overlay: () => string[] = () => [];
  stats: PipelineStats = { state: 'loading', faces: 0, detectMs: 0, fps: 0, threads: 0, error: null };
  onStats: (s: PipelineStats) => void = () => {};

  constructor(
    private readonly video: HTMLVideoElement,
    private mode: FaceMode,
  ) {
    this.output = document.createElement('canvas');
    this.output.className = 'stage-canvas';
    this.wctx = this.work.getContext('2d', { willReadFrequently: false })!;
    this.octx = this.output.getContext('2d')!;
    this.tiny.width = 32;
    this.tiny.height = 18;
  }

  setOverlay(fn: () => string[]) {
    this.overlay = fn;
  }

  setMode(mode: FaceMode) {
    this.mode = mode;
    this.history = [];
  }

  /** Loads the face detector in a worker. Resolves when ready (or rejects). */
  async loadDetector(): Promise<void> {
    if (this.worker) return;
    const w = new DetectorWorker();
    this.worker = w;
    await new Promise<void>((resolve, reject) => {
      w.onmessage = (ev: MessageEvent<DetectorResponse>) => {
        const m = ev.data;
        if (m.type === 'ready') {
          this.ready = true;
          this.stats.threads = m.threads;
          resolve();
        } else if (m.type === 'result') {
          if (this.pending?.id === m.id) {
            this.stats.detectMs = m.ms;
            this.pending.resolve(m.boxes);
            this.pending = null;
          }
        } else if (m.type === 'error') {
          this.stats.error = m.message;
          if (m.id === null) reject(new Error(m.message));
          else if (this.pending?.id === m.id) {
            this.pending.resolve(null);
            this.pending = null;
          }
        }
      };
      w.onerror = (e) => {
        this.stats.error = e.message || 'detector crashed';
        this.ready = false;
        this.pending?.resolve(null);
        this.pending = null;
        reject(new Error(this.stats.error));
      };
      const base = new URL('./', location.href).href;
      w.postMessage({ type: 'init', base } satisfies DetectorRequest);
    });
  }

  private detect(frame: ImageBitmap): Promise<Box[] | null> {
    if (!this.worker || !this.ready) {
      frame.close();
      return Promise.resolve(null);
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      const mode = this.mode === 'masked-fast' ? 'fast' : 'thorough';
      this.worker!.postMessage({ type: 'detect', id, frame, mode } satisfies DetectorRequest, [frame]);
      // A detector that stalls must not freeze the picture unprotected: give up after 2 s.
      setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = null;
          resolve(null);
        }
      }, 2000);
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  destroy() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  private async loop() {
    while (this.running) {
      const v = this.video;
      if (v.readyState < 2 || !v.videoWidth) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const W = v.videoWidth;
      const H = v.videoHeight;
      if (this.work.width !== W || this.work.height !== H) {
        this.work.width = this.output.width = W;
        this.work.height = this.output.height = H;
        this.history = [];
      }
      // 1. Freeze this frame.
      this.wctx.drawImage(v, 0, 0, W, H);

      let state: ProtectionState;
      let masks: Box[] = [];
      if (this.mode === 'unmasked') {
        state = 'unmasked';
      } else {
        // 2. Check this exact frame.
        const boxes = await this.detect(await createImageBitmap(this.work));
        if (boxes) {
          this.history.push(boxes);
          if (this.history.length > HOLD_FRAMES) this.history.shift();
          masks = this.history.flat();
          state = 'protected';
          this.stats.faces = boxes.length;
        } else {
          this.history = [];
          state = this.ready ? 'obscured' : 'loading';
        }
      }
      if (!this.running) break;

      // 3. Only now draw it, with faces covered.
      const o = this.octx;
      if (state === 'protected' || state === 'unmasked') {
        o.drawImage(this.work, 0, 0);
        o.fillStyle = MASK_COLOR;
        for (const b of masks) {
          const m = maskRect(b, W, H);
          const r = Math.min(m.w, m.h) * 0.3;
          o.beginPath();
          o.roundRect(m.x, m.y, m.w, m.h, r);
          o.fill();
        }
      } else {
        this.drawObscured(W, H, state === 'loading' ? 'Loading face protection…' : 'Face protection paused');
      }
      this.drawOverlay(W, H);

      this.frames++;
      const now = performance.now();
      if (now - this.fpsT > 1000) {
        this.stats.fps = Math.round((this.frames * 1000) / (now - this.fpsT));
        this.frames = 0;
        this.fpsT = now;
      }
      if (this.stats.state !== state) this.stats.state = state;
      this.onStats(this.stats);
      // Let the browser paint; cap the loop at ~30 fps.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  }

  /** Whole frame reduced to 32×18 pixels and blown up: shapes visible, nobody identifiable. */
  private drawObscured(W: number, H: number, label: string) {
    const t = this.tiny.getContext('2d')!;
    t.drawImage(this.work, 0, 0, 32, 18);
    const o = this.octx;
    o.imageSmoothingEnabled = true;
    o.drawImage(this.tiny, 0, 0, W, H);
    o.fillStyle = 'rgba(14, 26, 36, 0.55)';
    o.fillRect(0, 0, W, H);
    o.fillStyle = '#fff';
    o.font = `600 ${Math.round(H / 22)}px system-ui, sans-serif`;
    o.textAlign = 'center';
    o.fillText(label, W / 2, H / 2);
    o.textAlign = 'start';
  }

  /** Burned-in text: time, recording id and public beacon — part of the pixels, so part of the proof. */
  private drawOverlay(W: number, H: number) {
    const lines = this.overlay();
    if (!lines.length) return;
    const o = this.octx;
    const fs = Math.max(12, Math.round(H / 34));
    o.font = `600 ${fs}px ui-monospace, monospace`;
    const pad = fs * 0.5;
    const width = Math.max(...lines.map((l) => o.measureText(l).width)) + pad * 2;
    const height = lines.length * fs * 1.3 + pad * 1.2;
    o.fillStyle = 'rgba(0,0,0,0.6)';
    o.fillRect(pad, H - height - pad, Math.min(width, W - pad * 2), height);
    o.fillStyle = '#fff';
    lines.forEach((l, i) => o.fillText(l, pad * 2, H - height - pad + pad + fs * (i + 1) * 1.2 - fs * 0.2));
  }
}
