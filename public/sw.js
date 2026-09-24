const VERSION = "vocab-shell-v2";
const PREFIX = "vocab-shell-";
const SHELL = ["/", "/manifest.webmanifest", "/icons/app-192.png", "/icons/app-512.png", "/data/v1/manifest.json", "/data/v1/index.json"];

function cacheable(request, response) {
  return response.ok && !response.redirected && !/\bno-store\b/i.test(response.headers.get("cache-control") || "") &&
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
    const manifest = await fetch("/offline-assets.json", { cache: "no-store" });
    if (!manifest.ok || manifest.redirected) throw new Error("Offline asset manifest unavailable");
    const assets = await manifest.json();
    if (!Array.isArray(assets) || !assets.length || assets.some((path) => typeof path !== "string" || !/^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|woff2?)$/.test(path))) throw new Error("Invalid offline asset manifest");
    const results = await Promise.allSettled([...new Set([...SHELL, ...assets])].map(async (path) => {
      const request = new Request(new URL(path, self.location.origin), { cache: "reload" });
      const response = await fetch(request);
      // A worker without the executable shell must never replace the working one.
      if (!cacheable(request, response)) throw new Error("Offline shell unavailable");
      await cache.put(request, response);
    }));
    if (results.some((result) => result.status === "rejected")) {
      await caches.delete(VERSION);
      throw new Error("Offline shell could not be saved completely");
    }
    // New workers wait until existing pages close; do not replace a running session.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

// Explicit downloads use this worker's release cache. A successful in-memory
// fetch alone does not prove that the browser retained an offline copy.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "PREPARE_LEXICON" || !event.ports?.[0]) return;
  const port = event.ports[0];
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(VERSION);
      const manifest = await cache.match(new Request(new URL("/data/v1/manifest.json", self.location.origin)));
      if (!manifest) throw new Error("Missing lexicon manifest");
      const { chunks } = await manifest.json();
      if (!Array.isArray(chunks) || !chunks.length || chunks.length > 500 || chunks.some((chunk) => !/^chunks\/[a-zA-Z0-9_-]+\.json$/.test(chunk.file))) throw new Error("Invalid lexicon manifest");
      for (let start = 0; start < chunks.length; start += 4) {
        await Promise.all(chunks.slice(start, start + 4).map(async (chunk) => {
          const request = new Request(new URL(`/data/v1/${chunk.file}`, self.location.origin));
          if (await cache.match(request)) return;
          const response = await fetch(request, { signal: AbortSignal.timeout(20_000) });
          if (!cacheable(request, response)) throw new Error("Unavailable lexicon chunk");
          await cache.put(request, response);
        }));
      }
      for (const chunk of chunks) {
        if (!await cache.match(new Request(new URL(`/data/v1/${chunk.file}`, self.location.origin)))) throw new Error("Incomplete lexicon cache");
      }
      port.postMessage({ ok: true, files: chunks.length });
    } catch { port.postMessage({ ok: false }); }
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Never read from or write to the cache for identity, private data, or RSC payloads.
  if (url.pathname.startsWith("/api/") || /^\/(?:signin-with-chatgpt|signout-with-chatgpt|callback)(?:\/|$)/.test(url.pathname) ||
    event.request.headers.get("rsc") === "1" || url.searchParams.has("_rsc")) return;
  const navigation = event.request.mode === "navigate" && url.pathname === "/" && !url.search;
  const asset = /^\/(?:assets\/|_next\/static\/|data\/v1\/|readings\/v1\/|vendor\/|icons\/|images\/)/.test(url.pathname) || url.pathname === "/manifest.webmanifest";
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
