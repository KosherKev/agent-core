import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocked, parseLocked } from '../.github/scripts/locked-paths.mjs';

// Human-owned (locked path). The CI guard must match locked paths the way the machines that check them out do:
// macOS and Windows disks ignore case, invisible characters and trailing dots and spaces, so a path that is
// "different" to git can be the same file on disk. This fixed corpus stops a later edit of the guard from
// quietly making it weaker than the builder's own path lock. Add cases here only through a human-authored change.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const locked = parseLocked(readFileSync(join(root, '.github', 'locked-paths.txt'), 'utf8'));
const show = (p) => p.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const MUST_BE_LOCKED = [
  'acceptance/contracts.test.js', '.github/CODEOWNERS', '.github/scripts/locked-paths.mjs',
  // case
  'ACCEPTANCE/contracts.test.js', 'Acceptance/new.test.js', '.GitHub/workflows/evil.yml', '.GITHUB/scripts/locked-paths.mjs',
  // invisible characters, trailing dots and spaces, Windows separators and streams
  'accep\u200btance/x.js', '\u00adacceptance/x.js', '\ufeff.github/x', 'acceptance./x.js', 'acceptance /x.js',
  'ACCEPTANCE\\x.js', '.github::$INDEX_ALLOCATION/x',
  // git internals under any spelling, and CODEOWNERS anywhere
  '.git/config', '.GIT/config', '.git /config', '.git~1/config', 'GIT~1/x', 'sub/.gitmodules', 'sub/.gitattributes',
  'CODEOWNERS', 'docs/CODEOWNERS', 'src/codeowners',
];
const MUST_NOT_BE_LOCKED = [
  'src/free.js', 'acceptance-notes.md', 'src/acceptance.js', 'Accept/x.js', 'docs/github.md', '.gitignore', '.github-notes.md', 'my.git/x',
];

for (const p of MUST_BE_LOCKED) test(`acceptance (R4): the guard locks ${show(p)}`, () => assert.equal(isLocked(p, locked), true));
for (const p of MUST_NOT_BE_LOCKED) test(`acceptance (R4): the guard leaves ${show(p)} alone`, () => assert.equal(isLocked(p, locked), false));
