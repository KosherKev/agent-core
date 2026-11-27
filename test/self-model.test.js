import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSelfModel } from '../src/validators.js';
import { generateSelfModel, serialize, REPO_ROOT } from '../src/self-model.js';
import { fixtureSuite } from './helpers.js';

fixtureSuite(test, assert, 'self-model', 'self-model', validateSelfModel);

test('self-model: generated index validates and lists every v1 and v2 contract', () => {
  const m = generateSelfModel();
  assert.equal(validateSelfModel(m).valid, true);
  assert.deepEqual(m.contracts.map((c) => `${c.name}@${c.version}`), [
    'capability-manifest@v1', 'extension-request@v1', 'grant@v1', 'run-journal-entry@v1', 'self-model@v1', 'task-spec@v1',
    'capability-manifest@v2', 'capability-scopes@v2', 'grant@v2', 'trust-registry@v2',
  ]);
  assert.ok(m.modules.some((x) => x.name === 'journal'));
});

// Which contracts each ADR covers. An ADR may cover several; every contract needs at least one ADR.
const ADR_COVERAGE = {
  'ADR-0001': ['capability-manifest@v1'],
  'ADR-0002': ['extension-request@v1'],
  'ADR-0003': ['run-journal-entry@v1'],
  'ADR-0004': ['grant@v1'],
  'ADR-0005': ['self-model@v1'],
  'ADR-0006': ['task-spec@v1'],
  'ADR-0007': ['capability-manifest@v2', 'grant@v2', 'trust-registry@v2', 'capability-scopes@v2'],
};

test('self-model: every contract is covered by at least one ADR in the index, and every mapped ADR is in the index', () => {
  const m = generateSelfModel();
  const adrIds = new Set(m.adrs.map((a) => a.id));
  for (const id of Object.keys(ADR_COVERAGE)) assert.ok(adrIds.has(id), `${id} is in the coverage map but not in the index`);
  const covered = new Set(Object.entries(ADR_COVERAGE).filter(([id]) => adrIds.has(id)).flatMap(([, cs]) => cs));
  for (const c of m.contracts) assert.ok(covered.has(`${c.name}@${c.version}`), `${c.name}@${c.version} is not covered by any ADR`);
});

test('self-model: generation is deterministic and committed self-model.json is current', () => {
  assert.equal(serialize(generateSelfModel()), serialize(generateSelfModel()));
  assert.equal(readFileSync(join(REPO_ROOT, 'self-model.json'), 'utf8'), serialize(generateSelfModel()));
});
