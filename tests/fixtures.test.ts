// Small synthetic .voxpop files shared by the app tests and the independent
// Python checker (tools/test_verify_witness.py). Regenerate with:
//   GEN_FIXTURES=1 npx vitest run tests/fixtures.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { generateSigner, exportPublicKey, type SigAlg } from '../src/core/crypto';
import { ChainWriter } from '../src/core/chain';
import { buildBundle, buildManifest, parseBundle } from '../src/core/bundle';
import { verifyManifest } from '../src/core/verify';
import { roundTime } from '../src/core/beacon';
import { APP_VERSION, type Beacon, type Header } from '../src/core/types';

const DIR = join(__dirname, 'fixtures');
const BEACON: Beacon = {
  round: 1000000,
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
};

async function make(alg: SigAlg, beacon: boolean): Promise<Uint8Array> {
  const signer = await generateSigner(alg);
  const t0 = roundTime(BEACON.round) + 5000;
  const header: Header = {
    v: 1, kind: 'header', r: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
    alg, pub: await exportPublicKey(signer.publicKey), mime: 'video/webm;codecs=vp9,opus', t: t0,
    cell: { la: 419, lo: 124, k: 10 }, app: APP_VERSION, identity: 'one-time', faces: 'masked', audio: 'disguised',
  };
  const w = await ChainWriter.start(signer, header);
  const parts = [600, 900, 750].map((n) => crypto.getRandomValues(new Uint8Array(n)));
  const recs = [];
  for (let i = 0; i < parts.length; i++) recs.push(await w.addChunk(parts[i], t0 + 2000 * (i + 1), beacon ? BEACON.round : null));
  const seal = await w.seal(t0 + 8000, false);
  const video = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { video.set(p, o); o += p.length; }
  return buildBundle(await buildManifest(w.header, recs, seal, beacon ? [BEACON] : [], video), video);
}

function tamper(zip: Uint8Array): Uint8Array {
  const f = unzipSync(zip);
  const v = f['video.webm'].slice();
  v[1000] ^= 0x01;
  return zipSync({ 'manifest.json': f['manifest.json'], 'video.webm': v, 'README.txt': strToU8('tampered') });
}

describe('fixtures', () => {
  it('exist (or are regenerated) and verify as expected', async () => {
    if (process.env.GEN_FIXTURES || !existsSync(join(DIR, 'ed25519.voxpop'))) {
      mkdirSync(DIR, { recursive: true });
      const ed = await make('Ed25519', true);
      writeFileSync(join(DIR, 'ed25519.voxpop'), ed);
      writeFileSync(join(DIR, 'ecdsa-p256.voxpop'), await make('ECDSA-P256', false));
      writeFileSync(join(DIR, 'tampered.voxpop'), tamper(ed));
    }
    for (const [name, ok] of [['ed25519.voxpop', true], ['ecdsa-p256.voxpop', true], ['tampered.voxpop', false]] as const) {
      const p = parseBundle(new Uint8Array(readFileSync(join(DIR, name))));
      expect((await verifyManifest(p.manifest, p.video)).ok, name).toBe(ok);
    }
  });
});
