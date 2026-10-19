import type { Cell } from './types';

export type LocationPrecision = 'off' | 'region' | 'city';

/**
 * Coarse location that is either true or absent.
 *
 * A recording carries an area only when the device's own position fix
 *  - is fresh (taken within the last minute), and
 *  - places the device inside that area with margin to spare: the whole circle of
 *    FIX_MARGIN × the reported accuracy must fit in the grid square.
 * If the ~11 km square can't be claimed with that certainty, the ~110 km square
 * is used; if neither can, no location is recorded. There is no manual entry and
 * no "last known" fallback. Exact coordinates are never stored: they exist only
 * inside the browser's location callback, where they are turned into cells.
 *
 * What this cannot do: prove to others that the device's location service was not
 * faked. The area is what the recording phone measured, nothing more.
 */

export const FIX_MAX_AGE_MS = 60_000;
export const FIX_MARGIN = 3; // browsers report ~68% accuracy radii; 3× makes a miss very unlikely

// Conservative metres per degree: the smallest real values, so distances to a
// cell edge are never overestimated.
const M_PER_DEG_LAT = 110_574; // at the equator (it grows towards the poles)
const M_PER_DEG_LON_EQ = 111_320; // × cos(latitude); the ellipsoid makes the true value a bit larger

/**
 * Snap a position to a coarse grid cell.
 */
export function toCell(lat: number, lon: number, precision: 'region' | 'city'): Cell {
  const k = precision === 'city' ? 10 : 1;
  const la = Math.floor(lat * k);
  let lo = Math.floor(normLon(lon) * k);
  if (lo >= 180 * k) lo = -180 * k; // wrap the antimeridian
  return { la: Math.max(-90 * k, Math.min(90 * k - 1, la)), lo, k };
}

function normLon(lon: number): number {
  return lon >= 180 ? lon - 360 : lon;
}

/** The cell at precision k whose square contains the whole circle, or null. */
export function cellContaining(lat: number, lon: number, radiusM: number, k: 1 | 10): Cell | null {
  lon = normLon(lon);
  const c = toCell(lat, lon, k === 10 ? 'city' : 'region');
  const rLatDeg = radiusM / M_PER_DEG_LAT;
  const poleward = Math.abs(lat) + rLatDeg;
  if (poleward >= 89.9) return null; // grid squares collapse near the poles
  const mPerDegLon = M_PER_DEG_LON_EQ * Math.cos((poleward * Math.PI) / 180);
  const south = (lat - c.la / k) * M_PER_DEG_LAT;
  const north = ((c.la + 1) / k - lat) * M_PER_DEG_LAT;
  const west = (lon - c.lo / k) * mPerDegLon;
  const east = ((c.lo + 1) / k - lon) * mPerDegLon;
  return Math.min(south, north, west, east) >= radiusM ? c : null;
}

export interface AreaFix {
  city: Cell | null; // set only when the fix is certain at ~11 km
  region: Cell | null; // set only when the fix is certain at ~110 km
  at: number; // when the device took the fix (unix ms)
}

/** Turns one position fix into the cells it truthfully supports. Returns null for an unusable fix. */
export function fixToArea(lat: number, lon: number, accuracyM: number | null, at: number): AreaFix | null {
  if (![lat, lon, at].every(Number.isFinite) || accuracyM === null || !Number.isFinite(accuracyM)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || accuracyM <= 0) return null;
  const r = accuracyM * FIX_MARGIN;
  return { city: cellContaining(lat, lon, r, 10), region: cellContaining(lat, lon, r, 1), at };
}

export function isFresh(fix: AreaFix | null, now: number): fix is AreaFix {
  return !!fix && now - fix.at <= FIX_MAX_AGE_MS && fix.at - now <= FIX_MAX_AGE_MS;
}

export type AreaState = 'off' | 'locating' | 'ok' | 'coarser' | 'uncertain' | 'denied' | 'unavailable';

/** The area a recording started now may carry, and why. */
export function areaFor(precision: LocationPrecision, fix: AreaFix | null, now: number, watcher: WatchState): { cell: Cell | null; state: AreaState } {
  if (precision === 'off') return { cell: null, state: 'off' };
  if (!isFresh(fix, now)) return { cell: null, state: watcher === 'denied' ? 'denied' : watcher === 'unavailable' ? 'unavailable' : 'locating' };
  if (precision === 'city' && fix.city) return { cell: fix.city, state: 'ok' };
  if (fix.region) return { cell: fix.region, state: precision === 'city' ? 'coarser' : 'ok' };
  return { cell: null, state: 'uncertain' };
}

/**
 * True only when a fresh fix places the device, with the same certainty, in a
 * different cell than the one a recording started in.
 */
export function leftCell(start: Cell, fix: AreaFix | null, now: number): boolean {
  if (!isFresh(fix, now)) return false;
  const here = start.k === 10 ? fix.city : fix.region;
  return !!here && cellKey(here) !== cellKey(start);
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

export type WatchState = 'off' | 'locating' | 'ok' | 'denied' | 'unavailable';

/**
 * Keeps a fresh coarse fix while the camera is on, so a recording can start
 * instantly with a true area (or none). Only cells are kept, never coordinates.
 */
export class AreaWatcher {
  fix: AreaFix | null = null;
  state: WatchState = 'off';
  onChange: () => void = () => {};
  private id: number | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private high = false;

  start(highAccuracy: boolean) {
    if (this.id !== null && this.high === highAccuracy) return;
    this.stop();
    this.high = highAccuracy;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      this.state = 'unavailable';
      return this.onChange();
    }
    this.state = 'locating';
    const ok = (pos: GeolocationPosition) => {
      const f = fixToArea(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.timestamp);
      if (f && (!this.fix || f.at >= this.fix.at)) {
        this.fix = f;
        this.state = 'ok';
      }
      this.onChange();
    };
    const fail = (err: GeolocationPositionError) => {
      this.state = err.code === err.PERMISSION_DENIED ? 'denied' : this.fix ? this.state : 'unavailable';
      this.onChange();
    };
    const opts = { enableHighAccuracy: highAccuracy, maximumAge: 20_000, timeout: 30_000 };
    this.id = navigator.geolocation.watchPosition(ok, fail, opts);
    // A phone that isn't moving may stay silent: ask again so the fix stays fresh,
    // and re-check freshness so an old fix is never presented as current.
    this.poll = setInterval(() => {
      navigator.geolocation.getCurrentPosition(ok, () => this.onChange(), opts);
    }, 25_000);
    this.onChange();
  }

  stop() {
    if (this.id !== null) navigator.geolocation.clearWatch(this.id);
    if (this.poll) clearInterval(this.poll);
    this.id = null;
    this.poll = null;
    this.fix = null;
    this.state = 'off';
  }
}
