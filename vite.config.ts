import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Content Security Policy for the built app.
 * - Code, styles, models and workers only from our own origin.
 * - 'wasm-unsafe-eval' lets the face detector compile WebAssembly (no JS eval).
 * - Outside connections: public Nostr relays over secure WebSockets (only when the
 *   user joins a room) and the two drand mirrors (only with "public time proof" on).
 */
function testRelays(): string {
  // Local test relay (ws://localhost) for the two-user browser tests only.
  const list = (process.env.VITE_VOXPOP_RELAYS ?? '').split(',').filter((u) => u.startsWith('ws://localhost') || u.startsWith('ws://127.0.0.1'));
  return list.length ? ' ' + list.join(' ') : '';
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  // wss: lets people meet through public Nostr relays (Agora). Any relay, so users in
  // censored countries can switch to relays that still work for them.
  `connect-src 'self' wss: https://api.drand.sh https://drand.cloudflare.com${testRelays()}`,
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Same-origin isolation: lets the detector use several CPU threads. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), interest-cohort=()',
};

function cspPlugin(): Plugin {
  return {
    name: 'voxpop-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      );
    },
  };
}

/** Writes precache.json: every built file, so the app works fully offline after install. */
function precachePlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'voxpop-precache',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    writeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split('\\').join('/'));
        }
      };
      walk(outDir);
      const list = files
        .filter((f) => !['precache.json', 'sw.js', '_headers'].includes(f) && !f.endsWith('.map'))
        .sort();
      const h = createHash('sha256');
      for (const f of list) h.update(f).update(readFileSync(join(outDir, f)));
      const version = h.digest('hex').slice(0, 16);
      writeFileSync(join(outDir, 'precache.json'), JSON.stringify({ version, files: ['./', ...list] }, null, 1));
    },
  };
}

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // ONNX Runtime build that loads its WebAssembly from our own /vendor folder.
      'ort-extern': resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'),
    },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  server: { headers: ISOLATION_HEADERS },
  preview: { headers: ISOLATION_HEADERS },
  plugins: [cspPlugin(), precachePlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
