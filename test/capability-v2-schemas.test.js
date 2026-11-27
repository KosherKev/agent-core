import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifestV2Schema, validateGrantV2Schema, validateTrustRegistryV2Schema, validateScopesV2Schema, schemas } from '../src/validators.js';
import { fixtureSuite, loadFixtures } from './helpers.js';

// v2 fixtures are iterated here, not by acceptance/contracts.test.js (locked; it hardcodes the v1 names).
fixtureSuite(test, assert, 'capability-manifest-v2', 'manifest v2', validateManifestV2Schema);
fixtureSuite(test, assert, 'grant-v2', 'grant v2', validateGrantV2Schema);
fixtureSuite(test, assert, 'trust-registry-v2', 'registry v2', validateTrustRegistryV2Schema);
fixtureSuite(test, assert, 'capability-scopes-v2', 'scopes v2', validateScopesV2Schema);

// Each invalid fixture must be rejected FOR ITS REASON: some error text must match the offending path or keyword.
const REASONS = {
  'capability-manifest-v2': {
    'effect-tier-mismatch': /risk_tier/,
    'money-execute': /\/mode/,
    'write-irreversible-execute': /\/mode/,
    'scope-not-three-part': /\/scopes\/0 .*pattern/,
    'not-applicable-with-write': /\/effect/,
    'mcp-missing-pinned-commit': /pinned_commit/,
    'short-commit-sha': /\/origin\/pinned_commit .*pattern/,
    'bad-hash': /\/definition_hash .*pattern/,
    'unknown-extra-field': /additional properties/,
    'allowlist-no-hosts': /hosts/,
    'allowlist-empty-hosts': /\/network\/hosts .*fewer than 1/,
    'none-with-hosts': /additional properties|must NOT/,
    'mcp-without-tool-definition': /tool_definition/,
    'mcp-without-definition-hash': /definition_hash/,
    'undo-empty': /\/undo must match a schema in anyOf/,
    'server-id-with-dot': /server_id/,
    'source-url-not-https': /source_url/,
    'v1-schema-version': /schema_version/,
    'duplicate-scopes': /\/scopes must NOT have duplicate items/,
    'tool-definition-extra-key': /additional properties/,
    'mcp-server-prefix-uppercase': /\/name .*pattern/,
    'builtin-uppercase-name': /\/name .*pattern/,
    'mcp-name-with-space': /\/name .*pattern/,
  },
  'grant-v2': {
    'missing-capabilities': /capabilities/,
    'max-calls-zero': /max_calls .*>= 1/,
    'bad-hash': /definition_hash .*pattern/,
    'v1-schema-version': /schema_version/,
    'wildcard-name': /\/capabilities\/0\/name .*pattern/,
    'extra-field-on-capability': /additional properties/,
    'server-prefix-uppercase': /\/capabilities\/0\/name .*pattern/,
    'capability-name-with-space': /\/capabilities\/0\/name .*pattern/,
  },
  'trust-registry-v2': {
    'trust-level-3': /trust_level .*allowed values/,
    'bad-date': /approved_on .*format/,
    'missing-approved-by': /approved_by/,
    'short-commit': /pinned_commit .*pattern/,
  },
  'capability-scopes-v2': {
    'duplicate-entry': /duplicate items/,
    'bad-pattern': /\/scopes\/0 .*pattern/,
    'uppercase': /\/scopes\/0 .*pattern/,
  },
};
const FN = { 'capability-manifest-v2': validateManifestV2Schema, 'grant-v2': validateGrantV2Schema, 'trust-registry-v2': validateTrustRegistryV2Schema, 'capability-scopes-v2': validateScopesV2Schema };

for (const [dir, table] of Object.entries(REASONS)) {
  test(`${dir}: every invalid fixture has a named reason and is rejected for it`, () => {
    const files = loadFixtures(dir, 'invalid').map((f) => f.file.replace(/\.json$/, '')).sort();
    assert.deepEqual(files, Object.keys(table).sort(), 'the reason table must cover exactly the invalid fixtures');
    for (const { file, data } of loadFixtures(dir, 'invalid')) {
      const r = FN[dir](data);
      assert.equal(r.valid, false, file);
      const re = table[file.replace(/\.json$/, '')];
      assert.ok(r.errors.some((e) => re.test(e)), `${file}: no error matches ${re}; got ${r.errors.join(' | ')}`);
    }
  });
}

test('manifest v2: the required minimum invalid cases all exist', () => {
  const have = new Set(loadFixtures('capability-manifest-v2', 'invalid').map((f) => f.file));
  for (const n of ['effect-tier-mismatch', 'money-execute', 'write-irreversible-execute', 'scope-not-three-part', 'not-applicable-with-write', 'mcp-missing-pinned-commit', 'short-commit-sha', 'bad-hash', 'unknown-extra-field', 'allowlist-no-hosts', 'none-with-hosts', 'mcp-without-tool-definition', 'undo-empty']) assert.ok(have.has(`${n}.json`), n);
});

test('manifest v2: every effect/tier pair, and draft-only for irreversible and money, is enforced by the schema', () => {
  const base = loadFixtures('capability-manifest-v2', 'valid').find((f) => f.file === 'builtin-read.json').data;
  const tiers = { read: 'low', write_reversible: 'medium', write_irreversible: 'high', money: 'payments' };
  for (const [effect, tier] of Object.entries(tiers)) {
    for (const t of Object.values(tiers)) {
      for (const mode of ['execute', 'draft']) {
        const m = { ...base, effect, risk_tier: t, mode, undo: { button_ref: 'b' } };
        const ok = t === tier && (mode === 'draft' || effect === 'read' || effect === 'write_reversible');
        assert.equal(validateManifestV2Schema(m).valid, ok, `${effect}/${t}/${mode}`);
      }
    }
  }
});

test('v2 schemas are registered under their $id and the v1 names are unchanged', () => {
  for (const n of ['capability-manifest-v2', 'grant-v2', 'trust-registry-v2', 'capability-scopes-v2']) assert.equal(schemas[n].$id, n);
  for (const n of ['capability-manifest', 'extension-request', 'grant', 'run-journal-entry', 'self-model', 'task-spec']) assert.equal(schemas[n].$id, n);
});
