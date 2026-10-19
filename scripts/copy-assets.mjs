// Copies runtime assets that must be served as separate files (not bundled)
// into public/vendor. Everything is served from the app's own origin:
// VoxPop never loads code, models or fonts from a third-party server.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');

const files = [
  // ONNX Runtime (MIT) — runs the face detector inside a worker.
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.wasm'],
  // YuNet face detector (MIT, OpenCV Zoo) with size-agnostic input — committed in models/.
  ['models/yunet/yunet_dynamic.onnx', 'models/yunet_dynamic.onnx'],
  // Natural Earth land outlines via world-atlas (ISC) — offline ledger map.
  ['node_modules/world-atlas/land-110m.json', 'geo/land-110m.json'],
];

// Pinned digest of the committed face model (built by tools/make_dynamic_yunet.py
// from the upstream file): refuse to ship a swapped model.
const YUNET_SHA256 = 'b1b3061b1ae7a43bcc1497284ade754f701db774ef3a19481edcaf27fbc425b1';

for (const [src, dst] of files) {
  const from = join(root, src);
  if (!existsSync(from)) {
    console.error(`[assets] missing ${src} — run "npm install" first`);
    process.exit(1);
  }
  const to = join(out, dst);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const digest = createHash('sha256').update(readFileSync(join(out, 'models/yunet_dynamic.onnx'))).digest('hex');
if (digest !== YUNET_SHA256) {
  console.error(`[assets] face model digest mismatch: ${digest}`);
  process.exit(1);
}
console.log(`[assets] copied ${files.length} files to public/vendor`);
