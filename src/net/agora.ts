import { joinRoom, selfId, getRelaySockets } from 'trystero/nostr';
import type { Room, MessageAction, JsonValue, HandshakeSender, HandshakeReceiver } from '@trystero-p2p/core';
import { APP_ID, relayUrls, rtcConfig, type TurnSetting } from './config';
import { cleanName, peerTag } from './names';
import { deriveRoom, ROOM_PROTOCOL } from './room-keys';
import { parseHello, type Hello } from './hello';
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
 *
 * Joining is guarded at every step:
 *  - the room name and password become a hidden meeting point and key (room-keys.ts);
 *  - every peer passes a VoxPop handshake (same protocol, room not full) before it
 *    can send anything, and introduces itself inside that handshake;
 *  - every message type has a size limit, and presence repeats every few seconds,
 *    so a lost message heals by itself;
 *  - a broadcaster's phone serves a bounded number of live viewers and copies;
 *  - one page session joins one room, so two rooms can't be linked by network ids.
 */

export const MAX_PEERS = 40; // people this device connects to in one room
export const MAX_STREAMS = 8; // live viewers one broadcasting phone serves
export const MAX_COPIES = 3; // viewers saving a copy from one broadcaster at once
const MAX_PIECE = 8 * 1024 ** 2;
const HELLO_EVERY_MS = 12_000;
const HELLO_MIN_GAP_MS = 300;
const COPY_ANSWER_MS = 20_000;
const MIN_FREE_BYTES = 300 * 1024 ** 2;

export interface LiveInfo {
  id: string; // broadcast id (= recording id when the recorder is saving)
  copy: boolean; // recorder is saving, so a verified copy can be requested
  since: number; // local time, from the age the recorder reported
  seats: { max: number; used: number };
}

export interface PeerInfo {
  id: string;
  tag: string; // short per-session tag, tells apart people with the same name
  name: string;
  live: LiveInfo | null;
  stream: MediaStream | null;
  seq: number;
  heardAt: number;
  pending: Hello | null; // newest hello not applied yet (arrived too soon after the last)
  pendingTimer: number | null;
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

interface Subscriber {
  peerId: string;
  next: number;
  pumping: boolean;
  headerSent: boolean;
}

interface Broadcast {
  info: { id: string; copy: boolean; since: number };
  stream: MediaStream;
  sink: RecordingSink | null;
  header: Signed<Header> | null;
  records: Signed<ChunkRecord>[];
  beacons: Map<number, Beacon>;
  subscribers: Map<string, Subscriber>;
  seated: Set<string>; // peers receiving the live picture
  waiting: string[]; // peers waiting for a seat, in arrival order
  seal: Signed<Seal> | null;
}

interface Incoming {
  copy: CopyState;
  verifier: LiveVerifier | null;
  sink: ReplicaSink | null;
  queue: Promise<void>;
  timer: number | null;
}

/** Ends a copy without counting it as tampering (storage full, recorder busy...). */
class CopyStop extends Error {}

export type RoomStatus = 'off' | 'preparing' | 'joining' | 'joined';

export class Agora {
  status: RoomStatus = 'off';
  roomName = '';
  roomCode = '';
  isPrivate = false;
  readonly selfId = selfId;
  readonly selfTag = peerTag(selfId);
  peers = new Map<string, PeerInfo>();
  copies = new Map<string, CopyState>();
  error: string | null = null; // the room could not be joined
  peerError: string | null = null; // someone could not connect (last reason)
  /**
   * True once this page session has joined a room. The network ids (peer id and
   * relay signing key) live as long as the page, so another room needs a restart:
   * otherwise someone present in both rooms could tell it is the same person.
   */
  spent = false;
  private listeners = new Set<() => void>();

  private room: Room | null = null;
  private name = 'Anonymous';
  private seq = 0;
  private joinToken = 0;
  private helloTimer: number | null = null;
  private handshaking = new Map<string, number>(); // peer id → when its handshake started
  private introductions = new Map<string, Hello>();
  private act: {
    hi: MessageAction<JsonValue>;
    cp: MessageAction<JsonValue>;
    cx: MessageAction<JsonValue>;
    cn: MessageAction<JsonValue>;
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

  /**
   * Joins a room. Public rooms: anyone who knows the name. Private: also needs the password.
   * Throws a readable message when the room can't be joined as asked.
   */
  async join(opts: { room: string; password: string; name: string; relays: string[]; turn: TurnSetting | null; hideIp: boolean }): Promise<void> {
    if (this.spent) throw new Error('Restart VoxPop before joining another room, so the two rooms cannot be linked to you.');
    if (this.room) this.leave();
    const rtc = rtcConfig(opts.turn, opts.hideIp);
    if (typeof rtc === 'string') throw new Error(rtc);
    const token = ++this.joinToken;
    this.status = 'preparing';
    this.error = null;
    this.peerError = null;
    this.emit();
    let secrets;
    try {
      secrets = await deriveRoom(opts.room, opts.password);
    } catch (e) {
      this.status = 'off';
      this.emit();
      throw e;
    }
    if (token !== this.joinToken) return; // cancelled meanwhile
    this.spent = true;
    this.roomName = secrets.name;
    this.roomCode = secrets.code;
    this.isPrivate = secrets.isPrivate;
    this.name = cleanName(opts.name);
    this.relays = relayUrls(opts.relays);
    this.status = 'joining';

    const room = joinRoom(
      {
        appId: APP_ID,
        // Encrypts the connection details exchanged through relays. Derived from the
        // room secret, never the typed password itself.
        password: secrets.key,
        relayConfig: { urls: this.relays, warnOnRelayFailure: false },
        rtcConfig: rtc,
        maxReceiveBytes: MAX_PIECE + 1024 ** 2,
      },
      secrets.topic,
      {
        onJoinError: (d) => {
          this.peerError = d.error.replace(/^Trystero: /, '');
          this.emit();
        },
        onPeerHandshake: (peerId, send, receive) => this.handshake(peerId, send, receive),
        handshakeTimeoutMs: 15_000,
      },
    );
    this.room = room;
    const limit = (max: number) => ({ onReceive: ({ byteLength }: { byteLength: number }) => byteLength <= max });
    const hi = room.makeAction<JsonValue>('hi', limit(4096));
    const cp = room.makeAction<JsonValue>('copy-req', limit(512));
    const cx = room.makeAction<JsonValue>('copy-stop', limit(512));
    const cn = room.makeAction<JsonValue>('copy-no', limit(512));
    const rh = room.makeAction<JsonValue>('rec-head', limit(8192));
    const rc = room.makeAction<ArrayBuffer | Uint8Array>('rec-piece', {
      // Only accept pieces we asked for, from the peer we asked, within a sane size.
      onReceive: ({ peerId, byteLength, metadata }) => {
        const rid = (metadata as { rec?: { r?: unknown } } | undefined)?.rec?.r;
        const inc = typeof rid === 'string' ? this.incoming.get(rid) : undefined;
        return !!inc && inc.copy.peerId === peerId && (inc.copy.status === 'saving' || inc.copy.status === 'requested') && byteLength <= MAX_PIECE;
      },
    });
    const rs = room.makeAction<JsonValue>('rec-seal', limit(8192));
    this.act = { hi, cp, cx, cn, rh, rc, rs };

    room.onPeerJoin = (peerId) => {
      this.handshaking.delete(peerId);
      const p = this.peers.get(peerId) ?? this.newPeer(peerId);
      const intro = this.introductions.get(peerId);
      this.introductions.delete(peerId);
      if (intro) this.applyHello(p, intro);
      this.peers.set(peerId, p);
      // Our state may have changed since the handshake: say hello again.
      void hi.send(this.hello() as unknown as JsonValue, { target: peerId }).catch(() => {});
      if (this.bc) this.seat(peerId);
      this.status = 'joined';
      this.emit();
    };
    room.onPeerLeave = (peerId) => {
      this.handshaking.delete(peerId);
      this.introductions.delete(peerId);
      const gone = this.peers.get(peerId);
      if (gone?.pendingTimer) clearTimeout(gone.pendingTimer);
      this.peers.delete(peerId);
      this.unseat(peerId);
      this.bc?.subscribers.delete(peerId);
      for (const inc of this.incoming.values()) {
        if (inc.copy.peerId === peerId && (inc.copy.status === 'saving' || inc.copy.status === 'requested')) {
          void this.finishCopy(inc, 'stopped', 'The recorder left the room. The pieces received so far are kept.');
        }
      }
      this.emit();
    };
    room.onPeerStream = (stream, peerId) => {
      const p = this.peers.get(peerId);
      if (!p) return; // only peers that passed the handshake
      p.stream = stream;
      stream.getTracks().forEach((t) => t.addEventListener('ended', () => this.emit()));
      this.emit();
    };

    hi.onMessage = (data, { peerId }) => {
      const p = this.peers.get(peerId);
      const m = parseHello(data);
      if (!p || !m) return;
      // At most a few updates per second per person: a flood is reduced to its latest message.
      const wait = p.heardAt + HELLO_MIN_GAP_MS - Date.now();
      if (wait <= 0) {
        this.applyHello(p, m);
        this.emit();
        return;
      }
      if (!p.pending || m.seq > p.pending.seq) p.pending = m;
      p.pendingTimer ??= window.setTimeout(() => {
        p.pendingTimer = null;
        const latest = p.pending;
        p.pending = null;
        if (latest && this.peers.get(peerId) === p) {
          this.applyHello(p, latest);
          this.emit();
        }
      }, wait);
    };

    // --- recorder side: someone asked for a copy
    cp.onMessage = (data, { peerId }) => {
      const rid = (data as { rid?: unknown })?.rid;
      if (typeof rid !== 'string' || !this.peers.has(peerId)) return;
      const bc = this.bc;
      const no = (why: string) => void cn.send({ rid, why }, { target: peerId }).catch(() => {});
      if (!bc || rid !== bc.info.id) return no('ended');
      if (!bc.sink) return no('not-saving');
      if (bc.subscribers.has(peerId)) return;
      if (bc.subscribers.size >= MAX_COPIES) return no('busy');
      bc.subscribers.set(peerId, { peerId, next: 0, pumping: false, headerSent: false });
      void this.pump(peerId);
    };
    cx.onMessage = (data, { peerId }) => {
      if ((data as { rid?: unknown })?.rid === this.bc?.info.id) this.bc?.subscribers.delete(peerId);
    };

    // --- viewer side: answers to a copy we asked for
    cn.onMessage = (data, { peerId }) => {
      const m = data as { rid?: unknown; why?: unknown };
      const inc = typeof m?.rid === 'string' ? this.incoming.get(m.rid) : undefined;
      if (!inc || inc.copy.peerId !== peerId) return;
      const why =
        m.why === 'busy'
          ? `This broadcaster is already sending copies to ${MAX_COPIES} people. Try again in a while.`
          : m.why === 'not-saving'
            ? 'This broadcaster is not saving, so there is no copy to send.'
            : 'The broadcast has ended.';
      this.enqueue(inc, async () => {
        throw new CopyStop(why);
      });
    };
    rh.onMessage = (data, { peerId }) => {
      const header = (data as { header?: unknown })?.header as Signed<Header> | undefined;
      const rid = header?.rec?.r;
      const inc = typeof rid === 'string' ? this.incoming.get(rid) : undefined;
      if (!inc || inc.copy.peerId !== peerId || inc.verifier) return;
      this.enqueue(inc, async () => {
        inc.verifier = await LiveVerifier.start(header);
        const sink = await ReplicaSink.create(inc.verifier.header);
        if (!sink) throw new CopyStop('This recording is already saved on your device.');
        inc.sink = sink;
        inc.copy.status = 'saving';
        if (inc.timer) clearTimeout(inc.timer);
        inc.timer = null;
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
        if (inc.verifier.chunks % 15 === 1) await this.checkSpace();
        await inc.sink.add(signed, bytes, inc.verifier.beaconList);
        inc.copy.pieces = inc.verifier.chunks;
      });
    };
    rs.onMessage = (data, { peerId }) => {
      const m = data as { rid?: unknown; seal?: unknown };
      const inc = typeof m?.rid === 'string' ? this.incoming.get(m.rid) : undefined;
      if (!inc || inc.copy.peerId !== peerId) return;
      this.enqueue(inc, async () => {
        if (!inc.verifier || !inc.sink) throw new CopyStop('The recorder stopped before sending anything.');
        if (m.seal) {
          await inc.verifier.seal(m.seal);
          await inc.sink.seal(inc.verifier.sealed!);
          inc.copy.status = 'done';
          this.incoming.delete(inc.copy.rid);
        } else {
          throw new CopyStop('The recorder stopped before sealing. The pieces received so far are kept.');
        }
      });
    };

    // Presence repeats, so a lost or late message corrects itself.
    this.helloTimer = window.setInterval(() => this.sayHello(), HELLO_EVERY_MS);
    this.emit();
  }

  /**
   * Runs for every new peer before it is let in (after the library's own password
   * check). Both sides introduce themselves; anything unexpected closes the connection.
   */
  private async handshake(peerId: string, send: HandshakeSender, receive: HandshakeReceiver): Promise<void> {
    const now = Date.now();
    // A peer whose connection died after our check never reaches onPeerJoin: forget it after 30 s.
    for (const [id, at] of this.handshaking) if (now - at > 30_000) this.handshaking.delete(id);
    const full = this.peers.size + this.handshaking.size >= MAX_PEERS;
    if (!full) this.handshaking.set(peerId, now);
    try {
      await send({ t: 'voxpop', proto: ROOM_PROTOCOL, full, hello: this.hello() as unknown as JsonValue });
      if (full) throw new Error(`room full on this device (${MAX_PEERS} people)`);
      const { data } = await receive();
      const m = data as { t?: unknown; proto?: unknown; full?: unknown; hello?: unknown } | null;
      if (!m || typeof m !== 'object' || m.t !== 'voxpop') throw new Error('not a VoxPop device');
      if (m.proto !== ROOM_PROTOCOL) throw new Error('they use a different VoxPop version: both of you should reload the app');
      if (m.full === true) throw new Error(`their device is at its limit of ${MAX_PEERS} people`);
      const hello = parseHello(m.hello);
      if (!hello) throw new Error('malformed introduction');
      this.introductions.set(peerId, hello);
    } catch (e) {
      this.handshaking.delete(peerId);
      throw e;
    }
  }

  private newPeer(peerId: string): PeerInfo {
    return { id: peerId, tag: peerTag(peerId), name: 'Connecting…', live: null, stream: null, seq: -1, heardAt: 0, pending: null, pendingTimer: null };
  }

  private applyHello(p: PeerInfo, m: Hello) {
    if (m.seq <= p.seq) return; // stale or replayed
    p.seq = m.seq;
    p.heardAt = Date.now();
    p.name = cleanName(m.name);
    p.live = m.live
      ? { id: m.live.id, copy: m.live.copy, since: Date.now() - m.live.age * 1000, seats: m.live.seats }
      : null;
    if (!p.live) p.stream = null;
  }

  private enqueue(inc: Incoming, job: () => Promise<void>) {
    inc.queue = inc.queue
      .then(async () => {
        if (inc.copy.status === 'failed' || inc.copy.status === 'stopped' || inc.copy.status === 'done') return;
        await job();
      })
      .catch(async (e) => {
        const reason = (e as Error).message;
        if (e instanceof CopyStop) {
          await this.finishCopy(inc, inc.sink ? 'stopped' : 'failed', reason);
        } else {
          await addRejected({ at: Date.now(), fileName: `Live copy from ${inc.copy.peerName}`, reason, recordingId: inc.copy.rid });
          await this.finishCopy(inc, 'failed', reason);
        }
        void this.act?.cx.send({ rid: inc.copy.rid }, { target: inc.copy.peerId }).catch(() => {});
      })
      .finally(() => this.emit());
  }

  private async checkSpace() {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est?.quota && est.usage !== undefined && est.quota - est.usage < MIN_FREE_BYTES) {
      throw new CopyStop('Your phone storage is nearly full, so saving stopped. The pieces received so far are kept.');
    }
  }

  private async finishCopy(inc: Incoming, status: CopyStatus, error: string | null) {
    if (inc.timer) clearTimeout(inc.timer);
    inc.timer = null;
    inc.copy.status = status;
    inc.copy.error = error;
    if (inc.sink) await inc.sink.stop();
    this.incoming.delete(inc.copy.rid);
    this.emit();
  }

  leave() {
    this.joinToken++;
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
    if (this.bc) {
      this.bc.subscribers.clear();
      this.bc.seated.clear();
      this.bc.waiting = [];
    }
    for (const inc of this.incoming.values()) void this.finishCopy(inc, 'stopped', 'You left the room. The pieces received so far are kept.');
    void this.room?.leave();
    this.room = null;
    this.act = null;
    for (const p of this.peers.values()) if (p.pendingTimer) clearTimeout(p.pendingTimer);
    this.peers.clear();
    this.handshaking.clear();
    this.introductions.clear();
    this.status = 'off';
    this.emit();
  }

  setName(name: string) {
    this.name = cleanName(name);
    this.sayHello();
  }

  private hello(): Hello {
    const bc = this.bc;
    return {
      v: 2,
      seq: ++this.seq,
      name: this.name,
      live: bc
        ? {
            id: bc.info.id,
            copy: bc.info.copy,
            // Age, not a clock time: a device clock that is off would otherwise mark this phone.
            age: Math.min(7 * 86_400, Math.round((Date.now() - bc.info.since) / 10_000) * 10),
            seats: { max: MAX_STREAMS, used: bc.seated.size },
          }
        : null,
    };
  }

  private sayHello() {
    if (this.act) void this.act.hi.send(this.hello() as unknown as JsonValue).catch(() => {});
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

  /** The display name this device shows in the current room. */
  get myName(): string {
    return this.name;
  }

  get joined(): boolean {
    return this.room !== null;
  }

  get othersCount(): number {
    return this.peers.size;
  }

  /** People receiving our live picture right now. */
  get viewers(): number {
    return this.bc ? this.bc.seated.size : 0;
  }

  /** People who would like to watch but our phone is at its viewer limit. */
  get waitingViewers(): number {
    return this.bc ? this.bc.waiting.length : 0;
  }

  // ------------------------------------------------------------ broadcasting

  /** Gives a peer the live picture if there is a free seat, otherwise queues it. */
  private seat(peerId: string) {
    const bc = this.bc;
    if (!bc || !this.room || bc.seated.has(peerId) || bc.waiting.includes(peerId)) return;
    if (bc.seated.size >= MAX_STREAMS) {
      bc.waiting.push(peerId);
      return;
    }
    bc.seated.add(peerId);
    void Promise.all(this.room.addStream(bc.stream, { target: peerId, metadata: { id: bc.info.id } })).catch(() => {});
  }

  private unseat(peerId: string) {
    const bc = this.bc;
    if (!bc) return;
    bc.waiting = bc.waiting.filter((x) => x !== peerId);
    if (!bc.seated.delete(peerId)) return;
    const next = bc.waiting.shift();
    if (next && this.peers.has(next)) this.seat(next);
    this.sayHello();
  }

  /**
   * Starts sending our live picture to people in the room, up to MAX_STREAMS.
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
      seated: new Set(),
      waiting: [],
      seal: null,
    };
    for (const id of this.peers.keys()) this.seat(id);
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
    for (const s of bc.subscribers.keys()) {
      if (!seal) void this.act?.rs.send({ rid: bc.info.id, seal: null }, { target: s }).catch(() => {});
    }
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
    const copy: CopyState = { rid, peerId, peerName: `${p.name} ·${p.tag}`, status: 'requested', pieces: 0, error: null };
    this.copies.set(rid, copy);
    const inc: Incoming = { copy, verifier: null, sink: null, queue: Promise.resolve(), timer: null };
    inc.timer = window.setTimeout(() => {
      if (inc.copy.status === 'requested') {
        this.enqueue(inc, async () => {
          throw new CopyStop('No answer from the broadcaster. Try again.');
        });
      }
    }, COPY_ANSWER_MS);
    this.incoming.set(rid, inc);
    void this.act.cp.send({ rid }, { target: peerId }).catch(() => {});
    this.emit();
  }

  stopCopy(rid: string) {
    const inc = this.incoming.get(rid);
    if (!inc) return;
    void this.act?.cx.send({ rid }, { target: inc.copy.peerId }).catch(() => {});
    void this.finishCopy(inc, 'stopped', 'You stopped saving. The pieces received so far are kept.');
  }
}
