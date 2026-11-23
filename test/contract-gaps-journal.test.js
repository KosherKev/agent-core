import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJournalEntry } from '../src/validators.js';
import { loadFixtures } from './helpers.js';

const base = { schema_version: '1', id: 'j1', run_id: 'r1', at: '2026-11-23T05:00:00Z' };
const issue = { ...base, kind: 'issue', category: 'bug', description: 'd', severity: 'low', suggested_fix: 'f' };
const attempt = { ...base, kind: 'attempt', tried: 't', reason: 'r' };

test('journal: issue without issue_kind stays valid (backward compatible)', () => {
  assert.equal(validateJournalEntry(issue).valid, true);
});

test('journal: issue_kind accepts new kebab-case kinds without a schema change', () => {
  for (const k of ['contract-gap', 'rate-limit', 'refusal', 'brand-new-kind-2', 'x']) {
    assert.equal(validateJournalEntry({ ...issue, issue_kind: k }).valid, true, k);
  }
});

test('journal: issue_kind rejects non kebab-case values', () => {
  for (const k of ['', 'Contract-Gap', 'contract_gap', '-a', 'a-', 'a--b', '1a', 'a b', 'a'.repeat(65), 5, null]) {
    const r = validateJournalEntry({ ...issue, issue_kind: k });
    assert.equal(r.valid, false, String(k));
  }
});

test('journal: issue_kind is only allowed on issue entries', () => {
  assert.equal(validateJournalEntry({ ...attempt, outcome: 'ok', issue_kind: 'contract-gap' }).valid, false);
});

test('journal: every pre-existing fixture still validates or fails as before', () => {
  const oldValid = ['attempt-blocked', 'attempt-ok', 'issue', 'reservation'];
  const oldInvalid = ['bad-outcome', 'bad-timestamp', 'issue-no-fix', 'mixed-fields', 'reservation-no-action', 'unknown-kind'];
  const v = loadFixtures('run-journal-entry', 'valid'); const i = loadFixtures('run-journal-entry', 'invalid');
  for (const n of oldValid) assert.equal(validateJournalEntry(v.find((f) => f.file === `${n}.json`).data).valid, true, n);
  for (const n of oldInvalid) assert.equal(validateJournalEntry(i.find((f) => f.file === `${n}.json`).data).valid, false, n);
});
