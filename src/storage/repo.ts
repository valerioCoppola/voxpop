import { del, deleteRecordingData, destroyDb, get, getAll, put, putMany, ridRange } from './db';
import { decryptChunk, encryptChunk, newRecordingKey, openRecordingKey, resetVaultMemory, type Sealed } from './vault';
import { ChainWriter } from '../core/chain';
import { buildBundle, buildManifest } from '../core/bundle';
import { concatBytes } from '../core/encoding';
import { generateSigner, type Signer } from '../core/crypto';
import type { LocationPrecision } from '../core/geo';
import { randomName } from '../net/names';
import type { TurnSetting } from '../net/config';
import type { Beacon, ChunkRecord, Header, Seal, Signed } from '../core/types';
import type { VerifyReport } from '../core/verify';

// ---------------- settings ----------------

export interface Settings {
  location: LocationPrecision;
  audio: Header['audio'];
  faces: Header['faces'];
  identity: Header['identity'];
  beacon: boolean;
  camera: 'environment' | 'user';
  // Agora (live rooms)
  name: string; // display name shown to others in a room; not an identity
  room: string; // last room joined
  saveLive: boolean; // while live in a room, also save the recording on this phone
  relays: string[]; // custom meeting-point relays (empty = defaults)
  turn: TurnSetting | null; // optional relay for networks that block direct connections
}

export const DEFAULT_SETTINGS: Settings = {
  location: 'off',
  audio: 'disguised',
  faces: 'masked',
  identity: 'one-time',
  beacon: false,
  camera: 'environment',
  name: '',
  room: 'agora',
  saveLive: true,
  relays: [],
  turn: null,
};

export async function getSettings(): Promise<Settings> {
  const s = { ...DEFAULT_SETTINGS, ...((await get<Partial<Settings>>('kv', 'settings')) ?? {}) };
  if (!s.name) {
    s.name = randomName();
    await saveSettings(s);
  }
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  await put('kv', s, 'settings');
}

// ---------------- recordings ----------------

export type RecordingStatus = 'recording' | 'sealed' | 'interrupted' | 'unsealed';

export interface RecordingRow {
  rid: string;
  origin: 'own' | 'imported' | 'live'; // live = copy saved while watching someone's broadcast
  header: Signed<Header>;
  seal: Signed<Seal> | null;
  beacons: Beacon[];
  ephPub: Uint8Array;
  status: RecordingStatus;
  chunks: number;
  bytes: number;
  lastT: number;
  addedAt: number;
  report?: VerifyReport['summary'];
}

interface StoredSigner {
  alg: Signer['alg'];
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

const chunkAad = (rid: string, i: number) => `${rid}:${i}`;

export async function listRecordings(): Promise<RecordingRow[]> {
  const rows = await getAll<RecordingRow>('recordings');
  return rows.sort((a, b) => b.header.rec.t - a.header.rec.t);
}

export async function getRecording(rid: string): Promise<RecordingRow | undefined> {
  return get<RecordingRow>('recordings', rid);
}

export async function getRecords(rid: string): Promise<Signed<ChunkRecord>[]> {
  return getAll<Signed<ChunkRecord>>('records', ridRange(rid));
}

/** Signing key for recordings: one-time (fresh per recording) or the long-lived pseudonym. */
export async function signerFor(identity: Header['identity']): Promise<Signer> {
  if (identity === 'one-time') return generateSigner();
  let s = await get<StoredSigner>('kv', 'pseudonym');
  if (!s) {
    s = await generateSigner();
    await put('kv', s, 'pseudonym');
  }
  return s;
}

/** A live recording being written to storage, chunk by chunk. */
export class RecordingSink {
  private queue: Promise<void> = Promise.resolve();
  private failed: Error | null = null;

  private constructor(
    private readonly row: RecordingRow,
    private readonly chain: ChainWriter,
    private readonly key: CryptoKey,
  ) {}

  static async create(signer: Signer, header: Header): Promise<RecordingSink> {
    const chain = await ChainWriter.start(signer, header);
    const { key, ephPub } = await newRecordingKey(header.r);
    const row: RecordingRow = {
      rid: header.r,
      origin: 'own',
      header: chain.header,
      seal: null,
      beacons: [],
      ephPub,
      status: 'recording',
      chunks: 0,
      bytes: 0,
      lastT: header.t,
      addedAt: Date.now(),
    };
    // The signing key is kept only until the recording is sealed (crash recovery).
    await putMany([
      { store: 'recordings', value: row },
      { store: 'kv', value: { alg: signer.alg, publicKey: signer.publicKey, privateKey: signer.privateKey }, key: `sk:${header.r}` },
    ]);
    return new RecordingSink(row, chain, key);
  }

  get rid(): string {
    return this.row.rid;
  }

  get error(): Error | null {
    return this.failed;
  }

  get header(): Signed<Header> {
    return this.chain.header;
  }

  /** Queue a chunk: hash, sign, encrypt, store — strictly in order. Resolves with the signed record. */
  push(data: Uint8Array, beacon: Beacon | null): Promise<Signed<ChunkRecord> | null> {
    const job = this.queue.then(async (): Promise<Signed<ChunkRecord> | null> => {
      if (this.failed) return null;
      try {
        const t = Date.now();
        const signed = await this.chain.addChunk(data, t, beacon?.round ?? null);
        const i = signed.rec.i;
        const sealed = await encryptChunk(this.key, data, chunkAad(this.row.rid, i));
        if (beacon && !this.row.beacons.some((b) => b.round === beacon.round)) this.row.beacons.push(beacon);
        this.row.chunks = i + 1;
        this.row.bytes += data.length;
        this.row.lastT = t;
        await putMany([
          { store: 'records', value: signed, key: [this.row.rid, i] },
          { store: 'chunks', value: sealed, key: [this.row.rid, i] },
          { store: 'recordings', value: this.row },
        ]);
        return signed;
      } catch (e) {
        this.failed = e as Error;
        return null;
      }
    });
    this.queue = job.then(() => undefined);
    return job;
  }

  /** Reads back one of this recording's pieces (to send a copy to a viewer). Works while the vault is locked. */
  async readChunk(i: number): Promise<Uint8Array> {
    const sealed = await get<Sealed>('chunks', [this.row.rid, i]);
    if (!sealed) throw new Error(`piece ${i} not stored`);
    return decryptChunk(this.key, sealed, chunkAad(this.row.rid, i));
  }

  get beacons(): Beacon[] {
    return this.row.beacons;
  }

  async finish(): Promise<RecordingRow> {
    await this.queue;
    const seal = await this.chain.seal(Date.now(), false);
    this.row.seal = seal;
    this.row.status = 'sealed';
    await put('recordings', this.row);
    await del('kv', `sk:${this.row.rid}`);
    return this.row;
  }
}

/**
 * A verified copy of someone else's live broadcast, saved only because the
 * viewer asked for it. Pieces arrive already checked by LiveVerifier.
 */
export class ReplicaSink {
  private constructor(
    private readonly row: RecordingRow,
    private readonly key: CryptoKey,
  ) {}

  /** Returns null if this recording is already on the device. */
  static async create(header: Signed<Header>): Promise<ReplicaSink | null> {
    if (await getRecording(header.rec.r)) return null;
    const { key, ephPub } = await newRecordingKey(header.rec.r);
    const row: RecordingRow = {
      rid: header.rec.r,
      origin: 'live',
      header,
      seal: null,
      beacons: [],
      ephPub,
      status: 'recording',
      chunks: 0,
      bytes: 0,
      lastT: header.rec.t,
      addedAt: Date.now(),
    };
    await put('recordings', row);
    return new ReplicaSink(row, key);
  }

  get chunks(): number {
    return this.row.chunks;
  }

  async add(signed: Signed<ChunkRecord>, data: Uint8Array, beacons: Beacon[]): Promise<void> {
    const i = signed.rec.i;
    const sealed = await encryptChunk(this.key, data, chunkAad(this.row.rid, i));
    this.row.beacons = beacons;
    this.row.chunks = i + 1;
    this.row.bytes += data.length;
    this.row.lastT = signed.rec.t;
    await putMany([
      { store: 'records', value: signed, key: [this.row.rid, i] },
      { store: 'chunks', value: sealed, key: [this.row.rid, i] },
      { store: 'recordings', value: this.row },
    ]);
  }

  async seal(seal: Signed<Seal>): Promise<RecordingRow> {
    this.row.seal = seal;
    this.row.status = seal.rec.interrupted ? 'interrupted' : 'sealed';
    await put('recordings', this.row);
    return this.row;
  }

  /** The viewer stopped saving, or the broadcaster vanished: keep the verified pieces so far. */
  async stop(): Promise<RecordingRow> {
    if (this.row.status === 'recording') {
      this.row.status = 'unsealed';
      await put('recordings', this.row);
    }
    return this.row;
  }
}

/** On startup: seal recordings that were cut off by a crash or a closed app. */
export async function recoverInterrupted(): Promise<number> {
  let n = 0;
  for (const row of await getAll<RecordingRow>('recordings')) {
    if (row.status !== 'recording') continue;
    const sk = await get<StoredSigner>('kv', `sk:${row.rid}`);
    const records = await getRecords(row.rid);
    if (sk) {
      const chain = await ChainWriter.resume(sk, row.header, records);
      row.seal = await chain.seal(records.at(-1)?.rec.t ?? row.header.rec.t, true);
      row.status = 'interrupted';
    } else {
      row.status = 'unsealed';
    }
    row.chunks = records.length;
    row.bytes = records.reduce((s, r) => s + r.rec.n, 0);
    await put('recordings', row);
    await del('kv', `sk:${row.rid}`);
    n++;
  }
  return n;
}

/** Decrypts and joins a recording's video. Needs the vault unlocked. */
export async function loadVideo(rid: string): Promise<Uint8Array> {
  const row = await getRecording(rid);
  if (!row) throw new Error('recording not found');
  const key = await openRecordingKey(rid, row.ephPub);
  const sealed = await getAll<Sealed>('chunks', ridRange(rid));
  const parts: Uint8Array[] = [];
  for (let i = 0; i < sealed.length; i++) parts.push(await decryptChunk(key, sealed[i], chunkAad(rid, i)));
  return concatBytes(parts);
}

/** Builds the shareable .voxpop file. Needs the vault unlocked. */
export async function exportBundle(rid: string): Promise<{ bytes: Uint8Array; name: string }> {
  const row = await getRecording(rid);
  if (!row) throw new Error('recording not found');
  const video = await loadVideo(rid);
  const manifest = await buildManifest(row.header, await getRecords(rid), row.seal, row.beacons, video);
  const date = new Date(row.header.rec.t).toISOString().slice(0, 10);
  return { bytes: buildBundle(manifest, video), name: `voxpop-${date}-${rid.slice(0, 8)}.voxpop` };
}

/** Stores a verified bundle received from someone else (encrypted at rest like our own). */
export async function importVerified(
  manifest: { header: Signed<Header>; chunks: Signed<ChunkRecord>[]; seal: Signed<Seal> | null; beacons: Beacon[] },
  video: Uint8Array,
  report: VerifyReport,
): Promise<'added' | 'exists'> {
  const rid = manifest.header.rec.r;
  if (await getRecording(rid)) return 'exists';
  const { key, ephPub } = await newRecordingKey(rid);
  const ops: { store: 'records' | 'chunks' | 'recordings'; value: unknown; key?: IDBValidKey }[] = [];
  let off = 0;
  for (const c of manifest.chunks) {
    const i = c.rec.i;
    ops.push({ store: 'records', value: c, key: [rid, i] });
    ops.push({ store: 'chunks', value: await encryptChunk(key, video.subarray(off, off + c.rec.n), chunkAad(rid, i)), key: [rid, i] });
    off += c.rec.n;
  }
  const row: RecordingRow = {
    rid,
    origin: 'imported',
    header: manifest.header,
    seal: manifest.seal,
    beacons: manifest.beacons,
    ephPub,
    status: report.summary!.sealed,
    chunks: manifest.chunks.length,
    bytes: off,
    lastT: report.summary!.end,
    addedAt: Date.now(),
    report: report.summary,
  };
  ops.push({ store: 'recordings', value: row });
  await putMany(ops);
  return 'added';
}

export async function deleteRecording(rid: string): Promise<void> {
  await deleteRecordingData(rid);
}

// ---------------- rejected files (shown, never played) ----------------

export interface RejectedRow {
  id?: number;
  at: number;
  fileName: string;
  reason: string;
  recordingId: string | null;
}

export async function addRejected(r: RejectedRow): Promise<void> {
  await put('rejected', r);
}

export async function listRejected(): Promise<RejectedRow[]> {
  return (await getAll<RejectedRow>('rejected')).sort((a, b) => b.at - a.at);
}

// ---------------- panic wipe ----------------

/**
 * Deletes every VoxPop key, recording and setting on this device.
 * Because chunks are encrypted, deleting the keys alone makes any leftover
 * bytes on the flash storage unreadable.
 */
export async function wipeEverything(opts: { removeApp: boolean }): Promise<void> {
  resetVaultMemory();
  await destroyDb();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* storage may be unavailable */
  }
  if (opts.removeApp) {
    if ('caches' in self) for (const k of await caches.keys()) await caches.delete(k);
    if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  }
}
