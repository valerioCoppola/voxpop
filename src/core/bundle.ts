import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';
import { sha256Hex } from './crypto';
import { concatBytes } from './encoding';
import { FORMAT, type Beacon, type ChunkRecord, type Header, type Manifest, type Seal, type Signed } from './types';

/**
 * A .voxpop file is an ordinary ZIP archive (rename it to .zip to open it):
 *   manifest.json   all signed records, in plain readable JSON
 *   video.webm|mp4  the masked recording, exactly the bytes that were signed
 *   README.txt      what the file is and how to check it
 * Nothing in it is hidden or encrypted: it is meant to be shared and checked.
 */

export const MAX_BUNDLE_BYTES = 2 * 1024 ** 3; // 2 GB

const README = `This is a VoxPop witness recording.

manifest.json lists every signed piece of the video (about 2 seconds each).
Each piece carries a SHA-256 hash of its bytes and the hash of the piece before
it, and is signed with the recording's key. Any change to the video breaks
the chain.

To check it: open VoxPop, go to Verify, and choose this file. Or run the
independent checker: python tools/verify_witness.py <file>

Faces were masked and voices disguised on the recording device (unless the
manifest header says otherwise). No name, account, device ID or exact
location is stored anywhere in this file.
`;

export function videoFileName(mime: string): string {
  return mime.startsWith('video/mp4') ? 'video.mp4' : 'video.webm';
}

export async function buildManifest(
  header: Signed<Header>,
  chunks: Signed<ChunkRecord>[],
  seal: Signed<Seal> | null,
  beacons: Beacon[],
  video: Uint8Array,
): Promise<Manifest> {
  const used = new Set(chunks.map((c) => c.rec.b).filter((b): b is number => b !== null));
  return {
    format: FORMAT,
    header,
    chunks,
    seal,
    beacons: beacons.filter((b) => used.has(b.round)).sort((a, b) => a.round - b.round),
    video: { file: videoFileName(header.rec.mime), mime: header.rec.mime, size: video.length, sha256: await sha256Hex(video) },
  };
}

export function buildBundle(manifest: Manifest, video: Uint8Array): Uint8Array {
  return zipSync(
    {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 1)),
      [manifest.video.file]: [video, { level: 0 }],
      'README.txt': strToU8(README),
    },
    { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }, // fixed time: no device clock leak in ZIP metadata
  );
}

export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  return concatBytes(chunks);
}

/** Opens an untrusted bundle. Only the expected files are extracted, with size limits. */
export function parseBundle(bytes: Uint8Array): { manifest: unknown; video: Uint8Array; videoName: string } {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('File is larger than 2 GB.');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Not a VoxPop file (not a ZIP archive).');
  const allowed = new Set(['manifest.json', 'video.webm', 'video.mp4', 'README.txt']);
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!allowed.has(f.name)) return false;
        total += f.originalSize;
        if (f.name === 'manifest.json' && f.originalSize > 64 * 1024 ** 2) throw new Error('manifest too large');
        if (total > MAX_BUNDLE_BYTES) throw new Error('archive expands beyond 2 GB');
        return true;
      },
    });
  } catch (e) {
    throw new Error(`The archive cannot be opened: ${(e as Error).message}`);
  }
  const m = files['manifest.json'];
  if (!m) throw new Error('manifest.json is missing.');
  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(m));
  } catch {
    throw new Error('manifest.json is not valid JSON.');
  }
  const videoName = files['video.webm'] ? 'video.webm' : 'video.mp4';
  const video = files[videoName];
  if (!video) throw new Error('The video file is missing.');
  const declared = (manifest as Manifest)?.video?.file;
  if (declared !== videoName) throw new Error('The manifest names a different video file.');
  return { manifest, video, videoName };
}
