import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import { h } from './dom';
import { cellCenter, cellKey, describeCell } from '../core/geo';
import type { Cell } from '../core/types';

/**
 * Offline world map for the ledger (equirectangular, no tiles, no network).
 * One series: number of recordings per coarse area, shown as dot size.
 */

export interface MapPoint {
  cell: Cell;
  count: number;
}

type Ring = [number, number][];
let landPromise: Promise<Ring[][]> | null = null;

function loadLand(): Promise<Ring[][]> {
  landPromise ??= fetch(new URL('vendor/geo/land-110m.json', location.href))
    .then((r) => r.json())
    .then((topo: Topology) => {
      const fc = feature(topo, topo.objects.land as GeometryCollection) as unknown as {
        features: { geometry: { type: string; coordinates: unknown } }[];
      };
      const polys: Ring[][] = [];
      for (const f of fc.features) {
        const g = f.geometry;
        if (g.type === 'Polygon') polys.push(g.coordinates as Ring[]);
        else if (g.type === 'MultiPolygon') polys.push(...(g.coordinates as Ring[][]));
      }
      return polys;
    });
  return landPromise;
}

const LAT_TOP = 84;
const LAT_BOTTOM = -58;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function worldMap(points: MapPoint[], onPick: (c: Cell | null) => void): HTMLElement {
  const canvas = h('canvas', { class: 'map-canvas', role: 'img', 'aria-label': `World map with ${points.length} recording areas` });
  const tip = h('div', { class: 'map-tip', hidden: true });
  const wrap = h('div', { class: 'map-wrap' }, canvas, tip);
  let hits: { x: number; y: number; r: number; p: MapPoint }[] = [];

  const draw = async () => {
    const land = await loadLand();
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth || 600;
    const H = Math.round(W * ((LAT_TOP - LAT_BOTTOM) / 360));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = `${H}px`;
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = (lon: number) => ((lon + 180) / 360) * W;
    const py = (lat: number) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * H;
    g.clearRect(0, 0, W, H);
    g.fillStyle = cssVar('--map-land');
    // Rings that cross the antimeridian jump from +180 to -180. Unwrap them into
    // continuous longitudes, then draw the world three times side by side; the
    // canvas edge clips the copies, so every landmass fills correctly.
    g.beginPath();
    for (const shift of [-360, 0, 360]) {
      for (const poly of land) {
        for (const ring of poly) {
          let prev = ring[0][0];
          let off = 0;
          ring.forEach(([lon, lat], i) => {
            if (i) {
              const d = lon + off - prev;
              if (d > 180) off -= 360;
              else if (d < -180) off += 360;
            }
            const L = lon + off;
            prev = L;
            const x = px(L + shift);
            const y = py(lat);
            if (i) g.lineTo(x, y);
            else g.moveTo(x, y);
          });
          g.closePath();
        }
      }
    }
    g.fill('evenodd');

    const max = Math.max(1, ...points.map((p) => p.count));
    const surface = cssVar('--surface');
    const dot = cssVar('--verdigris');
    hits = points
      .map((p) => {
        const c = cellCenter(p.cell);
        return { x: px(c.lon), y: py(c.lat), r: 4 + 10 * Math.sqrt(p.count / max), p };
      })
      .sort((a, b) => b.r - a.r);
    for (const d of hits) {
      g.beginPath();
      g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      g.fillStyle = dot;
      g.globalAlpha = 0.85;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 2;
      g.strokeStyle = surface;
      g.stroke();
    }
  };

  const hitAt = (ev: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    return [...hits].reverse().find((d) => Math.hypot(d.x - x, d.y - y) <= d.r + 6) ?? null;
  };

  canvas.addEventListener('pointermove', (ev) => {
    const d = hitAt(ev);
    if (!d) {
      tip.hidden = true;
      canvas.style.cursor = '';
      return;
    }
    canvas.style.cursor = 'pointer';
    tip.hidden = false;
    tip.textContent = `${d.p.count} recording${d.p.count === 1 ? '' : 's'}, ${describeCell(d.p.cell)}`;
    tip.style.left = `${d.x}px`;
    tip.style.top = `${d.y - d.r - 8}px`;
  });
  canvas.addEventListener('pointerleave', () => (tip.hidden = true));
  canvas.addEventListener('click', (ev) => {
    const d = hitAt(ev);
    onPick(d ? d.p.cell : null);
  });

  const ro = new ResizeObserver(() => void draw());
  ro.observe(wrap);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => void draw());
  return wrap;
}

export function aggregateCells(cells: (Cell | null)[]): MapPoint[] {
  const m = new Map<string, MapPoint>();
  for (const c of cells) {
    if (!c) continue;
    const k = cellKey(c);
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { cell: c, count: 1 });
  }
  return [...m.values()];
}
