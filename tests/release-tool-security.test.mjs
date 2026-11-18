import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { lexiconIndexEntry } from '../scripts/lexicon-release.mjs';
import { encodeLexiconIndex } from '../lib/lexicon-index-codec.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (cwd, command, args, options = {}) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, args, { cwd, encoding: 'utf8', env, ...options });
};
function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function copy(relative, target) {
  mkdirSync(dirname(join(target, relative)), { recursive: true });
  cpSync(join(root, relative), join(target, relative));
}
function packageFixture(t, source = 'export default { fetch() { return new Response("reviewed"); } };') {
  const directory = temporary(t, 'pep-package-security-');
  for (const relative of ['scripts/package-site.sh', 'scripts/release-archive.py', 'scripts/install-ci.sh', 'scripts/build-verified.sh', 'scripts/validate-artifact.sh', 'scripts/sites-env.sh', 'scripts/check-lexicon-release.mjs', 'scripts/lexicon-release.mjs', 'lib/lexicon-index-codec.mjs']) copy(relative, directory);
  writeFileSync(join(directory, '.gitignore'), '/dist/\n/outputs/\n/node_modules/\n/.sites-runtime/\n*.pem\n.env*\n');
  writeFileSync(join(directory, 'release-source.js'), source);
  mkdirSync(join(directory, '.openai'), { recursive: true });
  writeFileSync(join(directory, '.openai/hosting.json'), '{"d1":"DB"}');
  mkdirSync(join(directory, 'drizzle/meta'), { recursive: true });
  writeFileSync(join(directory, 'drizzle/0000.sql'), 'CREATE TABLE example (id TEXT);');
  writeFileSync(join(directory, 'drizzle/meta/_journal.json'), '{"entries":[]}');
  const entry = { id: 'pep-aaaaaaaaaaaaaaaa', headword: 'word', lookup: 'word', tier: 'C', chineseCore: '词', britishIpa: 'wɜːd', americanIpa: 'wɜːrd', partsOfSpeech: ['n'], scopes: ['middle-core'], sources: [{ bookId: 'JH-7A', volume: '七年级上册', unit: 'Unit 1', printedPage: 1 }], flags: { highFrequencyContinuation: false, highValue: false, properName: false, formalReleaseEligible: true }, license: { headwordAndChinese: 'Apache-2.0' } };
  const release = join(directory, 'public/data/v1');
  mkdirSync(join(release, 'chunks'), { recursive: true });
  writeFileSync(join(release, 'chunks/lexicon-00.json'), JSON.stringify([entry]));
  writeFileSync(join(release, 'index.json'), JSON.stringify(encodeLexiconIndex([lexiconIndexEntry(entry)])));
  writeFileSync(join(release, 'manifest.json'), JSON.stringify({ releasedEntries: 1, chunks: [{ file: 'chunks/lexicon-00.json', count: 1, first: entry.id, last: entry.id }] }));
  const dependency = temporary(t, 'pep-reviewed-builder-');
  mkdirSync(join(dependency, 'package'));
  writeFileSync(join(dependency, 'package/package.json'), JSON.stringify({ name: 'vinext', version: '1.0.0', bin: { vinext: 'build.cjs' } }));
  writeFileSync(join(dependency, 'package/build.cjs'), `#!/usr/bin/env node
const fs = require('node:fs');
const source = fs.readFileSync('release-source.js', 'utf8');
if (source === 'fail-build') process.exit(42);
fs.mkdirSync('dist/server', { recursive: true });
fs.writeFileSync('dist/server/index.js', source);
fs.cpSync('public', 'dist/client', { recursive: true });
fs.mkdirSync('dist/.openai', { recursive: true });
fs.copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
`, { mode: 0o755 });
  mkdirSync(join(directory, 'fixtures'));
  const tarball = join(directory, 'fixtures/vinext.tgz');
  const packed = run(dependency, 'tar', ['-czf', tarball, 'package']);
  assert.equal(packed.status, 0, packed.stderr);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  const manifest = { name: 'release-test', version: '1.0.0', dependencies: { vinext: 'file:fixtures/vinext.tgz' } };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    '': manifest,
    'node_modules/vinext': { version: '1.0.0', resolved: 'file:fixtures/vinext.tgz', integrity, bin: { vinext: 'build.cjs' } },
  } }));
  mkdirSync(join(directory, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(directory, 'node_modules/.bin/vinext'), '#!/bin/sh\ntouch "' + join(directory, 'poison-executed') + '"\nexit 99\n', { mode: 0o755 });
  // A structurally valid ignored artifact can have unrelated executable bytes.
  mkdirSync(join(directory, 'dist/server'), { recursive: true });
  writeFileSync(join(directory, 'dist/server/index.js'), 'export default { fetch() { return new Response("unreviewed"); } };');
  cpSync(join(directory, 'public'), join(directory, 'dist/client'), { recursive: true });
  writeFileSync(join(directory, 'dist/client/unreviewed.js'), 'globalThis.unreviewed = true;');
  mkdirSync(join(directory, 'dist/.openai'), { recursive: true });
  cpSync(join(directory, '.openai/hosting.json'), join(directory, 'dist/.openai/hosting.json'));
  git(directory, 'init', '-q');
  git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'commit', '-qm', 'Reviewed fixture');
  return directory;
}

test('packaging installs locked dependencies in isolation and retains archive/migration layout', t => {
  const directory = packageFixture(t);
  const archive = join(temporary(t, 'pep-custom-archive-'), 'nested/site.tar.gz');
  const result = run(directory, 'bash', ['scripts/package-site.sh', archive]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(directory, 'poison-executed')), false);
  assert.match(readFileSync(join(directory, 'node_modules/.bin/vinext'), 'utf8'), /poison-executed/);
  const worker = run(directory, 'tar', ['-xOf', archive, 'dist/server/index.js']);
  assert.equal(worker.status, 0, worker.stderr);
  assert.match(worker.stdout, /reviewed/);
  assert.doesNotMatch(worker.stdout, /unreviewed/);
  const entries = run(directory, 'tar', ['-tzf', archive]);
  assert.equal(entries.status, 0, entries.stderr);
  assert.doesNotMatch(entries.stdout, /unreviewed\.js/);
  assert.match(entries.stdout, /migrations\/meta\/_journal\.json/);
  assert.match(entries.stdout, /drizzle\/0000\.sql/);
});

test('a failed fresh build cannot package a previously valid artifact', t => {
  const directory = packageFixture(t, 'fail-build');
  const archive = join(directory, 'outputs/site.tar.gz');
  const result = run(directory, 'bash', ['scripts/package-site.sh', archive]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(archive), false);
});

test('ignored private files and symlinks fail before any dependency executable runs', t => {
  const directory = packageFixture(t);
  for (const relative of ['public/private.pem', 'public/.env.local', 'drizzle/private.pem', 'drizzle/.env.production', 'public/untracked.txt']) {
    writeFileSync(join(directory, relative), 'harmless private decoy');
    const result = run(directory, 'bash', ['scripts/package-site.sh']);
    assert.notEqual(result.status, 0, relative);
    assert.equal(existsSync(join(directory, 'poison-executed')), false);
    assert.equal(existsSync(join(directory, 'outputs/site.tar.gz')), false);
    rmSync(join(directory, relative));
  }
  symlinkSync(join(directory, 'release-source.js'), join(directory, 'public/private.pem'));
  assert.notEqual(run(directory, 'bash', ['scripts/package-site.sh']).status, 0);
  assert.equal(existsSync(join(directory, 'poison-executed')), false);
});

test('fresh dependency install rejects a tarball that differs from the reviewed lock integrity', t => {
  const directory = packageFixture(t);
  writeFileSync(join(directory, 'fixtures/vinext.tgz'), 'corrupted dependency');
  git(directory, 'add', 'fixtures/vinext.tgz');
  git(directory, '-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'commit', '-qm', 'Mismatched dependency');
  const result = run(directory, 'bash', ['scripts/package-site.sh'], { timeout: 20000 });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /Running bounded vinext build/);
  assert.equal(existsSync(join(directory, 'poison-executed')), false);
  assert.equal(existsSync(join(directory, 'outputs/site.tar.gz')), false);
});

test('archive verification rejects unexpected members, link types and changed bytes', t => {
  const directory = temporary(t, 'pep-archive-check-');
  const code = `
import importlib.util, hashlib, io, pathlib, tarfile
spec = importlib.util.spec_from_file_location('release', ${JSON.stringify(join(root, 'scripts/release-archive.py'))})
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
archive = pathlib.Path(${JSON.stringify(join(directory, 'fixture.tar.gz'))})
expected = {'dist/server/index.js': (None, 4, hashlib.sha256(b'safe').hexdigest())}
for name, kind, data in [('extra', tarfile.REGTYPE, b'safe'), ('dist/server/index.js', tarfile.SYMTYPE, b''), ('dist/server/index.js', tarfile.REGTYPE, b'evil')]:
    with tarfile.open(archive, 'w:gz') as target:
        entry = tarfile.TarInfo(name)
        entry.type, entry.size = kind, len(data)
        target.addfile(entry, io.BytesIO(data))
    try:
        release.verify_archive(archive, expected)
    except ValueError:
        continue
    raise AssertionError('unsafe archive was accepted')
`;
  const result = run(directory, 'python3', ['-B', '-c', code]);
  assert.equal(result.status, 0, result.stderr);
});

test('every comparison command rejects a locally available hostile Git baseline before execution', t => {
  const directory = temporary(t, 'pep-benchmark-security-');
  git(directory, 'clone', '--quiet', '--shared', root, '.');
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const trusted = git(directory, 'rev-parse', 'HEAD');
  const marker = join(directory, 'baseline-executed');
  const payload = `\nimport { writeFileSync as baselineMarker } from 'node:fs'; baselineMarker(${JSON.stringify(marker)}, 'executed');\n`;
  const question = join(directory, 'lib/questions.ts');
  writeFileSync(question, payload + 'export function buildQuestion() { return null; }');
  const backend = join(directory, 'lib/assistant/core.ts');
  writeFileSync(backend, readFileSync(backend, 'utf8').replace('\nfunction privateIpv4', payload + '\nfunction privateIpv4'));
  const reading = join(directory, 'lib/reading-library.ts');
  writeFileSync(reading, readFileSync(reading, 'utf8') + payload);
  git(directory, 'add', 'lib');
  git(directory, '-c', 'user.name=Benchmark test', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'Hostile baseline fixture');
  const hostile = git(directory, 'rev-parse', 'HEAD');
  git(directory, 'branch', 'hostile-baseline', hostile);
  git(directory, 'checkout', '--quiet', '--detach', trusted);
  for (const relative of ['scripts/benchmark-core.mjs', 'scripts/benchmark-backend.mjs', 'scripts/benchmark-reading-lookup.mjs', 'scripts/benchmark-toolbox.mjs', 'scripts/benchmark-baseline.mjs']) copy(relative, directory);
  for (const command of ['core', 'backend', 'reading-lookup', 'toolbox']) {
    for (const reference of [hostile, 'refs/heads/hostile-baseline']) {
      const result = run(directory, process.execPath, ['--import', './tests/register.mjs', `scripts/benchmark-${command}.mjs`, reference]);
      assert.notEqual(result.status, 0, command);
      assert.equal(existsSync(marker), false, `${command} executed hostile source`);
      assert.match(result.stderr, /Unreviewed benchmark baseline/, command);
    }
  }
});
