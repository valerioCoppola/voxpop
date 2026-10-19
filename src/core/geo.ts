import type { Cell } from './types';

export type LocationPrecision = 'off' | 'region' | 'city';

/**
 * Snap a position to a coarse grid cell. Exact coordinates are never stored:
 * this runs inside the geolocation callback and only the cell survives.
 */
export function toCell(lat: number, lon: number, precision: 'region' | 'city'): Cell {
  const k = precision === 'city' ? 10 : 1;
  const la = Math.floor(lat * k);
  let lo = Math.floor(lon * k);
  if (lo >= 180 * k) lo = -180 * k; // wrap the antimeridian
  return { la: Math.max(-90 * k, Math.min(90 * k - 1, la)), lo, k };
}

export function cellCenter(c: Cell): { lat: number; lon: number } {
  return { lat: (c.la + 0.5) / c.k, lon: (c.lo + 0.5) / c.k };
}

export function cellKey(c: Cell): string {
  return `${c.k}:${c.la}:${c.lo}`;
}

export function isValidCell(c: unknown): c is Cell {
  if (!c || typeof c !== 'object') return false;
  const x = c as Cell;
  return (
    (x.k === 1 || x.k === 10) &&
    Number.isSafeInteger(x.la) &&
    Number.isSafeInteger(x.lo) &&
    x.la >= -90 * x.k &&
    x.la < 90 * x.k &&
    x.lo >= -180 * x.k &&
    x.lo < 180 * x.k &&
    Object.keys(x).length === 3
  );
}

export function describeCell(c: Cell): string {
  const { lat, lon } = cellCenter(c);
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const d = c.k === 10 ? 2 : 1;
  const size = c.k === 10 ? '~11 km area' : '~110 km area';
  return `${Math.abs(lat).toFixed(d)}°${ns} ${Math.abs(lon).toFixed(d)}°${ew} (${size})`;
}

/** Ask once for a position and return only the coarse cell. */
export function locateCell(precision: LocationPrecision): Promise<Cell | null> {
  if (precision === 'off' || !('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toCell(pos.coords.latitude, pos.coords.longitude, precision)),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 10_000 },
    );
  });
}
