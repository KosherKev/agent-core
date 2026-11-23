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

test('acceptance: the protection workflow exists and references the locked-path check', () => {
  const wf = readFileSync(join(root, '.github', 'workflows', 'protect-locked-paths.yml'), 'utf8');
  assert.match(wf, /locked-paths\.mjs/);
});
