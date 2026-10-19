import type { SigAlg } from './crypto';

export const FORMAT = 'voxpop-witness/1';
export const APP_VERSION = 'voxpop 0.3.0';

/**
 * Coarse location cell. Integers only (signed data never contains floats):
 * the cell covers latitudes [la/k, (la+1)/k) and longitudes [lo/k, (lo+1)/k).
 * k = 1 → about 110 km cells ("region"), k = 10 → about 11 km cells ("city").
 */
export interface Cell {
  la: number;
  lo: number;
  k: 1 | 10;
}

/** First signed object of every recording. Declares how it was made. */
export interface Header {
  v: 1;
  kind: 'header';
  r: string; // recording id: 128 random bits, hex
  alg: SigAlg;
  pub: string; // base64 raw public key
  mime: string;
  t: number; // start, unix ms (device clock)
  cell: Cell | null;
  app: string;
  identity: 'one-time' | 'pseudonym';
  faces: 'masked' | 'masked-fast' | 'unmasked'; // masked = full-resolution face scan
  audio: 'disguised' | 'muted' | 'original';
}

/** One signed record per media chunk (about 2 seconds of video). */
export interface ChunkRecord {
  v: 1;
  kind: 'chunk';
  r: string;
  i: number; // 0, 1, 2, ...
  t: number; // when the chunk was signed, unix ms
  n: number; // byte length of the chunk
  h: string; // sha256 of the chunk bytes, hex
  p: string; // hash of the previous record (or of the header for i = 0)
  b: number | null; // latest verified drand round known at signing time
}

/** Final signed object: closes the chain so nothing can be cut from the end. */
export interface Seal {
  v: 1;
  kind: 'seal';
  r: string;
  count: number;
  last: string; // hash of the last chunk record (header hash if empty)
  bytes: number;
  t: number;
  interrupted: boolean; // true when sealed after a crash / forced stop
}

/** A drand "quicknet" beacon: public randomness published every 3 seconds. */
export interface Beacon {
  round: number;
  randomness: string; // hex
  signature: string; // hex, BLS on G1
}

export interface Signed<T> {
  rec: T;
  sig: string;
}

/** manifest.json inside a .voxpop bundle. */
export interface Manifest {
  format: typeof FORMAT;
  header: Signed<Header>;
  chunks: Signed<ChunkRecord>[];
  seal: Signed<Seal> | null;
  beacons: Beacon[];
  video: { file: string; mime: string; size: number; sha256: string };
}
