// Tiny DOM helpers. Text is always set with textContent, never innerHTML:
// data from received files is untrusted and must never be parsed as markup.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, ...children);
  return el;
}

export function append(el: Node, ...children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// Stroke icons, 24×24, drawn from fixed path data.
const ICONS: Record<string, string[]> = {
  face: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M3.5 9h17', 'M3.5 15h17'],
  voice: ['M12 3v18', 'M8 7v10', 'M16 7v10', 'M4 10v4', 'M20 10v4'],
  pin: ['M12 21s-6-5.3-6-11a6 6 0 1 1 12 0c0 5.7-6 11-6 11Z', 'M12 8v4'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
  flip: ['M4 12a8 8 0 0 1 13.7-5.6L20 9', 'M20 4v5h-5', 'M20 12a8 8 0 0 1-13.7 5.6L4 15', 'M4 20v-5h5'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  unlock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  warn: ['M12 4 2.5 20h19L12 4Z', 'M12 10v4', 'M12 17v.5'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5', 'M12 8v.5'],
  witness: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z'],
  ledger: ['M4 5h16', 'M4 10h16', 'M4 15h10', 'M4 20h7'],
  verify: ['M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z', 'M8.5 12l2.5 2.5 4.5-5'],
  safety: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  agora: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.4a6.5 6.5 0 0 1 3.5 5.6'],
  share: ['M12 15V4', 'M8 8l4-4 4 4', 'M5 13v7h14v-7'],
  trash: ['M5 7h14', 'M9 7V4h6v3', 'M7 7l1 13h8l1-13'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
};

export function icon(name: keyof typeof ICONS | string, cls = 'icon'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A button that only fires after being held down — for destructive actions. */
export function holdButton(label: string, ms: number, onConfirm: () => void, cls = 'btn danger hold'): HTMLButtonElement {
  const fill = h('span', { class: 'hold-fill' });
  const text = h('span', { class: 'hold-label' }, label);
  const btn = h('button', { class: cls, type: 'button' }, fill, text);
  let timer: number | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    btn.classList.remove('holding');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.style.setProperty('--hold-ms', `${ms}ms`);
    btn.classList.add('holding');
    timer = window.setTimeout(() => {
      cancel();
      onConfirm();
    }, ms);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, cancel);
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !timer) {
      e.preventDefault();
      btn.dispatchEvent(new PointerEvent('pointerdown'));
    }
  });
  btn.addEventListener('keyup', cancel);
  return btn;
}

export function download(bytes: Uint8Array, name: string, type = 'application/zip') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function shareOrDownload(bytes: Uint8Array, name: string): Promise<'shared' | 'downloaded'> {
  const file = new File([bytes as BlobPart], name, { type: 'application/zip' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'VoxPop witness recording' });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'shared';
    }
  }
  download(bytes, name);
  return 'downloaded';
}

let toastTimer: number | null = null;
export function toast(msg: string) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3200);
}
