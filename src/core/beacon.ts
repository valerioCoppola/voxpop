import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex } from './encoding';
import type { Beacon } from './types';

/**
 * drand "quicknet": a public randomness beacon run by the League of Entropy
 * (independent universities and companies). Every 3 seconds it publishes a
 * new number nobody could predict in advance, with a BLS signature anyone
 * can check against a fixed public key.
 *
 * Showing such a number in a video proves the frames were produced *after*
 * that moment. It does not prove *where* or *who*, and it does not prove the
 * scene itself is real — corroboration by independent witnesses does that.
 */
export const QUICKNET = {
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367, // unix seconds
  period: 3, // seconds
  mirrors: ['https://api.drand.sh', 'https://drand.cloudflare.com'],
} as const;

const PK = fromHex(QUICKNET.publicKey);

/** Unix ms at which a round was published. */
export function roundTime(round: number): number {
  return (QUICKNET.genesis + (round - 1) * QUICKNET.period) * 1000;
}

/** Latest round that could have been published by time `ms`. */
export function roundAt(ms: number): number {
  return Math.floor((ms / 1000 - QUICKNET.genesis) / QUICKNET.period) + 1;
}

/**
 * Checks a beacon is authentic: the BLS signature over sha256(round as 8-byte
 * big-endian) verifies against the quicknet key, and randomness = sha256(signature).
 */
export function verifyBeacon(b: Beacon): boolean {
  try {
    if (!Number.isSafeInteger(b.round) || b.round < 1) return false;
    const sig = fromHex(b.signature);
    if (toHex(sha256(sig)) !== b.randomness.toLowerCase()) return false;
    const m = new Uint8Array(8);
    new DataView(m.buffer).setBigUint64(0, BigInt(b.round));
    const ss = bls.shortSignatures;
    return ss.verify(sig, ss.hash(sha256(m)), PK);
  } catch {
    return false;
  }
}

/** Fetches and verifies the latest beacon. Contacts the network: only called when the user enabled it. */
export async function fetchLatestBeacon(signal?: AbortSignal): Promise<Beacon> {
  let lastErr: unknown;
  for (const base of QUICKNET.mirrors) {
    try {
      const res = await fetch(`${base}/${QUICKNET.chainHash}/public/latest`, {
        signal,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const b: Beacon = { round: j.round, randomness: j.randomness, signature: j.signature };
      if (!verifyBeacon(b)) throw new Error('beacon signature invalid');
      return b;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('beacon unavailable');
}
