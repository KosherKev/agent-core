import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, symlinkSync, realpathSync, chmodSync, copyFileSync } from 'node:fs';
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

function makeRepo(setupBase) {
  // realpath: on macOS os.tmpdir() sits under the /var -> /private/var symlink; the repo must not depend on that.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of [
    ['acceptance/check.test.js', 'export const a = 1;\n// padding so rename detection would match\n// line\n// line\n'],
    ['.github/CODEOWNERS', '/acceptance/ @owner\n# padding\n# padding\n# padding\n'],
    ['src/free.js', 'export const f = 1;\n'],
  ]) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  if (setupBase) setupBase(dir);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
function runGuard(dir, base, guard = GUARD) {
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  // HEAD_REF=task/x makes the OLD guard treat the change as agent-authored; the new guard ignores env entirely.
  return spawnSync('node', [guard, base, head], { cwd: dir, encoding: 'utf8', env: { ...process.env, HEAD_REF: 'task/x' } });
}
function scenario(change, setupBase, guard) {
  const { dir, base } = makeRepo(setupBase);
  try { change(dir); return runGuard(dir, base, guard); } finally { rmSync(dir, { recursive: true, force: true }); }
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

// ---- Symlink and fail-closed regression tests (guard-symlink-fail-open-fix) ----
// What git records: it never follows symlinks. A write through a symlinked directory lands on the
// REAL path (acceptance/x), so git reports that path; only the symlink entry itself (mode 120000) is
// recorded under the link's own path.
const ln = (dir, target, at) => { mkdirSync(dirname(join(dir, at)), { recursive: true }); symlinkSync(target, join(dir, at)); };

test('guard symlink: symlink added under a locked directory fails', () => {
  const r = scenario((d) => ln(d, '../src/free.js', 'acceptance/link.js'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/link\.js/);
});
test('guard symlink: symlink added under .github/ fails', () => {
  const r = scenario((d) => ln(d, '../src/free.js', '.github/link'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
test('guard symlink: write through an outside symlink lands on the real locked path and fails', () => {
  const r = scenario((d) => writeFileSync(join(d, 'src/link/new.test.js'), 'x\n'), (d) => ln(d, '../acceptance', 'src/link'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/new\.test\.js/);
});
test('guard symlink: new symlink OUTSIDE locked paths pointing into a locked directory fails', () => {
  const r = scenario((d) => ln(d, '../acceptance', 'src/sneaky'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /src\/sneaky/);
});
test('guard symlink: new symlink to a locked file via a chain of links fails', () => {
  const r = scenario((d) => ln(d, 'hop2', 'src/hop1'), (d) => { ln(d, '../acceptance/check.test.js', 'src/hop2'); });
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
test('guard symlink: outside symlink retargeted into a locked directory fails', () => {
  const r = scenario((d) => { rmSync(join(d, 'src/link')); ln(d, '../.github', 'src/link'); }, (d) => ln(d, '../src', 'src/link'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
test('guard symlink: locked file replaced by a symlink (type change, 120000) fails', () => {
  const r = scenario((d) => { rmSync(join(d, 'acceptance/check.test.js')); ln(d, '../src/free.js', 'acceptance/check.test.js'); });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/check\.test\.js/);
});
test('guard symlink: removal of a symlink that lives under a locked path fails', () => {
  const r = scenario((d) => rmSync(join(d, 'acceptance/old-link')), (d) => ln(d, '../src/free.js', 'acceptance/old-link'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /acceptance\/old-link/);
});
test('guard symlink: harmless outside symlink pointing at an unlocked file passes', () => {
  const r = scenario((d) => ln(d, 'free.js', 'src/alias.js'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('guard symlink: outside symlink whose target cannot be resolved inside the repo fails closed', () => {
  for (const target of ['/etc/passwd', '../../outside']) {
    const r = scenario((d) => ln(d, target, 'src/escape'));
    assert.notEqual(r.status, 0, `${target}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /cannot|unresolv|outside/i);
  }
});

// Entry point: the guard must run (and fail) when started through a symlinked path.
function guardCopy() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guardbin-')));
  mkdirSync(join(root, 'real', 'scripts'), { recursive: true });
  copyFileSync(GUARD, join(root, 'real', 'scripts', 'locked-paths.mjs'));
  copyFileSync(join(dirname(GUARD), '..', 'locked-paths.txt'), join(root, 'real', 'locked-paths.txt'));
  return root;
}
test('guard entry: invoked through a symlinked file still fails on a locked change', () => {
  const root = guardCopy();
  try {
    symlinkSync(join(root, 'real', 'scripts', 'locked-paths.mjs'), join(root, 'guard-link.mjs'));
    const r = scenario((d) => writeFileSync(join(d, 'acceptance/new.test.js'), 'x\n'), undefined, join(root, 'guard-link.mjs'));
    assert.equal(r.status, 1, 'exit ' + r.status + ' ' + r.stdout + r.stderr);
    assert.match(r.stderr, /acceptance\/new\.test\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('guard entry: invoked through a symlinked directory still fails on a locked change', () => {
  const root = guardCopy();
  try {
    symlinkSync(join(root, 'real'), join(root, 'dirlink'));
    const r = scenario((d) => rmSync(join(d, 'acceptance/check.test.js')), undefined, join(root, 'dirlink', 'scripts', 'locked-paths.mjs'));
    assert.equal(r.status, 1, 'exit ' + r.status + ' ' + r.stdout + r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('guard entry: through a symlink a clean change passes and is not silent', () => {
  const root = guardCopy();
  try {
    symlinkSync(join(root, 'real', 'scripts', 'locked-paths.mjs'), join(root, 'guard-link.mjs'));
    const r = scenario((d) => writeFileSync(join(d, 'src/free.js'), 'export const f = 3;\n'), undefined, join(root, 'guard-link.mjs'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no locked paths touched/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('guard entry: the repo itself is reached via the non-realpath tmp path (/var symlink on macOS)', () => {
  const { dir, base } = makeRepo();
  const viaTmp = join(tmpdir(), dir.split('/').pop()); // may be the symlinked spelling of the same dir
  try {
    writeFileSync(join(dir, 'acceptance/new.test.js'), 'x\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'c');
    const r = spawnSync('node', [GUARD, base, git(dir, 'rev-parse', 'HEAD')], { cwd: viaTmp, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Fail closed: errors never exit 0.
function runRaw(dir, args, env = {}) {
  return spawnSync('node', [GUARD, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
}
test('guard fail-closed: bad SHA exits non-zero', () => {
  const { dir, base } = makeRepo();
  try {
    const r = runRaw(dir, [base, '0123456789abcdef0123456789abcdef01234567']);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /FAILED CLOSED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard fail-closed: non-hex / option-looking ref exits non-zero', () => {
  const { dir, base } = makeRepo();
  try {
    for (const bad of ['--output=/dev/null', 'not-a-ref', '']) {
      const r = runRaw(dir, [base, bad]);
      assert.notEqual(r.status, 0, `${bad}: ${r.stdout}${r.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard fail-closed: missing arguments exit non-zero', () => {
  const { dir } = makeRepo();
  try { assert.notEqual(runRaw(dir, []).status, 0); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard fail-closed: not a git repository exits non-zero', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nogit-')));
  try {
    const r = runRaw(dir, ['a'.repeat(40), 'b'.repeat(40), ], { GIT_CEILING_DIRECTORIES: dirname(dir) });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard fail-closed: unexpected git output exits non-zero', () => {
  const { dir, base } = makeRepo();
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'fakegit-')));
  try {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "garbage-not-raw-format\\0src/free.js\\0"\n');
    chmodSync(join(bin, 'git'), 0o755);
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = runRaw(dir, [base, head], { PATH: bin + ':' + process.env.PATH });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /FAILED CLOSED.*unexpected git output/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});
test('guard fail-closed: git binary failing exits non-zero', () => {
  const { dir, base } = makeRepo();
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'fakegit-')));
  try {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 3\n');
    chmodSync(join(bin, 'git'), 0o755);
    const r = runRaw(dir, [base, base], { PATH: bin + ':' + process.env.PATH });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});
