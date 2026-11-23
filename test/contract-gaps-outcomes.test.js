import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJournalEntry } from '../src/validators.js';

const base = { schema_version: '1', id: 'j1', run_id: 'r1', at: '2026-11-23T05:00:00Z' };
const issue = { ...base, kind: 'issue', category: 'bug', description: 'd', severity: 'low', suggested_fix: 'f' };
const attempt = { ...base, kind: 'attempt', tried: 't', reason: 'r' };

test('journal: refused and truncated are valid outcomes, old values unchanged, others rejected', () => {
  for (const o of ['ok', 'failed', 'blocked', 'refused', 'truncated']) assert.equal(validateJournalEntry({ ...attempt, outcome: o }).valid, true, o);
  for (const o of ['maybe', 'Refused', '', 'truncate']) assert.equal(validateJournalEntry({ ...attempt, outcome: o }).valid, false, o);
});
