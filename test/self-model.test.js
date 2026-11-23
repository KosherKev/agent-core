import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSelfModel } from '../src/validators.js';
import { generateSelfModel, serialize, REPO_ROOT } from '../src/self-model.js';
import { fixtureSuite } from './helpers.js';

fixtureSuite(test, assert, 'self-model', 'self-model', validateSelfModel);

test('self-model: generated index validates and covers every contract with an ADR', () => {
  const m = generateSelfModel();
  assert.equal(validateSelfModel(m).valid, true);
  assert.deepEqual(m.contracts.map((c) => c.name), ['capability-manifest', 'extension-request', 'grant', 'run-journal-entry', 'self-model', 'task-spec']);
  assert.equal(m.adrs.length, m.contracts.length, 'one ADR per contract');
  assert.ok(m.modules.some((x) => x.name === 'journal'));
});

test('self-model: generation is deterministic and committed self-model.json is current', () => {
  assert.equal(serialize(generateSelfModel()), serialize(generateSelfModel()));
  assert.equal(readFileSync(join(REPO_ROOT, 'self-model.json'), 'utf8'), serialize(generateSelfModel()));
});
