// Small, dependency-free byte helpers. Kept explicit so anyone can audit them.

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Canonical JSON: object keys sorted, no whitespace. Every signed object in
 * VoxPop is serialized this way, so any implementation (browser, Python, ...)
 * produces byte-identical input to the signature.
 * Only JSON-safe values are allowed: strings, finite numbers, booleans, null,
 * arrays and plain objects. `undefined` fields are rejected, not skipped.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error('non-finite number in signed data');
      if (!Number.isSafeInteger(v)) throw new Error('only safe integers allowed in signed data');
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return (
        '{' +
        keys
          .map((k) => {
            if (o[k] === undefined) throw new Error(`undefined field "${k}" in signed data`);
            return JSON.stringify(k) + ':' + canonicalJson(o[k]);
          })
          .join(',') +
        '}'
      );
    }
    default:
      throw new Error(`unsupported type in signed data: ${typeof v}`);
  }
}

/** Copy into a fresh ArrayBuffer-backed array (WebCrypto rejects some views). */
export function own(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
}
