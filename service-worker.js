const CACHE_NAME = 'garden-tracker-v12';
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
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : Promise.resolve()));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const req = event.request;
    // Network-first for JSON so updates are picked up; fallback to cache
    if (req.url.endsWith('garden_master_full.json')){
      try{
        const net = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone());
        return net;
      }catch(e){
        const cached = await caches.match(req);
        return cached || new Response('Offline and no cached data.', {status: 503});
      }
    }

    const cached = await caches.match(req);
    if (cached) return cached;

    try{
      const net = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, net.clone());
      return net;
    }catch(e){
      return new Response('Offline.', {status: 503});
    }
  })());
});
