// Garden Tracker PWA Service Worker
// Robust install: caches core assets individually so one missing file does not break the whole app.
// IMPORTANT: Update CACHE_NAME when changing the app shell to force clients to refresh.

const CACHE_NAME = 'garden-tracker-v11';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './garden_master_full.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    const results = await Promise.allSettled(
      ASSETS.map(async (url) => {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (!res.ok) throw new Error(`${url} -> ${res.status}`);
        await cache.put(req, res);
      })
    );

    const okCount = results.filter(r => r.status === 'fulfilled').length;
    if (okCount === 0) {
      throw new Error('Service worker install failed: none of the core assets could be cached.');
    }

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const req = event.request;
    if (req.method !== 'GET') return fetch(req);

    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const net = await fetch(req);
      const url = new URL(req.url);
      if (url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
      }
      return net;
    } catch (e) {
      return new Response('Offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
