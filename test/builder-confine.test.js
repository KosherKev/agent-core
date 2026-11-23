import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, symlinkSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, confineMove, isLockedPath, ConfineError, ALWAYS_LOCKED } from '../src/builder-confine.js';
import { isLocked, parseLocked } from '../.github/scripts/locked-paths.mjs';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder } from '../src/builder-adapter.js';
import { startMock, toolCall, reply, tempRepo, makeGrant, FAKE_KEY, TEST_PRICES } from './builder-mock.js';

const W = (dir, p, extra = {}) => confine(dir, p, { write: true, allowedPaths: ['.'], ...extra });
const refused = (dir, p, opts) => assert.throws(() => W(dir, p, opts), ConfineError, p);
const REPO_ROOT = join(import.meta.dirname, '..');

function repo() {
  const dir = tempRepo();
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src/validators.js'), '// locked\n');
  writeFileSync(join(dir, 'CODEOWNERS'), '* @x\n');
  mkdirSync(join(dir, 'docs/caf\u00e9'), { recursive: true });
  writeFileSync(join(dir, '.github/locked-paths.txt'), 'acceptance/\n.github/\ndocs/caf\u00e9/\n');
  return dir;
}

test('confine: Acceptance/x and ACCEPTANCE/x are refused (case-insensitive lock)', () => {
  const dir = repo();
  refused(dir, 'Acceptance/x');
  refused(dir, 'ACCEPTANCE/x');
  refused(dir, 'acceptance/a.test.js');
  refused(dir, '.GITHUB/workflows/x.yml');
  refused(dir, 'SRC/Validators.JS');
  refused(dir, 'src/validators.js');
  refused(dir, 'codeowners');
  refused(dir, 'docs/CODEOWNERS');
});

test('confine: unicode-normalised spellings of a locked path are refused (NFC and NFD)', () => {
  const dir = repo();
  refused(dir, 'docs/caf\u00e9/x.md');            // NFC
  refused(dir, 'docs/cafe\u0301/x.md');            // NFD
  refused(dir, 'DOCS/CAFE\u0301/x.md');            // NFD + case
  refused(dir, 'accept\u200bance/x');              // zero-width char ignored by some filesystems
  refused(dir, 'acceptance\u00ad/x');              // soft hyphen
});

test('confine: a symlink into a locked path is refused (directory link and file link)', () => {
  const dir = repo();
  symlinkSync('../acceptance', join(dir, 'docs/dirlink'));
  symlinkSync('../acceptance/a.test.js', join(dir, 'docs/filelink'));
  symlinkSync('../src/validators.js', join(dir, 'docs/vlink'));
  refused(dir, 'docs/dirlink/new.test.js');
  refused(dir, 'docs/dirlink/a.test.js');
  refused(dir, 'docs/filelink');
  refused(dir, 'docs/vlink');
  assert.equal(readFileSync(join(dir, 'acceptance/a.test.js'), 'utf8'), '// locked\n');
});

test('confine: .git and .GIT segments are refused', () => {
  const dir = repo();
  refused(dir, '.git/config');
  refused(dir, '.GIT/config');
  refused(dir, 'docs/.Git/hooks/pre-commit');
  assert.throws(() => confine(dir, '.GIT/config'), ConfineError, 'reads too');
});

test('confine: .git-like spellings are refused (trailing space or dot, 8.3 short name, ignorable chars)', () => {
  const dir = repo();
  for (const p of ['.git /config', '.git./config', '.git../config', '.git~1/config', 'GIT~1/config', '.g\u200bit/config', '.gitmodules', '.gitattributes', 'docs/.git /x']) refused(dir, p);
});

test('confine: ".." escapes and absolute paths outside the workdir are refused', () => {
  const dir = repo();
  for (const p of ['../x', 'docs/../../x', 'docs/..', '/tmp/x', '/etc/passwd', `${tmpdir()}/x`, 'C:/x', '~/x', '~root/x']) refused(dir, p);
});

test('confine: both ends of a rename or move are checked', () => {
  const dir = repo();
  writeFileSync(join(dir, 'docs/a.md'), 'a');
  const opts = { allowedPaths: ['.'] };
  assert.throws(() => confineMove(dir, 'docs/a.md', 'Acceptance/a.md', opts), ConfineError, 'destination locked');
  assert.throws(() => confineMove(dir, 'acceptance/a.test.js', 'docs/b.md', opts), ConfineError, 'source locked');
  assert.throws(() => confineMove(dir, 'docs/a.md', '.GIT/config', opts), ConfineError, 'destination .git');
  assert.throws(() => confineMove(dir, 'docs/a.md', '../out.md', opts), ConfineError, 'destination escape');
  const ok = confineMove(dir, 'docs/a.md', 'docs/b.md', opts);
  assert.equal(ok.from.rel, 'docs/a.md');
  assert.equal(ok.to.rel, 'docs/b.md');
});

test('confine: an unlocked path under the workdir is still allowed (package.json is not locked)', () => {
  const dir = repo();
  assert.equal(W(dir, 'docs/new/dir/ok.md').rel, 'docs/new/dir/ok.md');
  assert.equal(W(dir, 'package.json').rel, 'package.json');
  assert.equal(W(dir, 'src/other.js').rel, 'src/other.js');
  assert.equal(W(dir, 'docs/ok.md', { allowedPaths: ['docs/'] }).rel, 'docs/ok.md');
  assert.equal(confine(dir, 'README.md').rel, 'README.md');
});

test('confine: fails closed when the check itself errors', () => {
  const dir = repo();
  assert.throws(() => confine(join(dir, 'does-not-exist'), 'docs/x.md', { write: true }), ConfineError);
  assert.throws(() => W(dir, 'docs/x.md', { allowedPaths: null }), ConfineError);
  assert.throws(() => W(dir, 42), ConfineError);
});

test('adapter end to end: case-variant writes to locked paths and .GIT/config change nothing and run no command', async () => {
  const dir = repo();
  const marker = join(tmpdir(), `fsmonitor-marker-${Date.now()}`);
  const bad = ['Acceptance/new.test.js', 'ACCEPTANCE/a.test.js', '.GITHUB/x.yml', '.GIT/config', '.agent-RUNS/x', 'SRC/VALIDATORS.JS'];
  const calls = bad.map((p, i) => toolCall('write_file', { path: p, content: `[core]\n\tfsmonitor = touch ${marker}\n` }, `c${i}`));
  const gitConfigBefore = readFileSync(join(dir, '.git/config'), 'utf8');
  const mock = await startMock((_r, n) => (n === 1 ? reply({ tool_calls: calls }, 'tool_calls') : reply({ content: 'done' })));
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_BASE_URL: mock.url, AGENT_BUILDER_MODEL: 'vendor-a/model-a' }, cwd: tmpdir() });
    const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant({ scope: { repos: ['agent-core'], paths: ['.'] }, budget: { max_usd: 1, max_tool_calls: 50 } }), workdir: dir } }, { priceTable: TEST_PRICES });
    assert.equal(result.status, 'completed');
    assert.equal(result.commit, null);
    assert.equal(readFileSync(join(dir, 'acceptance/a.test.js'), 'utf8'), '// locked\n');
    assert.equal(readFileSync(join(dir, 'src/validators.js'), 'utf8'), '// locked\n');
    assert.ok(!existsSync(marker));
    assert.equal(readFileSync(join(dir, '.git/config'), 'utf8'), gitConfigBefore);
    assert.ok(!/fsmonitor/.test(execFileSync('git', ['config', '--list'], { cwd: dir, encoding: 'utf8' })));
  } finally { await mock.close(); }
  assert.ok(!existsSync(marker));
});

test('confine: a write to CODEOWNERS spelled with a long s (U+017F) is refused', () => {
  const dir = repo();
  refused(dir, 'docs/CODEOWNER\u017f');
  refused(dir, 'docs/codeowner\u017f');
  assert.equal(isLockedPath('docs/CODEOWNER\u017f'), true);
  assert.equal(isLockedPath('docs/readme\u017f'), false);
});

// ---- shared corpus: the guard's own logic vs the adapter's check ----
const guardLocked = parseLocked(readFileSync(join(REPO_ROOT, '.github/locked-paths.txt'), 'utf8'));
const canonical = [
  'acceptance/a.test.js', 'acceptance/x/y', '.github/workflows/x.yml', '.github/CODEOWNERS', '.github/scripts/locked-paths.mjs', '.github/locked-paths.txt',
  'docs/x.md', 'README.md', 'src/journal.js', 'package.json', 'acceptances/x', 'xacceptance/x', 'docs/acceptance.md',
];
const hostile = [
  'Acceptance/x', 'ACCEPTANCE/x', '.GITHUB/x', '.Github/workflows/x.yml', 'accept\u200bance/x', './acceptance/x', 'acceptance//x', 'acceptance/./x',
  '.github /x', '.github./x', 'acceptance',
  'docs/CODEOWNER\u017f', 'sub/.GitAttributes', '.git~1/x', 'a/.gitmodules',
];

test('shared corpus: on canonical paths the adapter check and the guard agree on locked vs not', () => {
  for (const p of canonical) assert.equal(isLockedPath(p, guardLocked), isLocked(p, guardLocked), p);
});

test('shared corpus: every path the guard locks is refused by the adapter, and the adapter and guard agree on hostile spellings', () => {
  for (const p of [...canonical, ...hostile]) if (isLocked(p, guardLocked)) assert.equal(isLockedPath(p, guardLocked), true, `guard locks ${p}`);
  // The guard folds the same spellings as the adapter (case, unicode, invisible characters, trailing dots and spaces, .git-like names), so neither side locks anything the other leaves open.
  const adapterOnly = hostile.filter((p) => isLockedPath(p, guardLocked) && !isLocked(p, guardLocked));
  assert.deepEqual(adapterOnly, []);
  const guardOnly = hostile.filter((p) => isLocked(p, guardLocked) && !isLockedPath(p, guardLocked));
  assert.deepEqual(guardOnly, []);
  for (const p of hostile) assert.equal(isLockedPath(p, guardLocked), true, p);
});

test('ALWAYS_LOCKED holds the spec set and leaves package.json unlocked', () => {
  for (const p of ['acceptance/', '.github/', 'CODEOWNERS', 'src/validators.js']) assert.ok(ALWAYS_LOCKED.includes(p), p);
  assert.equal(isLockedPath('package.json'), false);
});
