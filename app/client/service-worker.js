const BUILD = '__BUILD__';
const SHELL = `gcloud-shell-${BUILD}`;
const FONTS = 'gcloud-fonts-v2';
const PRECACHE = __PRECACHE__;

const SHELL_DOC = '/index.html';
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(PRECACHE);

    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
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
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);

  if (response.ok) await cache.put(request, response.clone());
  return response;
}
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/healthz')) return;

  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(request, FONTS).catch(() => fetch(request)));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        return (await cache.match(SHELL_DOC)) || fetch(request);
      })(),
    );
    return;
  }

  event.respondWith(
    cacheFirst(request, SHELL).catch(
      () => new Response('', { status: 504, statusText: 'Offline and not cached' }),
    ),
  );
});