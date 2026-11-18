const VERSION = "vocab-shell-v2";
const PREFIX = "vocab-shell-";
const SHELL = ["/", "/manifest.webmanifest", "/icons/app-192.png", "/icons/app-512.png", "/data/v1/manifest.json", "/data/v1/index.json"];

function cacheable(request, response) {
  return response.ok && !response.redirected && !/\bno-store\b/i.test(response.headers.get("cache-control") || "") &&
    (!response.url || new URL(response.url).origin === new URL(request.url).origin);
}

// CORS preloads include the site's Origin. Install and download requests omit it.
// Both read the same published assets; preserve every other Vary header in the key.
function assetCacheKey(request) {
  if (request.headers.get("origin") !== self.location.origin) return request;
  const headers = new Headers(request.headers);
  headers.delete("origin");
  return new Request(request.url, { headers });
}

async function putSafely(cache, request, response) {
  if (cache && cacheable(request, response)) {
    try { await cache.put(request, response.clone()); } catch { /* A full cache must not break online learning. */ }
  }
}

async function matchSafely(cache, request) {
  try { return cache ? await cache.match(request) : undefined; }
  catch { return undefined; }
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
function sameOriginClient(source) {
  try { return Boolean(source) && typeof source.url === "string" && new URL(source.url).origin === self.location.origin; }
  catch { return false; }
}

async function prepareLexicon() {
  const cache = await caches.open(VERSION);
  const requestFor = (path) => new Request(new URL(`/data/v1/${path}`, self.location.origin));
  const manifest = await cache.match(requestFor("manifest.json"));
  if (!manifest) throw new Error("Missing lexicon manifest");
  const { chunks } = await manifest.json();
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 500 ||
      chunks.some((chunk) => typeof chunk?.file !== "string" || !/^chunks\/[a-zA-Z0-9_-]+\.json$/.test(chunk.file))) {
    throw new Error("Invalid lexicon manifest");
  }
  const requests = chunks.map((chunk) => requestFor(chunk.file));
  for (let start = 0; start < requests.length; start += 4) {
    const batch = await Promise.allSettled(requests.slice(start, start + 4).map(async (request) => {
      if (await cache.match(request)) return;
      const response = await fetch(request, { signal: AbortSignal.timeout(20_000) });
      if (!cacheable(request, response)) throw new Error("Unavailable lexicon chunk");
      await cache.put(request, response);
    }));
    if (batch.some((result) => result.status === "rejected")) throw new Error("Offline download failed");
  }
  for (const request of requests) {
    if (!await cache.match(request)) throw new Error("Incomplete lexicon cache");
  }
  return requests.length;
}

let pendingLexicon;
self.addEventListener("message", (event) => {
  const port = event.ports?.[0];
  if (!port || event.data?.type !== "PREPARE_LEXICON" || !sameOriginClient(event.source)) return;
  // Multiple tabs share the work. A later request can retry after a failed download.
  pendingLexicon ??= prepareLexicon().finally(() => { pendingLexicon = undefined; });
  event.waitUntil(pendingLexicon.then(
    (files) => port.postMessage({ ok: true, files }),
    () => port.postMessage({ ok: false }),
  ));
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
    // Storage may become unavailable after installation (quota, private mode,
    // browser cleanup). A failed cache lookup must not block a working network.
    const cache = await caches.open(VERSION).catch(() => null);
    const key = navigation ? new Request(new URL("/", self.location.origin)) : assetCacheKey(event.request);
    if (!navigation) {
      const cached = await matchSafely(cache, key);
      if (cached) return cached;
    }
    try {
      const response = await fetch(event.request);
      if (navigation && !response.ok && !response.redirected) {
        const cached = await matchSafely(cache, key);
        if (cached) return cached;
      }
      await putSafely(cache, key, response);
      return response;
    } catch (error) {
      const cached = await matchSafely(cache, key);
      if (cached) return cached;
      throw error;
    }
  })();
  event.respondWith(operation);
  event.waitUntil(operation.then(() => undefined).catch(() => undefined));
});
