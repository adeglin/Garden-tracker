// Garden Tracker PWA Service Worker
// Notes:
// - Pre-caches only the critical app shell + the active data JSON
// - Avoids failing the entire install if any single asset is temporarily unavailable
// - Uses a cache version bump so updates take effect cleanly

const CACHE_NAME = 'garden-tracker-v2';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './garden_master_full_v5.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Cache assets individually so a single missing file doesn't break install.
    const results = await Promise.allSettled(
      ASSETS.map(async (url) => {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (!res.ok) throw new Error(`${url} -> ${res.status}`);
        await cache.put(req, res);
      })
    );

    // If everything failed, fail install (this would indicate a real hosting issue).
    const okCount = results.filter(r => r.status === 'fulfilled').length;
    if (okCount === 0) {
      throw new Error('Service worker install failed: none of the core assets could be cached.');
    }

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove old caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const req = event.request;

    // Only handle GET
    if (req.method !== 'GET') return fetch(req);

    // Prefer cache for app shell + static assets
    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const net = await fetch(req);
      // Runtime cache for same-origin static assets (optional but helpful)
      const url = new URL(req.url);
      if (url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
      }
      return net;
    } catch (e) {
      // Offline fallback
      return new Response('Offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
