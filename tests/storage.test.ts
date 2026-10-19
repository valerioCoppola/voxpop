import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureVault, isUnlocked, lock, setPassphrase, tryAutoUnlock, unlock, removePassphrase } from '../src/storage/vault';
import {
  RecordingSink, exportBundle, getSettings, importVerified, listRecordings, loadVideo, recoverInterrupted,
  signerFor, wipeEverything, deleteRecording, getRecords,
} from '../src/storage/repo';
import { exportPublicKey } from '../src/core/crypto';
import { randomHex } from '../src/core/encoding';
import { parseBundle } from '../src/core/bundle';
import { verifyManifest } from '../src/core/verify';
import { APP_VERSION, type Header } from '../src/core/types';

async function newSink(identity: Header['identity'] = 'one-time') {
  const signer = await signerFor(identity);
  const header: Header = {
    v: 1, kind: 'header', r: randomHex(16), alg: signer.alg, pub: await exportPublicKey(signer.publicKey),
    mime: 'video/webm;codecs=vp8,opus', t: Date.now(), cell: null, app: APP_VERSION, identity,
    faces: 'masked', audio: 'disguised',
  };
  return RecordingSink.create(signer, header);
}

const chunk = (n: number) => crypto.getRandomValues(new Uint8Array(n));

beforeEach(async () => {
  await wipeEverything({ removeApp: false });
  await ensureVault();
});

describe('storage', () => {
  it('records, seals, exports, and the export verifies', async () => {
    const sink = await newSink();
    const parts = [chunk(500), chunk(800), chunk(300)];
    for (const p of parts) await sink.push(p, null);
    const row = await sink.finish();
    expect(row.status).toBe('sealed');
    await tryAutoUnlock();
    const video = await loadVideo(row.rid);
    expect(video.length).toBe(1600);
    expect(video.subarray(500, 1300)).toEqual(parts[1]);
    const { bytes } = await exportBundle(row.rid);
    const parsed = parseBundle(bytes);
    const rep = await verifyManifest(parsed.manifest, parsed.video);
    expect(rep.ok).toBe(true);
    expect(rep.summary?.sealed).toBe('sealed');
  });

  it('defaults are the safest options', async () => {
    const s = await getSettings();
    expect(s).toMatchObject({ location: 'off', faces: 'masked', audio: 'disguised', identity: 'one-time', beacon: false });
  });

  it('recovers a recording cut off by a crash as "interrupted", still verifiable', async () => {
    const sink = await newSink();
    await sink.push(chunk(400), null);
    await sink.push(chunk(400), null);
    // app killed here: no finish()
    expect(await recoverInterrupted()).toBe(1);
    const [row] = await listRecordings();
    expect(row.status).toBe('interrupted');
    await tryAutoUnlock();
    const { bytes } = await exportBundle(row.rid);
    const p = parseBundle(bytes);
    const rep = await verifyManifest(p.manifest, p.video);
    expect(rep.ok).toBe(true);
    expect(rep.summary?.sealed).toBe('interrupted');
  });

  it('passphrase mode: can record while locked, cannot watch without the passphrase', async () => {
    await setPassphrase('correct horse battery');
    expect(isUnlocked()).toBe(false);
    expect(await tryAutoUnlock()).toBe(false);
    const sink = await newSink();
    await sink.push(chunk(256), null);
    const row = await sink.finish();
    await expect(loadVideo(row.rid)).rejects.toThrow(/locked/);
    await expect(unlock('wrong passphrase')).rejects.toThrow(/Wrong passphrase/);
    await unlock('correct horse battery');
    expect((await loadVideo(row.rid)).length).toBe(256);
    lock();
    await removePassphrase('correct horse battery');
    expect(await tryAutoUnlock()).toBe(true);
    expect((await loadVideo(row.rid)).length).toBe(256);
  }, 30_000);

  it('pseudonym identity reuses one key; one-time does not', async () => {
    const a = await signerFor('pseudonym');
    const b = await signerFor('pseudonym');
    expect(await exportPublicKey(a.publicKey)).toBe(await exportPublicKey(b.publicKey));
    const c = await signerFor('one-time');
    const d = await signerFor('one-time');
    expect(await exportPublicKey(c.publicKey)).not.toBe(await exportPublicKey(d.publicKey));
  });

  it('imports a verified bundle from someone else and re-exports it intact', async () => {
    const sink = await newSink();
    await sink.push(chunk(700), null);
    const row = await sink.finish();
    await tryAutoUnlock();
    const { bytes } = await exportBundle(row.rid);
    await deleteRecording(row.rid);
    expect(await getRecords(row.rid)).toEqual([]);
    const p = parseBundle(bytes);
    const rep = await verifyManifest(p.manifest, p.video);
    expect(await importVerified(p.manifest as never, p.video, rep)).toBe('added');
    expect(await importVerified(p.manifest as never, p.video, rep)).toBe('exists');
    const again = parseBundle((await exportBundle(row.rid)).bytes);
    expect((await verifyManifest(again.manifest, again.video)).ok).toBe(true);
  });

  it('panic wipe removes everything', async () => {
    const sink = await newSink();
    await sink.push(chunk(100), null);
    await sink.finish();
    await wipeEverything({ removeApp: false });
    expect(await listRecordings()).toEqual([]);
  });
});
