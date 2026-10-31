import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sites } from '../build/sites-vite-plugin.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vocab-vendor-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, contents) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  await put('dist/client/assets/app-hash.js', 'app');
  await put('public/data/v1/index.json', '{}');
  await put('public/sw.js', 'const VERSION = "vocab-shell-v2";');
  const plugin = sites();
  plugin.configResolved({ root });
  async function build() {
    await plugin.closeBundle();
    return readFile(join(root, 'dist/client/sw.js'), 'utf8');
  }
  return { root, put, build };
}

test('same-path vendor parser, WASM and OCR data changes each rotate the worker release cache', async t => {
  const { put, build } = await fixture(t);
  const files = ['vendor/pdfjs/parser.mjs', 'vendor/ocr/core.wasm', 'vendor/ocr/lang/eng.traineddata.gz'];
  for (const file of files) await put(`public/${file}`, 'original');
  let previous = await build();
  assert.equal(await build(), previous, 'identical inputs produce the same worker');
  for (const file of files) {
    await put(`public/${file}`, 'repaired');
    const next = await build();
    assert.notEqual(next, previous, file);
    previous = next;
  }
});

test('vendor additions, removals and equal-content path changes rotate the worker release', async t => {
  const { root, put, build } = await fixture(t);
  const original = await build();
  await put('public/vendor/nested/a.js', 'parser');
  const added = await build();
  assert.notEqual(added, original);
  await rename(join(root, 'public/vendor/nested/a.js'), join(root, 'public/vendor/nested/b.js'));
  const renamed = await build();
  assert.notEqual(renamed, added, 'equal bytes at a new URL cannot reuse the old cache');
  await rm(join(root, 'public/vendor/nested/b.js'));
  assert.equal(await build(), original, 'empty directories contain no cached executable content');
});
