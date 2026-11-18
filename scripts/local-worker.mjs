import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request as httpRequest, Agent } from 'node:http';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

/** Isolated production build, disposable D1, and no external provider traffic. */
export async function localWorker(build = 'dist') {
  const server = resolve(build, 'server');
  const paths = readdirSync(server, { recursive: true }).filter(p => p.endsWith('.js')).sort((a, b) => a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b));
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'pep-workload', modules: paths.map(p => ({ type: 'ESModule', path: resolve(server, p) })), modulesRoot: server,
    compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    durableObjects: { VOICE_DEADLINES: { className: 'VoiceDeadline', useSQLite: true } },
    outboundService: () => new Response(null, { status: 404 }),
    bindings: { IDENTITY_TRUSTED_HOSTS: 'localhost', AI_CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
    assets: { directory: resolve(build, 'client'), binding: 'ASSETS', routerConfig: { has_user_worker: true } },
  }));
  let agent;
  try {
    const ready = await mf.ready, db = await mf.getD1Database('DB');
    for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) {
        if (statement.trim()) await db.exec(statement.replace(/\n/g, ' '));
      }
    }
    agent = new Agent({ keepAlive: true, maxSockets: 32 });
    const request = (path, init = {}) => new Promise((resolveResponse, reject) => {
      const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
      const req = httpRequest(new URL(path, ready), { agent: init.isolated ? false : agent, method: init.method || 'GET', headers: {
        host: 'localhost', ...(init.email ? { 'oai-authenticated-user-email': init.email } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...init.headers,
      } }, res => {
        const chunks = [];
        res.on('error', reject);
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveResponse({ status: res.statusCode, headers: res.headers, text, bytes: Buffer.byteLength(text), json: () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('Local HTTP timeout')));
      req.end(body);
    });
    return { mf, db, ready, request, close: async () => { agent.destroy(); await mf.dispose(); } };
  } catch (error) { agent?.destroy(); await mf.dispose(); throw error; }
}
