import { importPublicKey, objectHash, sha256Hex, verifyObject, fingerprint, type SigAlg } from './crypto';
import { roundTime, verifyBeacon } from './beacon';
import { describeCell, isValidCell } from './geo';
import { FORMAT, type Beacon, type ChunkRecord, type Header, type Manifest, type Seal, type Signed } from './types';

export type CheckLevel = 'pass' | 'fail' | 'warn' | 'info';

export interface Check {
  level: CheckLevel;
  title: string;
  detail: string;
}

export interface VerifyReport {
  ok: boolean; // no failing check
  checks: Check[];
  summary: {
    recordingId: string;
    keyFingerprint: string;
    start: number;
    end: number;
    durationMs: number;
    chunks: number;
    bytes: number;
    sealed: 'sealed' | 'interrupted' | 'unsealed';
    cell: Header['cell'];
    earliestProvenTime: number | null; // from the first beacon referenced
    beaconsVerified: number;
    faces: Header['faces'];
    audio: Header['audio'];
    identity: Header['identity'];
  } | null;
}

// ---------- strict structure checks (untrusted input) ----------

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const int = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min;
const str = (x: unknown, max = 200): x is string => typeof x === 'string' && x.length <= max;

function exactKeys(o: unknown, keys: string[]): o is Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const k = Object.keys(o).sort();
  const want = [...keys].sort();
  return k.length === want.length && k.every((x, i) => x === want[i]);
}

export function isHeader(h: unknown): h is Header {
  if (!exactKeys(h, ['v', 'kind', 'r', 'alg', 'pub', 'mime', 't', 'cell', 'app', 'identity', 'faces', 'audio'])) return false;
  return (
    h.v === 1 &&
    h.kind === 'header' &&
    str(h.r) && HEX32.test(h.r) &&
    (h.alg === 'Ed25519' || h.alg === 'ECDSA-P256') &&
    str(h.pub, 200) && B64.test(h.pub) &&
    str(h.mime, 100) && /^video\/(webm|mp4)(;[a-z0-9=.,\- ]*)?$/i.test(h.mime) &&
    int(h.t) &&
    (h.cell === null || isValidCell(h.cell)) &&
    str(h.app, 100) &&
    (h.identity === 'one-time' || h.identity === 'pseudonym') &&
    (h.faces === 'masked' || h.faces === 'masked-fast' || h.faces === 'unmasked') &&
    (h.audio === 'disguised' || h.audio === 'muted' || h.audio === 'original')
  );
}

export function isChunk(c: unknown): c is ChunkRecord {
  if (!exactKeys(c, ['v', 'kind', 'r', 'i', 't', 'n', 'h', 'p', 'b'])) return false;
  return (
    c.v === 1 && c.kind === 'chunk' && str(c.r) && HEX32.test(c.r) && int(c.i) && int(c.t) && int(c.n, 1) &&
    str(c.h) && HEX64.test(c.h) && str(c.p) && HEX64.test(c.p) && (c.b === null || int(c.b, 1))
  );
}

export function isSeal(s: unknown): s is Seal {
  if (!exactKeys(s, ['v', 'kind', 'r', 'count', 'last', 'bytes', 't', 'interrupted'])) return false;
  return (
    s.v === 1 && s.kind === 'seal' && str(s.r) && HEX32.test(s.r) && int(s.count) && str(s.last) && HEX64.test(s.last) &&
    int(s.bytes) && int(s.t) && typeof s.interrupted === 'boolean'
  );
}

export function isSigned<T>(x: unknown, inner: (r: unknown) => r is T): x is Signed<T> {
  return exactKeys(x, ['rec', 'sig']) && inner(x.rec) && str(x.sig, 200) && B64.test(x.sig as string);
}

export function isBeacon(b: unknown): b is Beacon {
  return (
    exactKeys(b, ['round', 'randomness', 'signature']) && int(b.round, 1) && str(b.randomness) &&
    HEX64.test(b.randomness) && str(b.signature) && /^[0-9a-f]{96}$/.test(b.signature as string)
  );
}

/** Validates the shape of an untrusted manifest. Returns a reason string on failure. */
export function validateManifest(m: unknown): string | null {
  if (!exactKeys(m, ['format', 'header', 'chunks', 'seal', 'beacons', 'video'])) return 'manifest has unexpected or missing fields';
  if (m.format !== FORMAT) return `unknown format "${String(m.format).slice(0, 40)}"`;
  if (!isSigned(m.header, isHeader)) return 'header is malformed';
  if (!Array.isArray(m.chunks) || m.chunks.length > 200_000) return 'chunk list is malformed';
  for (let i = 0; i < m.chunks.length; i++) if (!isSigned(m.chunks[i], isChunk)) return `chunk record ${i} is malformed`;
  if (m.seal !== null && !isSigned(m.seal, isSeal)) return 'seal is malformed';
  if (!Array.isArray(m.beacons) || m.beacons.length > 10_000 || !m.beacons.every(isBeacon)) return 'beacon list is malformed';
  const v = m.video as Record<string, unknown>;
  if (!exactKeys(v, ['file', 'mime', 'size', 'sha256']) || !str(v.file, 40) || !/^video\.(webm|mp4)$/.test(v.file as string) ||
      !str(v.mime, 100) || !int(v.size) || !str(v.sha256) || !HEX64.test(v.sha256 as string)) return 'video entry is malformed';
  return null;
}

// ---------- full verification ----------

const CLOCK_SLACK_MS = 30_000;

/**
 * Verifies a manifest against its video bytes. Every step is reported, so a
 * person can see exactly what was checked and what it does and doesn't prove.
 */
export async function verifyManifest(raw: unknown, video: Uint8Array): Promise<VerifyReport> {
  const checks: Check[] = [];
  const fail = (title: string, detail: string): VerifyReport => {
    checks.push({ level: 'fail', title, detail });
    return { ok: false, checks, summary: null };
  };

  const shapeErr = validateManifest(raw);
  if (shapeErr) return fail('File structure', shapeErr);
  const m = raw as Manifest;
  const h = m.header.rec;
  checks.push({ level: 'pass', title: 'File structure', detail: 'All fields are present and well-formed.' });

  let pub: CryptoKey;
  try {
    pub = await importPublicKey(h.alg as SigAlg, h.pub);
  } catch {
    return fail('Recording key', `The ${h.alg} public key cannot be loaded.`);
  }
  const fp = await fingerprint(h.pub);
  if (!(await verifyObject(h.alg, pub, h, m.header.sig))) return fail('Header signature', 'The header was not signed by the recording key.');
  checks.push({ level: 'pass', title: 'Header signature', detail: `Signed by key ${fp} (${h.identity === 'one-time' ? 'one-time key, not linked to any other recording' : 'pseudonym key, reused across recordings'}).` });

  // Chain
  if (m.video.mime !== h.mime) return fail('Video type', 'The video type differs from the signed header.');
  if (video.length !== m.video.size) return fail('Video size', `Expected ${m.video.size} bytes, file has ${video.length}.`);
  let prev = await objectHash(h);
  let offset = 0;
  let lastT = h.t;
  const beaconRounds = new Set(m.beacons.map((b) => b.round));
  for (let i = 0; i < m.chunks.length; i++) {
    const { rec, sig } = m.chunks[i];
    if (rec.r !== h.r) return fail('Chain', `Chunk ${i} belongs to a different recording.`);
    if (rec.i !== i) return fail('Chain', `Chunk ${i} is out of order (claims position ${rec.i}).`);
    if (rec.p !== prev) return fail('Chain', `Chunk ${i} does not link to the previous record: something was removed, added or reordered.`);
    if (!(await verifyObject(h.alg, pub, rec, sig))) return fail('Chain', `Chunk ${i} signature is invalid.`);
    if (offset + rec.n > video.length) return fail('Chain', `Chunk ${i} runs past the end of the video.`);
    const digest = await sha256Hex(video.subarray(offset, offset + rec.n));
    if (digest !== rec.h) return fail('Chain', `Chunk ${i} video data was modified after signing.`);
    if (rec.t + 5_000 < lastT) return fail('Chain', `Chunk ${i} time goes backwards.`);
    if (rec.b !== null && !beaconRounds.has(rec.b)) return fail('Chain', `Chunk ${i} references a time beacon that is not included.`);
    lastT = Math.max(lastT, rec.t);
    offset += rec.n;
    prev = await objectHash(rec);
  }
  if (offset !== video.length) return fail('Chain', `${video.length - offset} bytes of video are not covered by any signed chunk.`);
  if ((await sha256Hex(video)) !== m.video.sha256) return fail('Video checksum', 'The whole-file checksum does not match.');
  checks.push({
    level: 'pass',
    title: 'Every chunk',
    detail: m.chunks.length
      ? `${m.chunks.length} chunks, each signed and linked to the one before. No byte was changed, removed or reordered.`
      : 'The recording contains no video chunks.',
  });

  // Seal
  let sealed: 'sealed' | 'interrupted' | 'unsealed' = 'unsealed';
  let end = lastT;
  if (m.seal) {
    const s = m.seal.rec;
    if (s.r !== h.r) return fail('Seal', 'The seal belongs to a different recording.');
    if (!(await verifyObject(h.alg, pub, s, m.seal.sig))) return fail('Seal', 'The seal signature is invalid.');
    if (s.count !== m.chunks.length || s.last !== prev || s.bytes !== offset) return fail('Seal', 'The seal does not match the chunks: the end of the recording was cut or replaced.');
    sealed = s.interrupted ? 'interrupted' : 'sealed';
    end = s.t;
    checks.push(
      s.interrupted
        ? { level: 'warn', title: 'Seal', detail: 'The recording was interrupted (app closed or crashed) and sealed when VoxPop next opened. Everything up to the interruption is intact.' }
        : { level: 'pass', title: 'Seal', detail: 'The recording was closed normally. Nothing can be cut from its end.' },
    );
  } else {
    checks.push({ level: 'warn', title: 'Seal', detail: 'No seal: the chunks present are intact, but chunks after the last one could be missing.' });
  }

  // Beacons
  let earliest: number | null = null;
  let beaconsOk = 0;
  for (const b of m.beacons) {
    if (!verifyBeacon(b)) return fail('Public time proof', `Beacon round ${b.round} is not authentic.`);
    beaconsOk++;
  }
  let backdated = 0;
  for (const { rec } of m.chunks) {
    if (rec.b === null) continue;
    const bt = roundTime(rec.b);
    if (earliest === null || bt < earliest) earliest = bt;
    if (rec.t + CLOCK_SLACK_MS < bt) backdated++;
  }
  if (m.beacons.length === 0) {
    checks.push({ level: 'info', title: 'Public time proof', detail: 'Not used. Times shown come only from the recording device clock.' });
  } else {
    checks.push({
      level: 'pass',
      title: 'Public time proof',
      detail: `${beaconsOk} drand beacon${beaconsOk === 1 ? '' : 's'} verified. The signed chunks were created no earlier than ${earliest ? new Date(earliest).toISOString().replace('.000', '') : 'n/a'}. The same beacon numbers are burned into the frames: check they match to confirm the picture itself was produced after that moment.`,
    });
    if (backdated) checks.push({ level: 'warn', title: 'Device clock', detail: `${backdated} chunk time${backdated === 1 ? ' is' : 's are'} earlier than the public beacon allows. The device clock was wrong, or times were backdated.` });
  }

  // Disclosures
  checks.push({
    level: h.faces === 'unmasked' ? 'warn' : 'info',
    title: 'Faces',
    detail: h.faces === 'unmasked' ? 'The recorder turned face masking off. People in this video may be identifiable.' : h.faces === 'masked-fast' ? 'Faces were covered on the device with the fast scan: distant faces may have been missed.' : 'Faces were covered on the device before recording, scanning every frame at full resolution.',
  });
  checks.push({
    level: h.audio === 'original' ? 'warn' : 'info',
    title: 'Audio',
    detail: h.audio === 'original' ? 'Original audio: voices are not disguised.' : h.audio === 'muted' ? 'No audio was recorded.' : 'Voices were pitch-shifted on the device.',
  });
  checks.push({ level: 'info', title: 'Location', detail: h.cell ? `Coarse area only: ${describeCell(h.cell)}.` : 'No location was shared.' });

  return {
    ok: !checks.some((c) => c.level === 'fail'),
    checks,
    summary: {
      recordingId: h.r,
      keyFingerprint: fp,
      start: h.t,
      end,
      durationMs: Math.max(0, end - h.t),
      chunks: m.chunks.length,
      bytes: offset,
      sealed,
      cell: h.cell,
      earliestProvenTime: earliest,
      beaconsVerified: beaconsOk,
      faces: h.faces,
      audio: h.audio,
      identity: h.identity,
    },
  };
}
