import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateSelfModel } from '../src/validators.js';
import { generateSelfModel, serialize, REPO_ROOT } from '../src/self-model.js';
import { BUILDER_CAPABILITIES } from '../src/builder-capabilities.js';

const walk = (dir) => readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));

test('self-model: every .js file under src/ at any depth is indexed, sorted, with nested names', () => {
  const m = generateSelfModel();
  assert.deepEqual(m.modules.map((x) => x.path), walk('src').sort());
  for (const name of ['grant/meter', 'grant/money', 'ledger/ledger', 'ledger/lock', 'builder-adapter', 'journal']) assert.ok(m.modules.some((x) => x.name === name), name);
  for (const x of m.modules) assert.equal(x.path, `src/${x.name}.js`);
});

test('self-model: capabilities come from the exported manifests, only on the module that has them', () => {
  const m = generateSelfModel();
  const withCaps = m.modules.filter((x) => x.capabilities);
  assert.deepEqual(withCaps.map((x) => x.name), ['builder-capabilities']);
  assert.deepEqual(withCaps[0].capabilities.map((c) => c.name), BUILDER_CAPABILITIES.map((c) => c.name).sort());
  for (const c of withCaps[0].capabilities) assert.deepEqual(Object.keys(c).sort(), ['name', 'risk_tier', 'scopes', 'version']);
});

test('self-model: output is byte-identical across runs and the committed file is current', () => {
  assert.equal(serialize(generateSelfModel()), serialize(generateSelfModel()));
  assert.equal(readFileSync(join(REPO_ROOT, 'self-model.json'), 'utf8'), serialize(generateSelfModel()));
  assert.equal(validateSelfModel(generateSelfModel()).valid, true);
});

test('self-model: the pre-change self-model.json shape (no capabilities, top-level modules only) still validates', () => {
  const old = { schema_version: '1', modules: [{ name: 'journal', path: 'src/journal.js' }], contracts: [{ name: 'grant', version: 'v1', path: 'schemas/v1/grant.schema.json' }], adrs: [] };
  assert.equal(validateSelfModel(old).valid, true);
});
