// VoxPop service worker: keeps a complete offline copy of the app.
// It never talks to any server except the one the app was installed from,
// and it never sees recordings (those live in IndexedDB, encrypted).

const PREFIX = 'voxpop-';

// Same-origin isolation, added to every response we serve. Lets the face
// detector use several CPU threads even on hosts that can't set headers.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function withIsolation(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('./precache.json', { cache: 'no-store' });
      const { version, files } = await res.json();
      const cache = await caches.open(PREFIX + version);
      await cache.addAll(files.map((f) => new Request(f, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      let current;
      try {
        current = PREFIX + (await fetch('./precache.json', { cache: 'no-store' }).then((r) => r.json())).version;
      } catch {
        return self.clients.claim(); // offline: keep every cached copy
      }
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== current) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // drand etc. go straight to the network
  event.respondWith(
    (async () => {
      if (req.mode === 'navigate') {
        const cached = await caches.match('./', { ignoreSearch: true });
        if (cached) return withIsolation(cached);
      }
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return withIsolation(cached);
      try {
        return withIsolation(await fetch(req));
      } catch {
        return new Response('Offline and not cached', { status: 503 });
      }
    })(),
  );
});
