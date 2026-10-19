import { objectHash, sha256Hex, signObject, type Signer } from './crypto';
import type { ChunkRecord, Header, Seal, Signed } from './types';

/**
 * Builds the signed hash chain of a recording:
 *
 *   header ← chunk 0 ← chunk 1 ← … ← chunk n ← seal
 *
 * Each record carries the hash of the one before it and is signed with the
 * recording's key, so removing, reordering, editing or inserting any chunk
 * breaks the chain in a way any verifier can detect.
 */
export class ChainWriter {
  private lastHash = '';
  private count = 0;
  private bytes = 0;

  private constructor(
    private readonly signer: Signer,
    readonly header: Signed<Header>,
  ) {}

  static async start(signer: Signer, header: Header): Promise<ChainWriter> {
    const sig = await signObject(signer, header);
    const w = new ChainWriter(signer, { rec: header, sig });
    w.lastHash = await objectHash(header);
    return w;
  }

  /** Resume after a crash from the records already stored. */
  static async resume(signer: Signer, header: Signed<Header>, records: Signed<ChunkRecord>[]): Promise<ChainWriter> {
    const w = new ChainWriter(signer, header);
    w.lastHash = records.length ? await objectHash(records[records.length - 1].rec) : await objectHash(header.rec);
    w.count = records.length;
    w.bytes = records.reduce((n, r) => n + r.rec.n, 0);
    return w;
  }

  get chunkCount(): number {
    return this.count;
  }

  async addChunk(data: Uint8Array, t: number, beaconRound: number | null): Promise<Signed<ChunkRecord>> {
    const rec: ChunkRecord = {
      v: 1,
      kind: 'chunk',
      r: this.header.rec.r,
      i: this.count,
      t,
      n: data.length,
      h: await sha256Hex(data),
      p: this.lastHash,
      b: beaconRound,
    };
    const sig = await signObject(this.signer, rec);
    this.lastHash = await objectHash(rec);
    this.count += 1;
    this.bytes += data.length;
    return { rec, sig };
  }

  async seal(t: number, interrupted: boolean): Promise<Signed<Seal>> {
    const rec: Seal = {
      v: 1,
      kind: 'seal',
      r: this.header.rec.r,
      count: this.count,
      last: this.lastHash,
      bytes: this.bytes,
      t,
      interrupted,
    };
    return { rec, sig: await signObject(this.signer, rec) };
  }
}
