import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/validators.js';
import { createJournal } from '../src/journal.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = ['capability-manifest', 'extension-request', 'run-journal-entry', 'grant', 'self-model'];
const fixtures = (c, k) => readdirSync(join(root, 'fixtures', c, k)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(root, 'fixtures', c, k, f), 'utf8')));

for (const c of CONTRACTS) {
  test(`acceptance: ${c} has valid and invalid fixtures that behave`, () => {
    assert.ok(fixtures(c, 'valid').length > 0 && fixtures(c, 'invalid').length > 0);
    fixtures(c, 'valid').forEach((d) => assert.equal(validate(c, d).valid, true));
    fixtures(c, 'invalid').forEach((d) => assert.equal(validate(c, d).valid, false));
  });
}

test('acceptance (R1): a manifest with no undo is refused', () => {
  const { undo, ...m } = fixtures('capability-manifest', 'valid')[0];
  assert.equal(validate('capability-manifest', m).valid, false);
});

test('acceptance: the journal exposes append and read only', () => {
  assert.deepEqual(Object.keys(createJournal()).sort(), ['append', 'read']);
});

test('acceptance (R4): locked paths are covered by CODEOWNERS', () => {
  const owners = readFileSync(join(root, '.github', 'CODEOWNERS'), 'utf8');
  const locked = readFileSync(join(root, '.github', 'locked-paths.txt'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(locked.includes('acceptance/'));
  for (const p of locked) assert.ok(owners.split('\n').some((l) => l.startsWith(`/${p}`)), `${p} missing from CODEOWNERS`);
});

// Workflow files; GUARD_WORKFLOW / TESTS_WORKFLOW override the paths (used to check these tests fail on a bad layout).
const guardPath = process.env.GUARD_WORKFLOW || join(root, '.github', 'workflows', 'protect-locked-paths.yml');
const testsPath = process.env.TESTS_WORKFLOW || join(root, '.github', 'workflows', 'tests.yml');
// No YAML parser is a dependency, so: drop comments, then do structural checks on indentation.
const stripComments = (t) => t.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).filter((l) => l.trim()).join('\n');
const readWf = (p) => stripComments(readFileSync(p, 'utf8'));
// Lines belonging to a top-level key (indent 0), excluding the key line itself.
const block = (text, key) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]); i++) out.push(lines[i]);
  return out.join('\n');
};
const topKeys = (text) => text.split('\n').filter((l) => /^[A-Za-z_-]+:/.test(l)).map((l) => l.split(':')[0]);

test('acceptance (R4): the guard workflow runs on pull_request_target from main with one job protect-locked-paths', () => {
  const wf = readWf(guardPath);
  const on = block(wf, 'on');
  assert.match(on, /^ {2}pull_request_target:\s*$/m, 'must trigger on pull_request_target');
  assert.doesNotMatch(on, /^ {2}pull_request:/m, 'must not also trigger on plain pull_request');
  assert.match(on, /^ {4}branches: \[main\]\s*$/m, 'must be restricted to branches [main]');
  assert.equal(block(wf, 'permissions').replace(/\s+/g, ' ').trim(), 'permissions: contents: read');
  const jobs = block(wf, 'jobs');
  const jobIds = jobs.split('\n').filter((l) => /^ {2}[\w-]+:\s*$/.test(l)).map((l) => l.trim().slice(0, -1));
  assert.deepEqual(jobIds, ['protect-locked-paths']);
  assert.match(jobs, /^ {4}name: protect-locked-paths\s*$/m);
  assert.match(jobs, /locked-paths\.mjs/);
});

test('acceptance (R4): the guard workflow never checks out or executes PR code', () => {
  const wf = readWf(guardPath);
  assert.doesNotMatch(wf, /\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b|setup-node/, 'no install/build/test steps');
  const checkouts = wf.match(/actions\/checkout[^\n]*\n(?: {8,}[^\n]*\n?)*/g) || [];
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0], /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.doesNotMatch(checkouts[0], /head/, 'checkout must not reference the PR head');
  assert.doesNotMatch(wf, /refs\/pull\/[^\n]*\/merge|pull_request\.head\.(ref|repo)/, 'no merge ref or head ref/repo');
  assert.doesNotMatch(wf, /secrets\./, 'no secrets');
  // The PR head is only fetched (as data) and passed to the guard via env.
  assert.match(wf, /git fetch [^\n]*refs\/pull\/\$\{PR_NUMBER\}\/head/);
});

test('acceptance (R4): tests run in a separate workflow on plain pull_request', () => {
  assert.notEqual(guardPath === testsPath, true);
  const wf = readWf(testsPath);
  const on = block(wf, 'on');
  assert.match(on, /^ {2}pull_request:\s*$/m);
  assert.doesNotMatch(wf, /pull_request_target/);
  assert.doesNotMatch(wf, /secrets\./);
  assert.equal(block(wf, 'permissions').replace(/\s+/g, ' ').trim(), 'permissions: contents: read');
  assert.match(block(wf, 'jobs'), /^ {2}tests:\s*$/m);
  assert.match(wf, /npm test/);
  assert.doesNotMatch(readWf(guardPath), /npm test/, 'the guard workflow must not contain the tests job');
  assert.ok(topKeys(wf).includes('jobs'));
});
