import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
// Fixed versions recommended by the 2026-10-31 production audit. This protects
// against reintroducing these known advisories; audit:prod also checks new ones.
const fixed = { next: [16, 4, 3], sharp: [0, 35, 5], 'source-map-js': [1, 2, 2] };
function patched(version, minimum) {
  const parts = version.split('.').map(Number);
  return minimum.some((part, index) => parts[index] > part && minimum.slice(0, index).every((earlier, j) => parts[j] === earlier)) ||
    minimum.every((part, index) => parts[index] === part);
}
function installed(name, from = require) {
  let directory = dirname(from.resolve(name));
  while (directory !== dirname(directory)) {
    try {
      const file = join(directory, 'package.json');
      const json = JSON.parse(readFileSync(file, 'utf8'));
      if (json.name === name) return { json, require: createRequire(file) };
    } catch { /* The entry may sit below the package root. */ }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate installed ${name}`);
}

test('production framework and parser/image dependencies exclude the reported vulnerable releases', () => {
  const next = installed('next');
  const actual = {
    next: next.json.version,
    sharp: installed('sharp', next.require).json.version,
    'source-map-js': installed('source-map-js', installed('postcss', next.require).require).json.version,
  };
  for (const [name, minimum] of Object.entries(fixed)) {
    assert.ok(patched(actual[name], minimum), `${name}@${actual[name]} precedes its audited fix`);
    const entries = Object.entries(lock.packages).filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
    assert.ok(entries.length, `${name} must remain locked`);
    for (const [path, entry] of entries) assert.ok(patched(entry.version, minimum), `${path}@${entry.version} retains a vulnerable copy`);
  }
});
