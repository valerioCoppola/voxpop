import { describe, expect, it } from 'vitest';
import { areaFor, cellContaining, fixToArea, isFresh, leftCell, FIX_MAX_AGE_MS } from '../src/core/geo';

// Rome, well inside its 0.1° square (41.9–42.0 N, 12.4–12.5 E).
const ROME = { lat: 41.95, lon: 12.45 };
const NOW = 1_800_000_000_000;

describe('a location is recorded only when it is certain', () => {
  it('a precise fix in the middle of a square claims it', () => {
    const f = fixToArea(ROME.lat, ROME.lon, 20, NOW)!;
    expect(f.city).toEqual({ la: 419, lo: 124, k: 10 });
    expect(f.region).toEqual({ la: 41, lo: 12, k: 1 });
    expect(areaFor('city', f, NOW, 'ok')).toEqual({ cell: f.city, state: 'ok' });
    expect(areaFor('region', f, NOW, 'ok')).toEqual({ cell: f.region, state: 'ok' });
  });

  it('near a square edge, the small square is not claimed but the large one is', () => {
    // 41.9002 N is ~22 m from the 41.9 line; 20 m accuracy × 3 = 60 m does not fit.
    const f = fixToArea(41.9002, 12.45, 20, NOW)!;
    expect(f.city).toBeNull();
    expect(f.region).toEqual({ la: 41, lo: 12, k: 1 });
    expect(areaFor('city', f, NOW, 'ok')).toEqual({ cell: { la: 41, lo: 12, k: 1 }, state: 'coarser' });
  });

  it('an imprecise fix (cell towers, IP) never claims the small square', () => {
    // ±3 km in the middle of the 1° square: certain for ~110 km, never for ~11 km.
    const f = fixToArea(41.5, 12.5, 3_000, NOW)!;
    expect(f.city).toBeNull();
    expect(f.region).toEqual({ la: 41, lo: 12, k: 1 });
    // Rome's centre is only 5.5 km from the 42° line: a ±9 km margin can't claim even the large square.
    expect(fixToArea(ROME.lat, ROME.lon, 3_000, NOW)!.region).toBeNull();
  });

  it('a very imprecise fix claims nothing at all', () => {
    const f = fixToArea(ROME.lat, ROME.lon, 30_000, NOW)!; // ±30 km
    expect(f.city).toBeNull();
    expect(f.region).toBeNull();
    expect(areaFor('region', f, NOW, 'ok')).toEqual({ cell: null, state: 'uncertain' });
  });

  it('on a 1° line nothing can be claimed', () => {
    const f = fixToArea(42.0, 12.45, 5, NOW)!;
    expect(f.city).toBeNull();
    expect(f.region).toBeNull();
  });

  it('longitude squares narrow away from the equator, and the check accounts for it', () => {
    // At 60° N, 0.01° of longitude is ~556 m (at the equator it would be ~1.1 km).
    expect(cellContaining(60.05, 10.01, 600, 10)).toBeNull();
    expect(cellContaining(60.05, 10.01, 500, 10)).not.toBeNull();
    expect(cellContaining(0.05, 10.01, 1_000, 10)).not.toBeNull();
  });

  it('rejects unusable fixes', () => {
    expect(fixToArea(NaN, 12, 10, NOW)).toBeNull();
    expect(fixToArea(41, 12, 0, NOW)).toBeNull(); // zero accuracy is not a real measurement
    expect(fixToArea(41, 12, null, NOW)).toBeNull();
    expect(fixToArea(91, 12, 10, NOW)).toBeNull();
    expect(fixToArea(41, 12, Infinity, NOW)).toBeNull();
  });

  it('handles the antimeridian and the poles', () => {
    expect(fixToArea(10.5, -179.5, 10, NOW)!.region).toEqual({ la: 10, lo: -180, k: 1 });
    expect(fixToArea(10.5, 179.5, 10, NOW)!.region).toEqual({ la: 10, lo: 179, k: 1 });
    expect(fixToArea(10.5, 180, 10, NOW)!.region).toBeNull(); // exactly on the line between two squares
    expect(fixToArea(89.95, 0.5, 10, NOW)!.region).toBeNull();
  });
});

describe('a location must be fresh', () => {
  it('an old fix gives no location', () => {
    const f = fixToArea(ROME.lat, ROME.lon, 20, NOW - FIX_MAX_AGE_MS - 1)!;
    expect(isFresh(f, NOW)).toBe(false);
    expect(areaFor('city', f, NOW, 'ok')).toEqual({ cell: null, state: 'locating' });
  });

  it('a fix stamped far in the future gives no location', () => {
    const f = fixToArea(ROME.lat, ROME.lon, 20, NOW + 5 * 60_000)!;
    expect(isFresh(f, NOW)).toBe(false);
  });

  it('off means off, whatever fix exists', () => {
    const f = fixToArea(ROME.lat, ROME.lon, 20, NOW)!;
    expect(areaFor('off', f, NOW, 'ok')).toEqual({ cell: null, state: 'off' });
  });

  it('a blocked or missing position says so', () => {
    expect(areaFor('city', null, NOW, 'denied').state).toBe('denied');
    expect(areaFor('city', null, NOW, 'unavailable').state).toBe('unavailable');
  });
});

describe('moving during a recording', () => {
  it('is reported only when a certain fix puts the phone in another square', () => {
    const start = { la: 419, lo: 124, k: 10 as const };
    expect(leftCell(start, fixToArea(ROME.lat, ROME.lon, 20, NOW), NOW)).toBe(false);
    expect(leftCell(start, fixToArea(41.85, 12.45, 20, NOW), NOW)).toBe(true);
    // Uncertain fix near the edge: not claimed either way.
    expect(leftCell(start, fixToArea(41.9001, 12.45, 50, NOW), NOW)).toBe(false);
  });
});
