/**
 * Pre/post-processing for YuNet (OpenCV Zoo, 2023mar, MIT licence), a small
 * face detector built for many and small faces. Pure functions: unit-tested.
 *
 * The model takes a BGR image (0–255, no normalisation, sides multiples of 32)
 * and returns, for strides 8/16/32, per-cell class score, objectness and box offsets.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  s: number;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Detector input: the frame scaled by `scale`, padded to multiples of 32. */
export interface InputSize {
  w: number;
  h: number;
  scale: number;
}

export type ScanMode = 'thorough' | 'fast';

/**
 * How large an image the detector looks at.
 *  - thorough: the frame at native resolution (long side capped at 1280).
 *    Finds faces down to ~14 px wide, e.g. people 15–20 m away in 720p.
 *  - fast: long side 640, about 4× cheaper. Reliable only for faces above
 *    ~30 px wide, i.e. people close to the camera.
 * The model graph is size-agnostic; see tools/make_dynamic_yunet.py.
 */
export function inputSize(mode: ScanMode, W: number, H: number): InputSize {
  const long = Math.max(W, H);
  const scale = mode === 'thorough' ? Math.min(1, 1280 / long) : 640 / long;
  const up32 = (v: number) => Math.max(32, Math.ceil(v / 32) * 32);
  return { w: up32(W * scale), h: up32(H * scale), scale };
}

/** RGBA pixels → planar BGR float32 (0–255), as YuNet expects. */
export function toBgrPlanar(rgba: Uint8ClampedArray, n: number, out?: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const f = out && out.length === 3 * n ? out : new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    f[i] = rgba[j + 2];
    f[n + i] = rgba[j + 1];
    f[2 * n + i] = rgba[j];
  }
  return f;
}

type Outputs = Record<string, { data: ArrayLike<number> }>;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decode raw outputs into boxes in frame coordinates. */
export function decode(out: Outputs, size: InputSize, threshold: number): Box[] {
  const boxes: Box[] = [];
  for (const st of [8, 16, 32]) {
    const cols = size.w / st;
    const rows = size.h / st;
    const cls = out[`cls_${st}`].data;
    const obj = out[`obj_${st}`].data;
    const bb = out[`bbox_${st}`].data;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < threshold) continue;
        const cx = (c + bb[i * 4]) * st;
        const cy = (r + bb[i * 4 + 1]) * st;
        const w = Math.exp(bb[i * 4 + 2]) * st;
        const h = Math.exp(bb[i * 4 + 3]) * st;
        const k = size.scale;
        boxes.push({ x: (cx - w / 2) / k, y: (cy - h / 2) / k, w: w / k, h: h / k, s: score });
      }
    }
  }
  return boxes;
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Non-maximum suppression: keep the strongest box among overlapping ones. */
export function nms(boxes: Box[], thr = 0.3): Box[] {
  const sorted = [...boxes].sort((a, b) => b.s - a.s);
  const keep: Box[] = [];
  for (const b of sorted) if (!keep.some((k) => iou(k, b) > thr)) keep.push(b);
  return keep;
}

/**
 * Grow a face box into a mask that also covers hair, ears and chin, so a
 * slightly-off detection still hides the whole head.
 */
export function maskRect(b: Box, W: number, H: number): Region {
  const x = b.x - b.w * 0.35;
  const y = b.y - b.h * 0.5;
  const w = b.w * 1.7;
  const h = b.h * 1.8;
  const cx = Math.max(0, x);
  const cy = Math.max(0, y);
  return { x: cx, y: cy, w: Math.min(W, x + w) - cx, h: Math.min(H, y + h) - cy };
}
