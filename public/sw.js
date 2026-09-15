const VERSION = "vocab-shell-v2";
const PREFIX = "vocab-shell-";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/data/v1/manifest.json", "/data/v1/index.json"];

function cacheable(request, response) {
  return response.ok && !response.redirected && !response.headers.get("cache-control")?.includes("no-store") &&
    (!response.url || new URL(response.url).origin === new URL(request.url).origin);
}

async function putSafely(cache, request, response) {
  if (cacheable(request, response)) {
    try { await cache.put(request, response.clone()); } catch { /* A full cache must not break online learning. */ }
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const manifest = await fetch("/offline-assets.json");
    const assets = manifest.ok ? await manifest.json() : [];
    if (!Array.isArray(assets) || assets.some((path) => typeof path !== "string" || !/^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(path))) throw new Error("Invalid offline asset manifest");
    await Promise.all([...SHELL, ...assets].map(async (path) => {
      const request = new Request(new URL(path, self.location.origin));
      const response = await fetch(request);
      if (!response.ok || response.redirected) throw new Error("Offline shell unavailable");
      await putSafely(cache, request, response);
    }));
    // New workers wait until existing pages close; do not replace a running session.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Never read from or write to the cache for identity, private data, or RSC payloads.
  if (url.pathname.startsWith("/api/") || /^\/(?:signin-with-chatgpt|signout-with-chatgpt|callback)(?:\/|$)/.test(url.pathname) ||
    event.request.headers.get("rsc") === "1" || url.searchParams.has("_rsc")) return;
  const navigation = event.request.mode === "navigate" && url.pathname === "/" && !url.search;
  const asset = /^\/(?:assets\/|_next\/static\/|data\/v1\/|icons\/)/.test(url.pathname) || url.pathname === "/manifest.webmanifest";
  if (!navigation && !asset) return;
  // Asset names from Vite are content hashed. Data files live in a versioned shell cache.
  const operation = (async () => {
    const cache = await caches.open(VERSION);
    const key = navigation ? new Request(new URL("/", self.location.origin)) : event.request;
    if (!navigation) {
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    try {
      const response = await fetch(event.request);
      if (navigation && !response.ok && !response.redirected) {
        const cached = await cache.match(key);
        if (cached) return cached;
      }
      await putSafely(cache, key, response);
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })();
  event.respondWith(operation);
  event.waitUntil(operation.then(() => undefined).catch(() => undefined));
});
