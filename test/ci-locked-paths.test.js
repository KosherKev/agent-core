import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocked, isLocked, violations, parseNameZ } from '../.github/scripts/locked-paths.mjs';

const locked = parseLocked('# c\nacceptance/\n.github/\n');

test('locked-paths: parse ignores comments and blanks', () => assert.deepEqual(locked, ['acceptance/', '.github/']));
test('locked-paths: directory prefixes match, siblings do not', () => {
  assert.equal(isLocked('acceptance/contracts.test.js', locked), true);
  assert.equal(isLocked('.github/CODEOWNERS', locked), true);
  assert.equal(isLocked('acceptance-notes.md', locked), false);
  assert.equal(isLocked('src/journal.js', locked), false);
});
test('locked-paths: violations lists only locked files', () =>
  assert.deepEqual(violations(['src/a.js', 'acceptance/x.js'], locked), ['acceptance/x.js']));
test('locked-paths: -z parsing keeps odd filenames intact', () =>
  assert.deepEqual(parseNameZ('a b.js\0dir/\u00e9\n.txt\0'), ['a b.js', 'dir/\u00e9\n.txt']));

// CLI tests: real git repos in os.tmpdir(). GUARD_SCRIPT overrides the guard under test
// (used to demonstrate the tests fail against the old guard); its ../locked-paths.txt is read.
const here = dirname(fileURLToPath(import.meta.url));
const GUARD = process.env.GUARD_SCRIPT || join(here, '..', '.github', 'scripts', 'locked-paths.mjs');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of [
    ['acceptance/check.test.js', 'export const a = 1;\n// padding so rename detection would match\n// line\n// line\n'],
    ['.github/CODEOWNERS', '/acceptance/ @owner\n# padding\n# padding\n# padding\n'],
    ['src/free.js', 'export const f = 1;\n'],
  ]) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
function runGuard(dir, base) {
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  // HEAD_REF=task/x makes the OLD guard treat the change as agent-authored; the new guard ignores env entirely.
  return spawnSync('node', [GUARD, base, head], { cwd: dir, encoding: 'utf8', env: { ...process.env, HEAD_REF: 'task/x' } });
}
function scenario(change) {
  const { dir, base } = makeRepo();
  try { change(dir); return runGuard(dir, base); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const mv = (dir, from, to) => { mkdirSync(dirname(join(dir, to)), { recursive: true }); renameSync(join(dir, from), join(dir, to)); };

test('guard CLI: rename of a locked file out of acceptance/ fails', () => {
  const r = scenario((d) => mv(d, 'acceptance/check.test.js', 'src/check.test.js'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/check\.test\.js/);
});
test('guard CLI: rename of a locked file out of .github/ fails', () => {
  const r = scenario((d) => mv(d, '.github/CODEOWNERS', 'docs/CODEOWNERS'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /\.github\/CODEOWNERS/);
});
test('guard CLI: delete of a locked file fails', () => {
  const r = scenario((d) => rmSync(join(d, 'acceptance/check.test.js')));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/check\.test\.js/);
});
test('guard CLI: add of a new file under a locked path fails', () => {
  const r = scenario((d) => writeFileSync(join(d, 'acceptance/new.test.js'), 'x\n'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/new\.test\.js/);
});
test('guard CLI: control - a change outside locked paths passes', () => {
  const r = scenario((d) => writeFileSync(join(d, 'src/free.js'), 'export const f = 2;\n'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
