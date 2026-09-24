// Serve a built dist/ directory through workerd (Miniflare), as scripts/smoke-worker.mjs does.
// `vinext start` cannot load the Cloudflare build (cloudflare: imports), so measurements use this.
// Usage (from the repository root): node artifacts/perf/serve.mjs <distDir> <port>
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const dist = resolve(process.argv[2] || "dist");
const port = Number(process.argv[3] || 5200);
const server = resolve(dist, "server");
const paths = readdirSync(server, { recursive: true })
  .filter((p) => p.endsWith(".js"))
  .sort((a, b) => (a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b)));
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "pep-perf",
    modules: paths.map((p) => ({ type: "ESModule", path: resolve(server, p) })),
    modulesRoot: server,
    compatibilityDate: "2026-09-11",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    assets: { directory: resolve(dist, "client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
  }),
  host: "127.0.0.1",
  port,
});
console.log(`serving ${dist} at ${await mf.ready}`);
const stop = async () => {
  await mf.dispose();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
