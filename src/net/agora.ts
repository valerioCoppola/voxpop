import { joinRoom, selfId, getRelaySockets } from 'trystero/nostr';
import type { Room, MessageAction, JsonValue } from '@trystero-p2p/core';
import { APP_ID, iceServers, relayUrls, type TurnSetting } from './config';
import { cleanName } from './names';
import { LiveVerifier } from '../core/live';
import { randomHex } from '../core/encoding';
import type { Beacon, ChunkRecord, Header, Seal, Signed } from '../core/types';
import { ReplicaSink, addRejected, type RecordingSink } from '../storage/repo';

/**
 * The agora: rooms where people see who is present and watch each other live.
 *
 *  - Live video goes directly from the recorder to each viewer (WebRTC, end-to-end
 *    encrypted). It is the same face-covered, voice-disguised picture that gets
 *    recorded; raw camera images never leave the phone.
 *  - Nothing is stored on a viewer's device unless they tap "Save a copy". Then
 *    the recorder sends the signed pieces from the beginning, and each one is
 *    verified before it is kept.
 */

export interface LiveInfo {
  id: string; // broadcast id (= recording id when the recorder is saving)
  copy: boolean; // recorder is saving, so a verified copy can be requested
  since: number;
}

export interface PeerInfo {
  id: string;
  name: string;
  live: LiveInfo | null;
  stream: MediaStream | null;
}

export type CopyStatus = 'requested' | 'saving' | 'done' | 'stopped' | 'failed';

export interface CopyState {
  rid: string;
  peerId: string;
  peerName: string;
  status: CopyStatus;
  pieces: number;
  error: string | null;
}

interface Hello {
  v: 1;
  name: string;
  live: LiveInfo | null;
}

interface Subscriber {
  peerId: string;
  next: number;
  pumping: boolean;
  headerSent: boolean;
}

interface Broadcast {
  info: LiveInfo;
  stream: MediaStream;
  sink: RecordingSink | null;
  header: Signed<Header> | null;
  records: Signed<ChunkRecord>[];
  beacons: Map<number, Beacon>;
  subscribers: Map<string, Subscriber>;
  seal: Signed<Seal> | null;
}

interface Incoming {
  copy: CopyState;
  verifier: LiveVerifier | null;
  sink: ReplicaSink | null;
  queue: Promise<void>;
}

const MAX_PIECE = 16 * 1024 ** 2;

export type RoomStatus = 'off' | 'joining' | 'joined';

export class Agora {
  status: RoomStatus = 'off';
  roomName = '';
  isPrivate = false;
  readonly selfId = selfId;
  peers = new Map<string, PeerInfo>();
  copies = new Map<string, CopyState>();
  error: string | null = null;
  private listeners = new Set<() => void>();

  private room: Room | null = null;
  private name = 'Anonymous';
  private act: {
    hi: MessageAction<JsonValue>;
    cp: MessageAction<JsonValue>;
    cx: MessageAction<JsonValue>;
    rh: MessageAction<JsonValue>;
    rc: MessageAction<ArrayBuffer | Uint8Array>;
    rs: MessageAction<JsonValue>;
  } | null = null;
  private bc: Broadcast | null = null;
  private incoming = new Map<string, Incoming>();
  private relays: string[] = [];

  /** Get notified of any change (people, live streams, copies). Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Joins a room. Public rooms: anyone who knows the name. Private: also needs the password. */
  join(opts: { room: string; password: string; name: string; relays: string[]; turn: TurnSetting | null }) {
    if (this.room) this.leave();
    this.roomName = opts.room;
    this.isPrivate = !!opts.password;
    this.name = cleanName(opts.name);
    this.relays = relayUrls(opts.relays);
    this.error = null;
    this.status = 'joining';
    const room = joinRoom(
      {
        appId: APP_ID,
        // The connection details exchanged through relays are encrypted with this.
        // Without a password, it is derived from the room name, so relay operators
        // who don't know the room name can't read them.
        password: opts.password || `voxpop-public-room:${opts.room}`,
        relayConfig: { urls: this.relays, warnOnRelayFailure: false },
        rtcConfig: { iceServers: iceServers(opts.turn) },
        maxReceiveBytes: 64 * 1024 ** 2,
      },
      `room:${opts.room}`,
      {
        onJoinError: (d) => {
          this.error = d.error;
          this.emit();
        },
      },
    );
    this.room = room;
    const hi = room.makeAction<JsonValue>('hi');
    const cp = room.makeAction<JsonValue>('copy-req');
    const cx = room.makeAction<JsonValue>('copy-stop');
    const rh = room.makeAction<JsonValue>('rec-head');
    const rc = room.makeAction<ArrayBuffer | Uint8Array>('rec-piece', {
      // Only accept pieces we asked for, from the peer we asked, within a sane size.
      onReceive: ({ peerId, byteLength, metadata }) => {
        const rid = (metadata as { rec?: { r?: unknown } } | undefined)?.rec?.r;
        const inc = typeof rid === 'string' ? this.incoming.get(rid) : undefined;
        return !!inc && inc.copy.peerId === peerId && byteLength <= MAX_PIECE;
      },
    });
    const rs = room.makeAction<JsonValue>('rec-seal');
    this.act = { hi, cp, cx, rh, rc, rs };

    room.onPeerJoin = (peerId) => {
      if (!this.peers.has(peerId)) this.peers.set(peerId, { id: peerId, name: 'Connecting…', live: null, stream: null });
      void hi.send(this.hello() as unknown as JsonValue, { target: peerId });
      if (this.bc) void Promise.all(room.addStream(this.bc.stream, { target: peerId, metadata: { id: this.bc.info.id } }));
      this.status = 'joined';
      this.emit();
    };
    room.onPeerLeave = (peerId) => {
      this.peers.delete(peerId);
      this.bc?.subscribers.delete(peerId);
      for (const inc of this.incoming.values()) {
        if (inc.copy.peerId === peerId && (inc.copy.status === 'saving' || inc.copy.status === 'requested')) {
          void this.finishCopy(inc, 'stopped', 'The recorder left the room. The pieces received so far are kept.');
        }
      }
      this.emit();
    };
    room.onPeerStream = (stream, peerId) => {
      const p = this.peers.get(peerId) ?? { id: peerId, name: 'Connecting…', live: null, stream: null };
      p.stream = stream;
      this.peers.set(peerId, p);
      stream.getTracks().forEach((t) => t.addEventListener('ended', () => this.emit()));
      this.emit();
    };

    hi.onMessage = (data, { peerId }) => {
      const m = data as unknown as Partial<Hello>;
      const p = this.peers.get(peerId) ?? { id: peerId, name: '', live: null, stream: null };
      p.name = cleanName(m?.name);
      const live = m?.live;
      p.live =
        live && typeof live === 'object' && typeof live.id === 'string' && /^[0-9a-f]{32}$/.test(live.id)
          ? { id: live.id, copy: live.copy === true, since: Number(live.since) || Date.now() }
          : null;
      if (!p.live) p.stream = null;
      this.peers.set(peerId, p);
      this.status = 'joined';
      this.emit();
    };

    // --- recorder side: someone asked for a copy
    cp.onMessage = (data, { peerId }) => {
      const rid = (data as { rid?: unknown })?.rid;
      const bc = this.bc;
      if (!bc || !bc.sink || rid !== bc.info.id || bc.subscribers.has(peerId)) return;
      bc.subscribers.set(peerId, { peerId, next: 0, pumping: false, headerSent: false });
      void this.pump(peerId);
    };
    cx.onMessage = (data, { peerId }) => {
      if ((data as { rid?: unknown })?.rid === this.bc?.info.id) this.bc?.subscribers.delete(peerId);
    };

    // --- viewer side: pieces of a copy we asked for
    rh.onMessage = (data, { peerId }) => {
      const header = (data as { header?: unknown })?.header as Signed<Header> | undefined;
      const rid = header?.rec?.r;
      const inc = typeof rid === 'string' ? this.incoming.get(rid) : undefined;
      if (!inc || inc.copy.peerId !== peerId || inc.verifier) return;
      this.enqueue(inc, async () => {
        inc.verifier = await LiveVerifier.start(header);
        const sink = await ReplicaSink.create(inc.verifier.header);
        if (!sink) throw new Error('This recording is already saved on your device.');
        inc.sink = sink;
        inc.copy.status = 'saving';
      });
    };
    rc.onMessage = (data, { peerId, metadata }) => {
      const meta = metadata as { rec?: { r?: string }; sig?: string; beacon?: unknown } | undefined;
      const rid = meta?.rec?.r;
      const inc = typeof rid === 'string' ? this.incoming.get(rid) : undefined;
      if (!inc || inc.copy.peerId !== peerId) return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      this.enqueue(inc, async () => {
        if (!inc.verifier || !inc.sink) throw new Error('A piece arrived before the recording header.');
        const signed = await inc.verifier.addChunk({ rec: meta!.rec, sig: meta!.sig }, bytes, meta!.beacon ?? null);
        await inc.sink.add(signed, bytes, inc.verifier.beaconList);
        inc.copy.pieces = inc.verifier.chunks;
      });
    };
    rs.onMessage = (data, { peerId }) => {
      const m = data as { rid?: unknown; seal?: unknown; end?: unknown };
      const inc = typeof m?.rid === 'string' ? this.incoming.get(m.rid) : undefined;
      if (!inc || inc.copy.peerId !== peerId) return;
      this.enqueue(inc, async () => {
        if (!inc.verifier || !inc.sink) return;
        if (m.seal) {
          await inc.verifier.seal(m.seal);
          await inc.sink.seal(inc.verifier.sealed!);
          inc.copy.status = 'done';
          this.incoming.delete(inc.copy.rid);
        } else {
          await this.finishCopy(inc, 'stopped', 'The recorder stopped before sealing. The pieces received so far are kept.');
        }
      });
    };
    this.emit();
  }

  private enqueue(inc: Incoming, job: () => Promise<void>) {
    inc.queue = inc.queue
      .then(async () => {
        if (inc.copy.status === 'failed' || inc.copy.status === 'stopped' || inc.copy.status === 'done') return;
        await job();
      })
      .catch(async (e) => {
        const reason = (e as Error).message;
        await addRejected({ at: Date.now(), fileName: `Live copy from ${inc.copy.peerName}`, reason, recordingId: inc.copy.rid });
        await this.finishCopy(inc, 'failed', reason);
        void this.act?.cx.send({ rid: inc.copy.rid }, { target: inc.copy.peerId });
      })
      .finally(() => this.emit());
  }

  private async finishCopy(inc: Incoming, status: CopyStatus, error: string | null) {
    inc.copy.status = status;
    inc.copy.error = error;
    if (inc.sink) await inc.sink.stop();
    this.incoming.delete(inc.copy.rid);
    this.emit();
  }

  leave() {
    if (this.bc) this.bc.subscribers.clear();
    for (const inc of this.incoming.values()) void this.finishCopy(inc, 'stopped', 'You left the room. The pieces received so far are kept.');
    void this.room?.leave();
    this.room = null;
    this.act = null;
    this.peers.clear();
    this.status = 'off';
    this.emit();
  }

  setName(name: string) {
    this.name = cleanName(name);
    this.sayHello();
  }

  private hello(): Hello {
    return { v: 1, name: this.name, live: this.bc?.info ?? null };
  }

  private sayHello() {
    if (this.act) void this.act.hi.send(this.hello() as unknown as JsonValue);
  }

  /** How many of the meeting-point relays this device is connected to. */
  relayStatus(): { connected: number; total: number } {
    let connected = 0;
    try {
      const sockets = getRelaySockets() as Record<string, WebSocket>;
      for (const url of this.relays) if (sockets[url]?.readyState === WebSocket.OPEN) connected++;
    } catch {
      /* not joined */
    }
    return { connected, total: this.relays.length };
  }

  get joined(): boolean {
    return this.room !== null;
  }

  get othersCount(): number {
    return this.peers.size;
  }

  get viewers(): number {
    return this.bc ? this.peers.size : 0;
  }

  // ------------------------------------------------------------ broadcasting

  /**
   * Starts sending our live picture to everyone in the room.
   * `sink` is set when we also save the recording; only then can viewers ask for a copy.
   */
  startBroadcast(stream: MediaStream, sink: RecordingSink | null, header: Signed<Header> | null) {
    if (!this.room) return;
    this.bc = {
      info: { id: header?.rec.r ?? randomHex(16), copy: !!sink, since: Date.now() },
      stream,
      sink,
      header,
      records: [],
      beacons: new Map(),
      subscribers: new Map(),
      seal: null,
    };
    void Promise.all(this.room.addStream(stream, { metadata: { id: this.bc.info.id } }));
    this.sayHello();
    this.emit();
  }

  /**
   * A new signed piece of our recording is stored: forward it to viewers saving a copy.
   * The broadcast starts with the recording, so every piece passes through here and
   * the in-memory list of signed records is complete (records are small; the video
   * bytes themselves are read back from encrypted storage when sent).
   */
  pieceSaved(signed: Signed<ChunkRecord>, beacon: Beacon | null) {
    const bc = this.bc;
    if (!bc) return;
    bc.records[signed.rec.i] = signed;
    if (beacon) bc.beacons.set(beacon.round, beacon);
    for (const s of bc.subscribers.keys()) void this.pump(s);
  }

  async endBroadcast(seal: Signed<Seal> | null) {
    const bc = this.bc;
    if (!bc) return;
    bc.seal = seal;
    // Let every viewer saving a copy receive all pieces before the seal.
    await Promise.all([...bc.subscribers.keys()].map((s) => this.pump(s)));
    try {
      this.room?.removeStream(bc.stream);
    } catch {
      /* peers may be gone */
    }
    this.bc = null;
    this.sayHello();
    this.emit();
  }

  /** Sends a subscriber every piece it doesn't have yet, strictly in order, then the seal. */
  private async pump(peerId: string): Promise<void> {
    const bc = this.bc;
    const sub = bc?.subscribers.get(peerId);
    if (!bc || !sub || !bc.sink || !bc.header || !this.act || sub.pumping) return;
    sub.pumping = true;
    try {
      if (!sub.headerSent) {
        await this.act.rh.send({ header: bc.header } as unknown as JsonValue, { target: peerId });
        sub.headerSent = true;
      }
      while (bc.subscribers.has(peerId) && sub.next < bc.records.length && bc.records[sub.next]) {
        const rec = bc.records[sub.next];
        const data = await bc.sink.readChunk(sub.next);
        const beacon = rec.rec.b !== null ? bc.beacons.get(rec.rec.b) ?? null : null;
        await this.act.rc.send(data, { target: peerId, metadata: { rec: rec.rec, sig: rec.sig, beacon } as unknown as JsonValue });
        sub.next++;
      }
      if (bc.seal && bc.subscribers.has(peerId) && sub.next >= bc.records.length) {
        await this.act.rs.send({ rid: bc.info.id, seal: bc.seal } as unknown as JsonValue, { target: peerId });
        bc.subscribers.delete(peerId);
      }
    } catch {
      bc.subscribers.delete(peerId);
    } finally {
      sub.pumping = false;
    }
    // New pieces may have arrived while we were sending.
    if (bc.subscribers.has(peerId) && (sub.next < bc.records.length || bc.seal)) await this.pump(peerId);
  }

  // ------------------------------------------------------------ watching

  /** Ask a recorder for a verified copy of their live recording, from the beginning. */
  saveCopy(peerId: string) {
    const p = this.peers.get(peerId);
    if (!p?.live?.copy || !this.act) return;
    const rid = p.live.id;
    if (this.incoming.has(rid)) return;
    const copy: CopyState = { rid, peerId, peerName: p.name, status: 'requested', pieces: 0, error: null };
    this.copies.set(rid, copy);
    this.incoming.set(rid, { copy, verifier: null, sink: null, queue: Promise.resolve() });
    void this.act.cp.send({ rid }, { target: peerId });
    this.emit();
  }

  stopCopy(rid: string) {
    const inc = this.incoming.get(rid);
    if (!inc) return;
    void this.act?.cx.send({ rid }, { target: inc.copy.peerId });
    void this.finishCopy(inc, 'stopped', 'You stopped saving. The pieces received so far are kept.');
  }
}
