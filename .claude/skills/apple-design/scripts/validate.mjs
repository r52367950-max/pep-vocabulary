#!/usr/bin/env node
// Offline validation of the vendored skill; no package installation or network.
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: apple-design\r?\ndescription: [\s\S]+?\r?\n---/);
const references = new Set([...skill.matchAll(/\b([a-z][a-z0-9-]*\.md)\b/g)].map(match => match[1]));
for (const name of references) {
  if (name === 'file.md') continue; // Report-template placeholder.
  const relative = ['hig-lookup.md', 'cross-platform.md'].includes(name) ? name : `hig/${name}`;
  await access(path.join(root, 'references', relative));
}
const files = (await readdir(path.join(root, 'references', 'hig'))).filter(name => name.endsWith('.md'));
for (const name of files) {
  assert.doesNotMatch(await readFile(path.join(root, 'references', 'hig', name), 'utf8'), /doc:\/\//, name);
}
console.log(`apple-design: valid local skill; ${references.size - 1} named references and ${files.length} guideline files checked.`);
