import { describe, expect, it } from 'vitest';
import { canonicalJson, fromHex, toHex, toB64, fromB64 } from '../src/core/encoding';
import { generateSigner, exportPublicKey, type SigAlg } from '../src/core/crypto';
import { ChainWriter } from '../src/core/chain';
import { roundAt, roundTime, verifyBeacon } from '../src/core/beacon';
import { buildBundle, buildManifest, parseBundle } from '../src/core/bundle';
import { verifyManifest } from '../src/core/verify';
import { toCell, isValidCell } from '../src/core/geo';
import { APP_VERSION, type Beacon, type Header, type Manifest } from '../src/core/types';

// Real drand quicknet round 1000000 (public data).
const REAL_BEACON: Beacon = {
  round: 1000000,
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
};

describe('encoding', () => {
  it('canonical JSON sorts keys and rejects floats/undefined', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
  it('hex and base64 round-trip', () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(toHex(b)).toBe('0001feff');
    expect(fromHex('0001feff')).toEqual(b);
    expect(fromB64(toB64(b))).toEqual(b);
  });
});

describe('drand beacon', () => {
  it('verifies a real quicknet beacon', () => {
    expect(verifyBeacon(REAL_BEACON)).toBe(true);
  });
  it('rejects a beacon with the wrong round or altered signature', () => {
    expect(verifyBeacon({ ...REAL_BEACON, round: 1000001 })).toBe(false);
    const sig = REAL_BEACON.signature.slice(0, -2) + '73';
    expect(verifyBeacon({ ...REAL_BEACON, signature: sig })).toBe(false);
  });
  it('round time arithmetic is consistent', () => {
    expect(roundAt(roundTime(1000000))).toBe(1000000);
    expect(new Date(roundTime(1)).toISOString()).toBe('2023-08-23T15:09:27.000Z');
  });
});

describe('coarse location', () => {
  it('snaps to integer cells', () => {
    expect(toCell(41.9028, 12.4964, 'city')).toEqual({ la: 419, lo: 124, k: 10 });
    expect(toCell(-33.86, 151.21, 'region')).toEqual({ la: -34, lo: 151, k: 1 });
    expect(isValidCell({ la: 419, lo: 124, k: 10 })).toBe(true);
    expect(isValidCell({ la: 419, lo: 124, k: 10, exact: 1 })).toBe(false);
  });
});

async function makeRecording(alg: SigAlg, opts: { chunks?: number; seal?: boolean; beacon?: boolean } = {}) {
  const signer = await generateSigner(alg);
  const t0 = roundTime(REAL_BEACON.round) + 1000;
  const header: Header = {
    v: 1, kind: 'header', r: 'a'.repeat(32), alg, pub: await exportPublicKey(signer.publicKey),
    mime: 'video/webm;codecs=vp8,opus', t: t0, cell: { la: 419, lo: 124, k: 10 }, app: APP_VERSION,
    identity: 'one-time', faces: 'masked', audio: 'disguised',
  };
  const w = await ChainWriter.start(signer, header);
  const data: Uint8Array[] = [];
  const recs = [];
  for (let i = 0; i < (opts.chunks ?? 4); i++) {
    const d = crypto.getRandomValues(new Uint8Array(1000 + i * 37));
    data.push(d);
    recs.push(await w.addChunk(d, t0 + 2000 * (i + 1), opts.beacon ? REAL_BEACON.round : null));
  }
  const seal = opts.seal === false ? null : await w.seal(t0 + 2000 * (data.length + 1), false);
  const video = new Uint8Array(data.reduce((n, d) => n + d.length, 0));
  let off = 0;
  for (const d of data) { video.set(d, off); off += d.length; }
  const manifest = await buildManifest(w.header, recs, seal, opts.beacon ? [REAL_BEACON] : [], video);
  return { manifest, video, data };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe.each(['Ed25519', 'ECDSA-P256'] as SigAlg[])('chain + verify (%s)', (alg) => {
  it('accepts an untouched recording', async () => {
    const { manifest, video } = await makeRecording(alg, { beacon: true });
    const r = await verifyManifest(manifest, video);
    expect(r.checks.filter((c) => c.level === 'fail')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary?.sealed).toBe('sealed');
    expect(r.summary?.earliestProvenTime).toBe(roundTime(REAL_BEACON.round));
  });

  it('detects a single changed byte', async () => {
    const { manifest, video } = await makeRecording(alg);
    const v = video.slice();
    v[1500] ^= 1;
    const r = await verifyManifest(manifest, v);
    expect(r.ok).toBe(false);
    expect(r.checks.at(-1)?.detail).toMatch(/modified after signing/);
  });

  it('detects a removed chunk', async () => {
    const { manifest, data } = await makeRecording(alg);
    const m = clone(manifest) as Manifest;
    m.chunks.splice(1, 1);
    const kept = [data[0], data[2], data[3]];
    const v = new Uint8Array(kept.reduce((n, d) => n + d.length, 0));
    let o = 0; for (const d of kept) { v.set(d, o); o += d.length; }
    m.video.size = v.length;
    const r = await verifyManifest(m, v);
    expect(r.ok).toBe(false);
  });

  it('detects the end being cut when sealed', async () => {
    const { manifest, data } = await makeRecording(alg);
    const m = clone(manifest) as Manifest;
    m.chunks.pop();
    const kept = data.slice(0, 3);
    const v = new Uint8Array(kept.reduce((n, d) => n + d.length, 0));
    let o = 0; for (const d of kept) { v.set(d, o); o += d.length; }
    m.video.size = v.length;
    const { sha256Hex } = await import('../src/core/crypto');
    m.video.sha256 = await sha256Hex(v);
    const r = await verifyManifest(m, v);
    expect(r.ok).toBe(false);
    expect(r.checks.at(-1)?.title).toBe('Seal');
  });

  it('warns when there is no seal', async () => {
    const { manifest, video } = await makeRecording(alg, { seal: false });
    const r = await verifyManifest(manifest, video);
    expect(r.ok).toBe(true);
    expect(r.summary?.sealed).toBe('unsealed');
    expect(r.checks.some((c) => c.level === 'warn' && c.title === 'Seal')).toBe(true);
  });

  it('detects edited signed metadata (location)', async () => {
    const { manifest, video } = await makeRecording(alg);
    const m = clone(manifest) as Manifest;
    m.header.rec.cell = { la: 400, lo: 120, k: 10 };
    expect((await verifyManifest(m, video)).ok).toBe(false);
  });

  it('detects a forged beacon', async () => {
    const { manifest, video } = await makeRecording(alg, { beacon: true });
    const m = clone(manifest) as Manifest;
    m.beacons[0].randomness = 'f'.repeat(64);
    expect((await verifyManifest(m, video)).ok).toBe(false);
  });

  it('rejects unexpected fields (no hidden data)', async () => {
    const { manifest, video } = await makeRecording(alg);
    const m = clone(manifest) as unknown as Record<string, unknown>;
    m.extra = 'tracking-id';
    const r = await verifyManifest(m, video);
    expect(r.ok).toBe(false);
  });
});

describe('bundle', () => {
  it('round-trips through a ZIP file and still verifies', async () => {
    const { manifest, video } = await makeRecording('Ed25519', { beacon: true });
    const zip = buildBundle(manifest, video);
    const parsed = parseBundle(zip);
    expect(parsed.videoName).toBe('video.webm');
    const r = await verifyManifest(parsed.manifest, parsed.video);
    expect(r.ok).toBe(true);
  });
  it('refuses non-ZIP input', () => {
    expect(() => parseBundle(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a ZIP/);
  });
});
