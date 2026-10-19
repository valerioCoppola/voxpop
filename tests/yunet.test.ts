import { describe, expect, it } from 'vitest';
import { decode, inputSize, maskRect, nms, toBgrPlanar, type InputSize } from '../src/media/yunet';

const SIZE: InputSize = { w: 640, h: 384, scale: 0.5 }; // a 1280×720 frame, fast scan

function emptyOutputs(size: InputSize = SIZE) {
  const o: Record<string, { data: Float32Array }> = {};
  for (const st of [8, 16, 32]) {
    const n = (size.w / st) * (size.h / st);
    o[`cls_${st}`] = { data: new Float32Array(n) };
    o[`obj_${st}`] = { data: new Float32Array(n) };
    o[`bbox_${st}`] = { data: new Float32Array(n * 4) };
    o[`kps_${st}`] = { data: new Float32Array(n * 10) };
  }
  return o;
}

describe('yunet decoding', () => {
  it('decodes one anchor into frame coordinates, undoing the letterbox scale', () => {
    const o = emptyOutputs();
    // stride 32, row 5, col 10 → centre (10.5*32, 5.5*32) in model space with offsets 0.5
    const cols = SIZE.w / 32;
    const i = 5 * cols + 10;
    o.cls_32.data[i] = 0.9;
    o.obj_32.data[i] = 0.9;
    o.bbox_32.data.set([0.5, 0.5, Math.log(2), Math.log(2)], i * 4); // w = h = 64
    const [b] = decode(o, SIZE, 0.5);
    expect(b.s).toBeCloseTo(0.9);
    expect(b.w).toBeCloseTo(128);
    expect(b.x).toBeCloseTo((10.5 * 32 - 32) * 2);
    expect(b.y).toBeCloseTo((5.5 * 32 - 32) * 2);
  });

  it('ignores weak scores', () => {
    const o = emptyOutputs();
    o.cls_8.data[0] = 0.2;
    o.obj_8.data[0] = 0.2;
    expect(decode(o, SIZE, 0.5)).toEqual([]);
  });

  it('suppresses overlapping duplicates', () => {
    const k = nms([
      { x: 0, y: 0, w: 10, h: 10, s: 0.9 },
      { x: 1, y: 1, w: 10, h: 10, s: 0.8 },
      { x: 50, y: 50, w: 10, h: 10, s: 0.7 },
    ]);
    expect(k.map((b) => b.s)).toEqual([0.9, 0.7]);
  });

  it('thorough scan uses native resolution, fast scan half; sides are multiples of 32', () => {
    expect(inputSize('thorough', 1280, 720)).toEqual({ w: 1280, h: 736, scale: 1 });
    expect(inputSize('fast', 1280, 720)).toEqual({ w: 640, h: 384, scale: 0.5 });
    expect(inputSize('thorough', 1920, 1080)).toEqual({ w: 1280, h: 736, scale: 1280 / 1920 });
    expect(inputSize('thorough', 720, 1280)).toEqual({ w: 736, h: 1280, scale: 1 }); // portrait phone
  });

  it('mask is larger than the face and stays inside the frame', () => {
    const m = maskRect({ x: 5, y: 5, w: 40, h: 50, s: 1 }, 100, 100);
    expect(m.x).toBe(0);
    expect(m.y).toBe(0);
    expect(m.w).toBeGreaterThan(40);
    expect(m.x + m.w).toBeLessThanOrEqual(100);
  });

  it('converts RGBA to planar BGR', () => {
    const n = 64 * 32;
    const px = new Uint8ClampedArray(n * 4);
    px.set([10, 20, 30, 255], 0);
    const f = toBgrPlanar(px, n);
    expect([f[0], f[n], f[2 * n]]).toEqual([30, 20, 10]);
  });
});
