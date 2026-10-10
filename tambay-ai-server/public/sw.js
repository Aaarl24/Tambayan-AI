// Minimal PWA shell cache — the map page loads instantly and offline.
// Data is NEVER cached here: /api/* always goes to the network so stale
// seat counts are never presented as live.
const SHELL = 'tambay-shell-v1';
const ASSETS = [
  '/', '/index.html', '/style.css', '/app.js', '/i18n.js',
  '/vendor/leaflet.js', '/vendor/leaflet.css',
  '/manifest.webmanifest', '/icon.svg',
];

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
  if (url.pathname.startsWith('/api/')) return; // always live
  if (e.request.method !== 'GET') return;
  // map tiles: cache-first is fine (they are static images)
  e.respondWith(
    caches.match(e.request).then(
      (hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
