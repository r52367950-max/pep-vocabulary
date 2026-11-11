import { execFileSync } from 'node:child_process';

// These exact historical implementations were reviewed for the comparisons
// below. Adding a baseline requires reviewing every executed module/slice here.
const reviewed = {
  toolbox: {
    revisions: ['f10737e675cf5e55352f0a9d2808600eb19e664d'],
    paths: ['lib/assistant/toolbox.ts'],
  },
  core: {
    revisions: ['3b12529a574addbb3064df865a1849e43a3600fb'],
    paths: ['lib/questions.ts', 'lib/lexicon.ts'],
  },
  backend: {
    revisions: ['e2e9e25b350e9cbaf7b2fa6c5da4063cc26d2a70'],
    paths: ['lib/assistant/core.ts'],
  },
  reading: {
    revisions: ['0b8610b1375b2e165aa785df974af78962a78962', '3eb187535a9d5c678d9a4116d5012fd4c87f9007'],
    paths: ['lib/reading-library.ts'],
  },
};

export function benchmarkBaseline(kind, requested) {
  const policy = reviewed[kind];
  if (!policy) throw new Error('Unknown benchmark comparison');
  const input = requested ?? policy.revisions[0];
  let revision;
  try {
    revision = execFileSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', `${input}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(`Unreviewed benchmark baseline. Available ${kind} revisions: ${policy.revisions.join(', ')}`);
  }
  if (!policy.revisions.includes(revision)) {
    throw new Error(`Unreviewed benchmark baseline. Available ${kind} revisions: ${policy.revisions.join(', ')}`);
  }
  return {
    revision,
    source(path) {
      if (!policy.paths.includes(path)) throw new Error('Unreviewed benchmark source path');
      // Disable replacement refs too: approved commit IDs must resolve to their
      // original content, never a locally substituted tree or blob.
      return execFileSync('git', ['--no-replace-objects', 'show', `${revision}:${path}`], { encoding: 'utf8' });
    },
  };
}
