// Garden Tracker Service Worker (robust)
// - Does NOT use cache.addAll (which fails if any one asset 404s)
// - Caches core assets individually
// - Bumps cache name to force updates

const CACHE_NAME = "garden-tracker-v13";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./garden_master_full.json"
  // Add icons here ONLY if they exist at these paths
  // "./icons/icon-192.png",
  // "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    const results = await Promise.allSettled(
      CORE_ASSETS.map(async (url) => {
        const req = new Request(url, { cache: "reload" });
        const res = await fetch(req);
        if (!res.ok) throw new Error(`${url} -> ${res.status}`);
        await cache.put(req, res);
      })
    );

    // If absolutely nothing cached, fail install (indicates real hosting issue)
    const okCount = results.filter(r => r.status === "fulfilled").length;
    if (okCount === 0) throw new Error("SW install failed: no core assets cached.");

    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    const req = event.request;
    if (req.method !== "GET") return fetch(req);

    const cached = await caches.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      const url = new URL(req.url);
      if (url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return new Response("Offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
  })());
});
