import { importPublicKey, objectHash, sha256Hex, verifyObject } from './crypto';
import { verifyBeacon } from './beacon';
import { isBeacon, isChunk, isHeader, isSeal, isSigned } from './verify';
import type { Beacon, ChunkRecord, Header, Seal, Signed } from './types';

/**
 * Verifies a recording while it arrives, piece by piece, from another person.
 * The same rules as verifyManifest(), applied incrementally: every piece you
 * watch or keep has already been checked against the recorder's signature and
 * the chain before it. A failing piece throws, and nothing after it is accepted.
 */
export class LiveVerifier {
  private prev = '';
  private count = 0;
  private bytes = 0;
  private lastT = 0;
  private readonly beacons = new Map<number, Beacon>();
  sealed: Signed<Seal> | null = null;

  private constructor(
    readonly header: Signed<Header>,
    private readonly pub: CryptoKey,
  ) {}

  static async start(header: unknown): Promise<LiveVerifier> {
    if (!isSigned(header, isHeader)) throw new Error('malformed recording header');
    let pub: CryptoKey;
    try {
      pub = await importPublicKey(header.rec.alg, header.rec.pub);
    } catch {
      throw new Error('recording key cannot be loaded');
    }
    if (!(await verifyObject(header.rec.alg, pub, header.rec, header.sig))) throw new Error('header signature invalid');
    const v = new LiveVerifier(header, pub);
    v.prev = await objectHash(header.rec);
    v.lastT = header.rec.t;
    return v;
  }

  get rid(): string {
    return this.header.rec.r;
  }

  get chunks(): number {
    return this.count;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get beaconList(): Beacon[] {
    return [...this.beacons.values()];
  }

  /** Checks one piece. Throws with a human-readable reason if it is not authentic. */
  async addChunk(signed: unknown, data: Uint8Array, beacon: unknown): Promise<Signed<ChunkRecord>> {
    if (this.sealed) throw new Error('piece received after the seal');
    if (!isSigned(signed, isChunk)) throw new Error(`piece ${this.count} is malformed`);
    const rec = signed.rec;
    if (rec.r !== this.rid) throw new Error('piece belongs to another recording');
    if (rec.i !== this.count) throw new Error(`piece ${rec.i} arrived when piece ${this.count} was expected`);
    if (rec.p !== this.prev) throw new Error(`piece ${rec.i} does not link to the previous one`);
    if (rec.n !== data.length) throw new Error(`piece ${rec.i} has the wrong size`);
    if ((await sha256Hex(data)) !== rec.h) throw new Error(`piece ${rec.i} was altered`);
    if (rec.t + 5_000 < this.lastT) throw new Error(`piece ${rec.i} time goes backwards`);
    if (!(await verifyObject(this.header.rec.alg, this.pub, rec, signed.sig))) throw new Error(`piece ${rec.i} signature invalid`);
    if (rec.b !== null && !this.beacons.has(rec.b)) {
      if (!isBeacon(beacon) || beacon.round !== rec.b || !verifyBeacon(beacon)) throw new Error(`piece ${rec.i} time proof is not authentic`);
      this.beacons.set(beacon.round, beacon);
    }
    this.prev = await objectHash(rec);
    this.count += 1;
    this.bytes += data.length;
    this.lastT = Math.max(this.lastT, rec.t);
    return signed;
  }

  async seal(signed: unknown): Promise<Signed<Seal>> {
    if (!isSigned(signed, isSeal)) throw new Error('malformed seal');
    const s = signed.rec;
    if (s.r !== this.rid) throw new Error('seal belongs to another recording');
    if (!(await verifyObject(this.header.rec.alg, this.pub, s, signed.sig))) throw new Error('seal signature invalid');
    if (s.count !== this.count || s.last !== this.prev || s.bytes !== this.bytes) throw new Error('seal does not match the pieces received');
    this.sealed = signed;
    return signed;
  }
}
