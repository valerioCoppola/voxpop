import { describe, expect, it } from 'vitest';
import { LiveVerifier } from '../src/core/live';
import { ChainWriter } from '../src/core/chain';
import { exportPublicKey, generateSigner } from '../src/core/crypto';
import { roundTime } from '../src/core/beacon';
import { APP_VERSION, type Beacon, type Header } from '../src/core/types';

const BEACON: Beacon = {
  round: 1000000,
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
};

async function stream(n = 3, beacon = false) {
  const signer = await generateSigner();
  const t0 = roundTime(BEACON.round) + 1000;
  const header: Header = {
    v: 1, kind: 'header', r: 'b'.repeat(32), alg: signer.alg, pub: await exportPublicKey(signer.publicKey),
    mime: 'video/webm;codecs=vp9,opus', t: t0, cell: null, app: APP_VERSION, identity: 'one-time', faces: 'masked', audio: 'disguised',
  };
  const w = await ChainWriter.start(signer, header);
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const data = crypto.getRandomValues(new Uint8Array(500 + i));
    pieces.push({ signed: await w.addChunk(data, t0 + 2000 * (i + 1), beacon ? BEACON.round : null), data });
  }
  return { header: w.header, pieces, seal: await w.seal(t0 + 9000, false) };
}

describe('live verification', () => {
  it('accepts an authentic stream piece by piece, then the seal', async () => {
    const s = await stream(3, true);
    const v = await LiveVerifier.start(s.header);
    for (const p of s.pieces) await v.addChunk(p.signed, p.data, BEACON);
    await v.seal(s.seal);
    expect(v.chunks).toBe(3);
    expect(v.beaconList).toEqual([BEACON]);
  });

  it('rejects an altered piece', async () => {
    const s = await stream();
    const v = await LiveVerifier.start(s.header);
    const bad = s.pieces[0].data.slice();
    bad[3] ^= 1;
    await expect(v.addChunk(s.pieces[0].signed, bad, null)).rejects.toThrow(/altered/);
  });

  it('rejects a skipped or reordered piece', async () => {
    const s = await stream();
    const v = await LiveVerifier.start(s.header);
    await expect(v.addChunk(s.pieces[1].signed, s.pieces[1].data, null)).rejects.toThrow(/expected/);
  });

  it('rejects a forged header and a seal that hides missing pieces', async () => {
    const s = await stream();
    await expect(LiveVerifier.start({ ...s.header, rec: { ...s.header.rec, cell: { la: 1, lo: 1, k: 1 } } })).rejects.toThrow(/signature/);
    const v = await LiveVerifier.start(s.header);
    await v.addChunk(s.pieces[0].signed, s.pieces[0].data, null);
    await expect(v.seal(s.seal)).rejects.toThrow(/does not match/);
  });

  it('rejects a piece whose time proof is missing or fake', async () => {
    const s = await stream(1, true);
    const v = await LiveVerifier.start(s.header);
    await expect(v.addChunk(s.pieces[0].signed, s.pieces[0].data, { ...BEACON, randomness: 'f'.repeat(64) })).rejects.toThrow(/time proof/);
  });
});
