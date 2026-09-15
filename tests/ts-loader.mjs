import { readFile, access } from 'node:fs/promises';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: new URL('./worker-env.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === 'next/navigation') return nextResolve('next/navigation.js', context);
  if (specifier === 'next/headers') return { url: new URL('./request-headers.mjs', import.meta.url).href, shortCircuit: true };
  const base = specifier.startsWith('@/') ? new URL(`../${specifier.slice(2)}`, import.meta.url) :
    specifier.startsWith('.') ? new URL(specifier, context.parentURL) : null;
  if (base && !/\.[cm]?[jt]sx?$/.test(base.pathname)) {
    for (const suffix of ['.ts', '/index.ts']) {
      const url = new URL(base.href + suffix);
      try { await access(url); return { url: url.href, shortCircuit: true }; } catch { /* try next */ }
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(await readFile(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  }
  return nextLoad(url, context);
}
