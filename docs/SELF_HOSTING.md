# Hosting your own copy

VoxPop is a static site: no server code and no database. Anyone can host a copy, and the more copies exist, the harder it is to block.

```bash
npm install
npm run build        # output in dist/
```

Upload `dist/` to any static HTTPS host. The app uses relative paths, so it works at a domain root or in a subfolder.

## Headers

Set these response headers for every file. `dist/_headers` already contains them for hosts that read that file (Netlify, Cloudflare Pages):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss: https://api.drand.sh https://drand.cloudflare.com; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Serve `.wasm` as `application/wasm` and `.webmanifest` as `application/manifest+json`.

If your host can't set headers (GitHub Pages, for example), the app still works: the page carries its CSP in a meta tag, and the service worker adds the isolation headers from the second visit on. Until then the face detector runs on a single CPU thread.

## nginx example

```nginx
location / {
  root /srv/voxpop;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss: https://api.drand.sh https://drand.cloudflare.com; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy require-corp always;
  add_header Cross-Origin-Resource-Policy same-origin always;
  add_header Referrer-Policy no-referrer always;
  add_header X-Content-Type-Options nosniff always;
}
```

## Checking a hosted copy

Anyone can rebuild from source and compare: `npm ci && npm run build`, then compare `dist/precache.json` (its `version` is a hash over every built file) with the one served by a host.
