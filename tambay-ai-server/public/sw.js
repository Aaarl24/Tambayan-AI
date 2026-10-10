// Minimal PWA shell cache — the map page loads instantly and offline.
// Data is NEVER cached here: /api/* always goes to the network so stale
// seat counts are never presented as live.
// App files are network-first (fresh code wins, cache is the offline
// fallback); static vendor/fonts/tiles are cache-first.
const SHELL = 'tambay-shell-v2';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/i18n.js', '/manifest.webmanifest', '/icon.svg'];
const STATIC = ['vendor/', 'fonts/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // always live
  const isStatic = url.origin !== location.origin || STATIC.some((p) => url.pathname.includes(p));
  e.respondWith(
    isStatic
      ? caches.match(e.request).then((hit) => hit || fetchAndCache(e.request))
      : fetchAndCache(e.request).catch(() => caches.match(e.request))
  );
});
function fetchAndCache(req) {
  return fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req, copy));
    }
    return res;
  });
}
