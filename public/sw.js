const VERSION = "vocab-shell-v1.4.1";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/data/v1/manifest.json",
  "/data/v1/index.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

function canonicalSameOriginGet(url) {
  return new Request(new URL(url.pathname, self.location.origin).toString(), { method: "GET" });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/data/v1/index.json" || url.pathname === "/data/v1/manifest.json") {
    event.respondWith(caches.open(VERSION).then(async (cache) => {
      const cacheKey = canonicalSameOriginGet(url);
      const cached = await cache.match(cacheKey);
      const refresh = fetch(cacheKey).then((response) => {
        if (response.ok) cache.put(cacheKey, response.clone());
        return response;
      });
      return cached || refresh;
    }));
    return;
  }
  if (url.pathname.startsWith("/data/v1/chunks/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(caches.open(VERSION).then(async (cache) => {
      const cacheKey = canonicalSameOriginGet(url);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const response = await fetch(cacheKey);
      if (response.ok) cache.put(cacheKey, response.clone());
      return response;
    }));
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put("/", copy));
      return response;
    }).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && url.pathname.startsWith("/_next/")) caches.open(VERSION).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
