import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScopesV2Schema, validateTrustRegistryV2Schema } from '../src/validators.js';
import { validateRegistryV2 } from '../src/capability-v2.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'proposals');
const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

test('proposed config/capability-scopes.json validates and holds exactly the three builder scopes', () => {
  const doc = read('capability-scopes.json');
  const r = validateScopesV2Schema(doc);
  assert.equal(r.valid, true, r.errors.join('; '));
  assert.deepEqual([...doc.scopes].sort(), ['repo:commit:task-branch', 'repo:read:task-worktree', 'repo:write:task-worktree']);
});

test('proposed config/trust-registry.json validates and has no entries (everything denied)', () => {
  const doc = read('trust-registry.json');
  const r = validateTrustRegistryV2Schema(doc);
  assert.equal(r.valid, true, r.errors.join('; '));
  assert.equal(validateRegistryV2(doc).valid, true);
  assert.deepEqual(doc.entries, []);
});
