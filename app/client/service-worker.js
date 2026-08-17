/* eslint-env serviceworker */
/* ==========================================================================
   GCloud service worker — template.

   This file is never shipped as-is. The `pwa` plugin in vite.config.ts reads it at build
   time, substitutes the two placeholders declared below with the real build revision and
   the real asset list, and emits the result as dist/sw.js. It is plain JS on purpose: it
   runs in a worker scope with no bundler around it.

   WHAT IS CACHED, AND WHAT IS DELIBERATELY NOT
   ---------------------------------------------------------------------------
   Cached  · the app shell — index.html, the hashed JS/CSS bundle, icons, the manifest.
             Named by content hash, so a cache hit is always the right bytes.
           · the webfont — Poppins, from fonts.googleapis.com and fonts.gstatic.com.
             Cross-origin and opaque, which is fine: it is a font, and without it an
             offline launch falls back to system-ui and looks like a different product.

   NOT     · anything under /api. Every one of those responses is somebody's private
             library, behind a session, on a device that may be shared or lost. A disk
             cache of them survives sign-out, which is not a trade this product makes.
             It also cannot work: /api/files streams ranges for a <video> scrub, and a
             cache that answered a Range request with a 200 of the whole file would break
             seeking outright.
           · anything that is not a GET. Uploads PUT their bytes straight to a Google
             Drive session URI, and a service worker has no business in that path.
   ========================================================================== */

const BUILD = '__BUILD__';
const SHELL = `gcloud-shell-${BUILD}`;
const FONTS = 'gcloud-fonts-v1';
const PRECACHE = __PRECACHE__;

// The document every navigation resolves to. The app routes on the hash, so there is
// exactly one of these and no server round trip is needed to pick it.
const SHELL_DOC = '/index.html';

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // addAll is atomic — one 404 and nothing is cached, which is the behaviour we want:
      // a half-populated shell fails later, in the dark, on a plane.
      await cache.addAll(PRECACHE);
      // No skipWaiting here. A new worker sits in `waiting` until the page asks it to take
      // over, so an upload in flight is never swapped out from under itself.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Every previous build's shell, dropped in one pass. The font cache is versioned
      // separately and survives — the typeface does not change when the app does.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('gcloud-') && n !== SHELL && n !== FONTS)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// The page sends this after the reader accepts the update prompt — the only thing that
// moves a waiting worker into control.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Opaque responses (the cross-origin font files) report status 0 and cannot be
  // inspected; they are still worth keeping, and are the one exception to the ok check.
  if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // The control plane and the byte path, untouched. See the header of this file.
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/healthz')) return;

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, FONTS).catch(() => fetch(request)));
    return;
  }

  // Anything else cross-origin — a Drive resumable session, a thumbnail — is the network's
  // business, not ours.
  if (url.origin !== self.location.origin) return;

  // Every navigation is the same document, and it is already in the cache. Falling back to
  // the network covers the first load after a cache eviction.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        return (await cache.match(SHELL_DOC)) || fetch(request);
      })(),
    );
    return;
  }

  // Hashed bundle assets, icons, the manifest. Names change when contents change, so a hit
  // is never stale; a miss falls through to the network and is kept.
  event.respondWith(
    cacheFirst(request, SHELL).catch(
      () => new Response('', { status: 504, statusText: 'Offline and not cached' }),
    ),
  );
});
