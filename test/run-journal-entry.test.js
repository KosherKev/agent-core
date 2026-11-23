import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJournalEntry } from '../src/validators.js';
import { fixtureSuite, loadFixtures } from './helpers.js';

fixtureSuite(test, assert, 'run-journal-entry', 'journal-entry', validateJournalEntry);
test('journal-entry: all three kinds have a valid fixture', () => {
  const kinds = new Set(loadFixtures('run-journal-entry', 'valid').map((f) => f.data.kind));
  assert.deepEqual([...kinds].sort(), ['attempt', 'issue', 'reservation']);
});
