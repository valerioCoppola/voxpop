/// <reference lib="webworker" />
// Face detection runs in this worker so the camera preview stays smooth.
// It receives one frame at a time and returns face boxes for that exact frame.
import * as ort from 'ort-extern';
import { decode, inputSize, nms, toBgrPlanar, type ScanMode } from './yunet';

export type DetectorRequest =
  | { type: 'init'; base: string }
  | { type: 'detect'; id: number; frame: ImageBitmap; mode: ScanMode };

export type DetectorResponse =
  | { type: 'ready'; threads: number }
  | { type: 'result'; id: number; boxes: import('./yunet').Box[]; ms: number; input: string }
  | { type: 'error'; id: number | null; message: string };

const THRESHOLD = 0.5; // low on purpose: a false mask costs little, a missed face costs a lot

let session: ort.InferenceSession | null = null;
const canvas = new OffscreenCanvas(32, 32);
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
let input: Float32Array<ArrayBuffer> = new Float32Array(0);

const post = (m: DetectorResponse) => (self as DedicatedWorkerGlobalScope).postMessage(m);

async function init(base: string) {
  const threads = self.crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = {
    mjs: new URL('vendor/ort/ort-wasm-simd-threaded.mjs', base).href,
    wasm: new URL('vendor/ort/ort-wasm-simd-threaded.wasm', base).href,
  };
  const res = await fetch(new URL('vendor/models/yunet_dynamic.onnx', base));
  if (!res.ok) throw new Error(`face model HTTP ${res.status}`);
  const model = new Uint8Array(await res.arrayBuffer());
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  post({ type: 'ready', threads });
}

async function detect(id: number, frame: ImageBitmap, mode: ScanMode) {
  const t0 = performance.now();
  try {
    if (!session) throw new Error('detector not ready');
    const size = inputSize(mode, frame.width, frame.height);
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.drawImage(frame, 0, 0, frame.width * size.scale, frame.height * size.scale);
    input = toBgrPlanar(ctx.getImageData(0, 0, size.w, size.h).data, size.w * size.h, input);
    const out = await session.run({ input: new ort.Tensor('float32', input, [1, 3, size.h, size.w]) });
    const boxes = nms(decode(out as never, size, THRESHOLD), 0.3);
    post({ type: 'result', id, boxes, ms: Math.round(performance.now() - t0), input: `${size.w}x${size.h}` });
  } catch (e) {
    post({ type: 'error', id, message: (e as Error).message });
  } finally {
    frame.close();
  }
}

self.onmessage = (ev: MessageEvent<DetectorRequest>) => {
  const m = ev.data;
  if (m.type === 'init') init(m.base).catch((e) => post({ type: 'error', id: null, message: (e as Error).message }));
  else if (m.type === 'detect') void detect(m.id, m.frame, m.mode);
};
