import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson, definitionHash, tierForEffect, minTrustLevel, loadScopeVocabulary, validateManifestV2, validateGrantV2,
  validateRegistryV2, detectDrift, checkCapabilityAllowed, DEFAULT_VOCABULARY_PATH,
} from '../src/capability-v2.js';
import { loadFixtures } from './helpers.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const fx = (dir, name) => clone(loadFixtures(dir, 'valid').find((f) => f.file === `${name}.json`).data);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---- canonicalJson ----
test('canonicalJson: keys sorted at every depth, arrays keep order, no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } }), '{"a":{"c":null,"d":[3,1,2]},"b":1}');
  assert.equal(canonicalJson([{ b: 1, a: 2 }, 'x', true, null, 0, 1.5]), '[{"a":2,"b":1},"x",true,null,0,1.5]');
  assert.equal(canonicalJson('a"b'), '"a\\"b"');
});

test('canonicalJson: keys sort by UTF-16 code unit, not by code point', () => {
  // U+1F600 is the surrogate pair D83D DE00; its first unit D83D sorts BEFORE U+FFFF. By code point it would sort after.
  assert.equal(canonicalJson({ '￿': 1, '\u{1F600}': 2 }), '{"\u{1F600}":2,"￿":1}');
  assert.equal(canonicalJson({ b: 1, B: 2, a: 3 }), '{"B":2,"a":3,"b":1}');
});

test('canonicalJson: throws TypeError on values JSON cannot carry faithfully', () => {
  const cyc = {}; cyc.self = cyc;
  const cycArr = []; cycArr.push(cycArr);
  const bad = [undefined, () => 1, Symbol('x'), NaN, Infinity, -Infinity, -0, 10n, cyc, cycArr, { a: undefined }, [undefined], new Date(0), new Map(), Object.create({ inherited: 1 })];
  for (const v of bad) assert.throws(() => canonicalJson(v), TypeError, String(typeof v));
});

test('canonicalJson: a shared (non-cyclic) object appearing twice is fine', () => {
  const shared = { k: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
  assert.equal(canonicalJson(Object.assign(Object.create(null), { z: 1, y: 2 })), '{"y":2,"z":1}');
});

// ---- definitionHash ----
const TD = { name: 'search', description: 'Search.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer' } } }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };

test('definitionHash: known vectors (lowercase hex sha256 of the canonical UTF-8 bytes)', () => {
  assert.equal(definitionHash({ a: 1 }), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  assert.equal(definitionHash({ b: { c: null }, a: [1, 2] }), 'c86ec83bbcf2cd79e5cc99ee36d5726e7f66bcc6f7b8b83d0b5e6e53ce6302d6');
  assert.equal(definitionHash(TD), sha(canonicalJson(TD)));
  assert.match(definitionHash(TD), /^[0-9a-f]{64}$/);
  assert.equal(definitionHash({ t: 'é' }), sha('{"t":"é"}'), 'non-ASCII is hashed as UTF-8');
});

test('definitionHash: top-level and nested key order do not matter', () => {
  const shuffled = { annotations: { readOnlyHint: true }, outputSchema: { type: 'object' }, inputSchema: { properties: { n: { type: 'integer' }, q: { type: 'string' } }, type: 'object' }, description: 'Search.', name: 'search' };
  assert.equal(definitionHash(shuffled), definitionHash(TD));
});

test('definitionHash: any change to name, description, inputSchema, outputSchema or annotations changes the hash', () => {
  const base = definitionHash(TD);
  const variants = [
    { ...TD, name: 'search2' },
    { ...TD, description: 'Search!' },
    { ...TD, inputSchema: { ...TD.inputSchema, required: ['q'] } },
    { ...TD, inputSchema: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } } } },
    { ...TD, outputSchema: { type: 'array' } },
    { ...TD, annotations: { readOnlyHint: false } },
    (() => { const { annotations, ...rest } = TD; return rest; })(),
    (() => { const { outputSchema, ...rest } = TD; return rest; })(),
  ];
  const seen = new Set([base]);
  for (const v of variants) { const h = definitionHash(v); assert.ok(!seen.has(h), JSON.stringify(v)); seen.add(h); }
});

test('definitionHash: throws what canonicalJson throws', () => {
  assert.throws(() => definitionHash(undefined), TypeError);
  assert.throws(() => definitionHash({ a: NaN }), TypeError);
});

// ---- tierForEffect / minTrustLevel ----
test('tierForEffect and minTrustLevel follow the mapping', () => {
  assert.deepEqual(['read', 'write_reversible', 'write_irreversible', 'money'].map(tierForEffect), ['low', 'medium', 'high', 'payments']);
  for (const bad of ['', 'nope', 'toString', '__proto__', undefined, null, 5, {}]) assert.equal(tierForEffect(bad), null, String(bad));
  const m = (effect, credentials = []) => ({ effect, credentials });
  assert.equal(minTrustLevel(m('read')), 0);
  assert.equal(minTrustLevel(m('read', ['a.token'])), 1, 'credentials raise 0 to 1');
  assert.equal(minTrustLevel(m('write_reversible')), 1);
  assert.equal(minTrustLevel(m('write_reversible', ['a.token'])), 1);
  assert.equal(minTrustLevel(m('write_irreversible')), 2);
  assert.equal(minTrustLevel(m('money', ['a.token'])), 2);
  for (const bad of [null, undefined, 5, 'x', {}, { effect: 'nope' }, { effect: 'toString' }]) assert.equal(minTrustLevel(bad), Infinity);
});

// ---- loadScopeVocabulary ----
test('loadScopeVocabulary: valid file loads; missing, malformed and invalid files throw an error naming the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capv2-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ schema_version: '2', scopes: ['repo:read:task-worktree'] }));
    assert.deepEqual(loadScopeVocabulary(good), ['repo:read:task-worktree']);
    const missing = join(dir, 'missing.json');
    assert.throws(() => loadScopeVocabulary(missing), (e) => e instanceof Error && e.message.includes(missing));
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{ not json');
    assert.throws(() => loadScopeVocabulary(malformed), (e) => e.message.includes(malformed));
    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ schema_version: '2', scopes: ['repo:read'] }));
    assert.throws(() => loadScopeVocabulary(invalid), (e) => e.message.includes(invalid) && /pattern/.test(e.message));
    const dup = join(dir, 'dup.json');
    writeFileSync(dup, JSON.stringify({ schema_version: '2', scopes: ['a:b:c', 'a:b:c'] }));
    assert.throws(() => loadScopeVocabulary(dup), (e) => e.message.includes(dup));
    assert.throws(() => loadScopeVocabulary(dir), (e) => e.message.includes(dir), 'a directory is unreadable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadScopeVocabulary: the default path is config/capability-scopes.json in the repo (not created by this task)', () => {
  assert.match(DEFAULT_VOCABULARY_PATH.replace(/\\/g, '/'), /\/config\/capability-scopes\.json$/);
});

// ---- validateManifestV2 ----
const VOCAB = ['repo:read:task-worktree', 'repo:write:task-worktree', 'repo:commit:task-branch', 'payments:draft:proposal', 'mail:draft:outbox'];

test('validateManifestV2: every valid fixture passes with the vocabulary (array and Set), including the real hashes', () => {
  for (const { file, data } of loadFixtures('capability-manifest-v2', 'valid')) {
    for (const vocabulary of [VOCAB, new Set(VOCAB)]) {
      const r = validateManifestV2(data, { vocabulary });
      assert.equal(r.valid, true, `${file}: ${r.errors.join('; ')}`);
    }
  }
});

test('validateManifestV2: schema-invalid fixtures are rejected', () => {
  for (const { file, data } of loadFixtures('capability-manifest-v2', 'invalid')) assert.equal(validateManifestV2(data, { vocabulary: VOCAB }).valid, false, file);
});

test('validateManifestV2: definition_hash must equal the hash of tool_definition', () => {
  const m = fx('capability-manifest-v2', 'mcp-read');
  m.definition_hash = '0'.repeat(64);
  const r = validateManifestV2(m, { vocabulary: VOCAB });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /definition_hash does not equal/.test(e)), r.errors.join('; '));
  const m2 = fx('capability-manifest-v2', 'mcp-read');
  m2.tool_definition.description += ' (changed after pinning)';
  assert.equal(validateManifestV2(m2, { vocabulary: VOCAB }).valid, false);
});

test('validateManifestV2: name must equal <server_id>.<tool_definition.name>; an empty tool name is rejected', () => {
  const m = fx('capability-manifest-v2', 'mcp-read');
  m.name = 'other-server.search';
  const r = validateManifestV2(m, { vocabulary: VOCAB });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /\/name must equal/.test(e)), r.errors.join('; '));
  const e = fx('capability-manifest-v2', 'mcp-read');
  e.tool_definition.name = '';
  const r2 = validateManifestV2(e, { vocabulary: VOCAB });
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some((x) => /tool_definition\/name/.test(x)), r2.errors.join('; '));
});

test('validateManifestV2: a scope outside the vocabulary is rejected and named', () => {
  const m = fx('capability-manifest-v2', 'builtin-read');
  const r = validateManifestV2(m, { vocabulary: ['repo:write:task-worktree'] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('repo:read:task-worktree') && /vocabulary/.test(e)));
  assert.equal(validateManifestV2(m, { vocabulary: [] }).valid, false, 'an empty vocabulary admits nothing');
  assert.equal(validateManifestV2(m, { vocabulary: 'repo:read:task-worktree' }).valid, false, 'a string is not a vocabulary');
});

test('validateManifestV2: with no vocabulary it needs the default file; absent file gives invalid with a reason, never a throw', () => {
  const m = fx('capability-manifest-v2', 'builtin-read');
  let r;
  assert.doesNotThrow(() => { r = validateManifestV2(m); });
  assert.equal(typeof r.valid, 'boolean');
  if (!existsSync(DEFAULT_VOCABULARY_PATH)) {
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes(DEFAULT_VOCABULARY_PATH)), r.errors.join('; '));
  } else {
    assert.ok(Array.isArray(r.errors)); // Kevin installed the vocabulary; the result then depends on its content
  }
});

test('v2 validators never throw on malformed input', () => {
  const junk = [undefined, null, 0, 'x', [], {}, [1], { schema_version: '2' }, () => 1, Symbol('s'), 10n, NaN, { a: 1n }];
  for (const j of junk) {
    assert.doesNotThrow(() => {
      assert.equal(validateManifestV2(j, { vocabulary: VOCAB }).valid, false);
      assert.equal(validateGrantV2(j).valid, false);
      assert.equal(validateRegistryV2(j).valid, false);
      assert.equal(typeof detectDrift('x', j).drifted, 'boolean');
      assert.equal(checkCapabilityAllowed({ grant: j, manifest: j, registry: j, now: new Date() }).allowed, false);
    });
  }
  assert.equal(checkCapabilityAllowed().allowed, false);
  assert.equal(checkCapabilityAllowed(null).allowed, false);
});

// ---- validateGrantV2 / validateRegistryV2 ----
test('validateGrantV2: fixtures behave; duplicate capability names are rejected', () => {
  for (const { file, data } of loadFixtures('grant-v2', 'valid')) assert.equal(validateGrantV2(data).valid, true, file);
  for (const { file, data } of loadFixtures('grant-v2', 'invalid')) assert.equal(validateGrantV2(data).valid, false, file);
  const g = fx('grant-v2', 'two-capabilities');
  g.capabilities.push({ ...g.capabilities[0], max_calls: 9 });
  const r = validateGrantV2(g);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /listed twice/.test(e) && e.includes(g.capabilities[0].name)));
});

test('validateRegistryV2: fixtures behave; two entries with the same (server_id, pinned_commit, definition_hash) are rejected', () => {
  for (const { file, data } of loadFixtures('trust-registry-v2', 'valid')) assert.equal(validateRegistryV2(data).valid, true, file);
  for (const { file, data } of loadFixtures('trust-registry-v2', 'invalid')) assert.equal(validateRegistryV2(data).valid, false, file);
  const reg = fx('trust-registry-v2', 'one-entry');
  const e = reg.entries[0];
  const dupe = { ...reg, entries: [e, { ...e, trust_level: 2, approved_by: 'someone' }] };
  const r = validateRegistryV2(dupe);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((x) => /duplicates/.test(x)));
  const other = { ...reg, entries: [e, { ...e, pinned_commit: 'f'.repeat(40) }, { ...e, definition_hash: 'e'.repeat(64) }] };
  assert.equal(validateRegistryV2(other).valid, true, 'a different commit or hash is a different entry');
});

// ---- detectDrift ----
test('detectDrift: same definition is not drift, any change is, and an unhashable one fails closed', () => {
  const pinned = definitionHash(TD);
  assert.deepEqual(detectDrift(pinned, clone(TD)), { drifted: false, liveHash: pinned });
  const changed = { ...TD, description: 'Search, and also send email.' };
  assert.deepEqual(detectDrift(pinned, changed), { drifted: true, liveHash: definitionHash(changed) });
  assert.deepEqual(detectDrift(pinned, undefined), { drifted: true, liveHash: null });
  assert.equal(detectDrift(undefined, TD).drifted, true);
  assert.equal(detectDrift(pinned.toUpperCase(), TD).drifted, true, 'the pinned hash must be lowercase hex');
});

// ---- checkCapabilityAllowed ----
const NOW = new Date('2029-06-01T00:00:00Z'); // the fixtures' grants expire 2030-01-01
function world() {
  const manifest = fx('capability-manifest-v2', 'mcp-write-reversible-credential'); // level 1, credential tracker.token, tier medium
  const grant = fx('grant-v2', 'two-capabilities'); // lists docs-search.search and issue-tracker.create_issue; tiers low, medium
  const registry = {
    schema_version: '2',
    entries: [{ server_id: 'issue-tracker', pinned_commit: manifest.origin.pinned_commit, definition_hash: manifest.definition_hash, trust_level: 1, approved_scopes: [...manifest.scopes], credential_refs: [...manifest.credentials], approved_by: 'kevin', approved_on: '2026-11-27' }],
  };
  return { grant, manifest, registry, now: NOW, vocabulary: VOCAB };
}
const denied = (args, code) => {
  const r = checkCapabilityAllowed(args);
  assert.equal(r.allowed, false, `expected denial ${code}, got ${r.reason}`);
  assert.ok(r.reason.startsWith(`${code}:`), `expected ${code}, got ${r.reason}`);
};

test('checkCapabilityAllowed: allows an mcp write capability when grant, manifest and registry all agree', () => {
  const r = checkCapabilityAllowed(world());
  assert.equal(r.allowed, true, r.reason);
});

test('checkCapabilityAllowed: allows an mcp read capability at level 0 with no credentials', () => {
  const manifest = fx('capability-manifest-v2', 'mcp-read');
  const w = world();
  w.manifest = manifest;
  w.registry.entries = [{ server_id: 'docs-search', pinned_commit: manifest.origin.pinned_commit, definition_hash: manifest.definition_hash, trust_level: 0, approved_scopes: manifest.scopes, credential_refs: [], approved_by: 'kevin', approved_on: '2026-11-27' }];
  assert.equal(checkCapabilityAllowed(w).allowed, true);
});

test('checkCapabilityAllowed: denial 1a, invalid grant', () => {
  const w = world(); delete w.grant.capabilities;
  denied(w, 'grant_invalid');
  const d = world(); d.grant.capabilities.push({ ...d.grant.capabilities[0] });
  denied(d, 'grant_invalid');
});

test('checkCapabilityAllowed: denial 1b, invalid manifest (schema, hash, name, scope vocabulary)', () => {
  const a = world(); a.manifest.effect = 'money';
  denied(a, 'manifest_invalid');
  const b = world(); b.manifest.tool_definition.description = 'tampered';
  denied(b, 'manifest_invalid');
  const c = world(); c.manifest.name = 'issue-tracker.other';
  denied(c, 'manifest_invalid');
  const d = world(); d.vocabulary = ['repo:read:task-worktree'];
  denied(d, 'manifest_invalid');
});

test('checkCapabilityAllowed: denial 2, expired grant, and a missing or bad `now` (no default clock)', () => {
  const w = world(); w.now = new Date('2030-01-01T00:00:00Z'); // exactly at expires_at is expired
  denied(w, 'grant_expired');
  const late = world(); late.now = new Date('2031-01-01T00:00:00Z');
  denied(late, 'grant_expired');
  for (const bad of [undefined, null, '2029-06-01', 1.9e12, new Date('nope'), {}]) { const x = world(); x.now = bad; denied(x, 'now_invalid'); }
  const just = world(); just.now = new Date('2029-12-31T23:59:59.999Z');
  assert.equal(checkCapabilityAllowed(just).allowed, true);
});

test('checkCapabilityAllowed: denial 3a, capability not listed in the grant', () => {
  const w = world(); w.grant.capabilities = [];
  denied(w, 'capability_not_granted');
});

test('checkCapabilityAllowed: denial 3b, grant pins a different hash than the manifest', () => {
  const w = world(); w.grant.capabilities.find((c) => c.name === w.manifest.name).definition_hash = 'd'.repeat(64);
  denied(w, 'hash_mismatch');
});

test('checkCapabilityAllowed: builtin manifest without a hash is matched on the hash of the manifest itself (minus definition_hash)', () => {
  const manifest = fx('capability-manifest-v2', 'builtin-read');
  const grant = fx('grant-v2', 'empty-capabilities');
  grant.capabilities = [{ name: manifest.name, definition_hash: definitionHash(manifest), max_calls: 3 }];
  const args = { grant, manifest, registry: { schema_version: '2', entries: [] }, now: NOW, vocabulary: VOCAB };
  assert.equal(checkCapabilityAllowed(args).allowed, true, 'a builtin manifest needs no registry entry');
  const withHash = { ...manifest, definition_hash: definitionHash(manifest) }; // the field is ignored when computing the expected value
  assert.equal(checkCapabilityAllowed({ ...args, manifest: withHash }).allowed, true);
  const changed = { ...manifest, version: '1.0.1' };
  denied({ ...args, manifest: changed }, 'hash_mismatch');
});

test('checkCapabilityAllowed: denial 4, risk tier not in the grant', () => {
  const w = world(); w.grant.allowed_risk_tiers = ['low'];
  denied(w, 'tier_not_allowed');
});

test('checkCapabilityAllowed: denial 5, registry absent, empty, wrong commit or wrong hash, or invalid', () => {
  const a = world(); delete a.registry;
  denied(a, 'registry_absent');
  const b = world(); b.registry.entries = [];
  denied(b, 'registry_absent');
  const c = world(); c.registry.entries[0].pinned_commit = 'c'.repeat(40);
  denied(c, 'registry_absent');
  const d = world(); d.registry.entries[0].definition_hash = 'c'.repeat(64);
  denied(d, 'registry_absent');
  const e = world(); e.registry.entries[0].server_id = 'someone-else';
  denied(e, 'registry_absent');
  const f = world(); f.registry.entries[0].trust_level = 9;
  denied(f, 'registry_absent');
});

test('checkCapabilityAllowed: denial 6, trust level too low (effect and credential rules)', () => {
  const a = world(); a.registry.entries[0].trust_level = 0; // write_reversible needs 1
  denied(a, 'trust_level_too_low');
  const manifest = fx('capability-manifest-v2', 'mcp-read');
  manifest.credentials = ['docs.token']; // read with a credential needs 1
  const grant = fx('grant-v2', 'two-capabilities');
  const td = manifest.tool_definition;
  grant.capabilities = [{ name: manifest.name, definition_hash: definitionHash(td), max_calls: 1 }];
  const registry = { schema_version: '2', entries: [{ server_id: 'docs-search', pinned_commit: manifest.origin.pinned_commit, definition_hash: manifest.definition_hash, trust_level: 0, approved_scopes: manifest.scopes, credential_refs: ['docs.token'], approved_by: 'kevin', approved_on: '2026-11-27' }] };
  denied({ grant, manifest, registry, now: NOW, vocabulary: VOCAB }, 'trust_level_too_low');
  registry.entries[0].trust_level = 1;
  assert.equal(checkCapabilityAllowed({ grant, manifest, registry, now: NOW, vocabulary: VOCAB }).allowed, true);
});

test('checkCapabilityAllowed: denial 7, scope not approved', () => {
  const w = world(); w.registry.entries[0].approved_scopes = ['repo:read:task-worktree'];
  denied(w, 'scope_not_approved');
  const none = world(); none.registry.entries[0].approved_scopes = [];
  denied(none, 'scope_not_approved');
});

test('checkCapabilityAllowed: denial 8, credential not approved', () => {
  const w = world(); w.registry.entries[0].credential_refs = [];
  denied(w, 'credential_not_approved');
  const other = world(); other.registry.entries[0].credential_refs = ['another.token'];
  denied(other, 'credential_not_approved');
});

test('checkCapabilityAllowed: checks run in the documented order (the first failure is the one reported)', () => {
  const w = world();
  w.registry = undefined; w.grant.allowed_risk_tiers = ['low']; w.grant.capabilities[1].definition_hash = 'd'.repeat(64); w.now = new Date('2031-01-01T00:00:00Z');
  denied(w, 'grant_expired');
  w.now = NOW; denied(w, 'hash_mismatch');
  w.grant.capabilities[1].definition_hash = w.manifest.definition_hash; denied(w, 'tier_not_allowed');
  w.grant.allowed_risk_tiers = ['medium']; denied(w, 'registry_absent');
  w.grant.capabilities = []; denied(w, 'capability_not_granted');
  w.grant = undefined; denied(w, 'grant_invalid');
});

test('checkCapabilityAllowed: inputs are not mutated', () => {
  const w = world();
  const before = canonicalJson({ grant: w.grant, manifest: w.manifest, registry: w.registry });
  checkCapabilityAllowed(w);
  assert.equal(canonicalJson({ grant: w.grant, manifest: w.manifest, registry: w.registry }), before);
});

// ---- fix round 1, item 1: the vocabulary is required and cannot be skipped ----
test('checkCapabilityAllowed: a missing or non-collection vocabulary denies first, before any other check', () => {
  for (const bad of [undefined, null, 'repo:read:task-worktree', 5, {}, { has: () => true }, true]) {
    denied({ ...world(), vocabulary: bad }, 'vocabulary_missing');
  }
  const w = world(); delete w.vocabulary;
  denied(w, 'vocabulary_missing');
  // first even when the grant is invalid, the clock is bad and the registry is absent
  denied({ grant: undefined, manifest: undefined, registry: undefined, now: undefined }, 'vocabulary_missing');
  assert.equal(checkCapabilityAllowed({ ...world(), vocabulary: new Set(VOCAB) }).allowed, true, 'a Set works');
  assert.equal(checkCapabilityAllowed({ ...world(), vocabulary: [] }).allowed, false, 'an empty vocabulary admits nothing');
});

test('checkCapabilityAllowed: a scope outside the vocabulary is denied for mcp origin even when the registry entry approves it', () => {
  const w = world();
  assert.ok(w.registry.entries[0].approved_scopes.includes('repo:write:task-worktree'), 'the registry approves the scope');
  w.vocabulary = ['repo:read:task-worktree'];
  denied(w, 'manifest_invalid');
  assert.match(checkCapabilityAllowed(w).reason, /repo:write:task-worktree/);
});

test('checkCapabilityAllowed: a scope outside the vocabulary is denied for builtin origin too', () => {
  const manifest = fx('capability-manifest-v2', 'builtin-read');
  const grant = fx('grant-v2', 'empty-capabilities');
  grant.capabilities = [{ name: manifest.name, definition_hash: definitionHash(manifest), max_calls: 3 }];
  const args = { grant, manifest, registry: { schema_version: '2', entries: [] }, now: NOW };
  assert.equal(checkCapabilityAllowed({ ...args, vocabulary: VOCAB }).allowed, true);
  denied({ ...args, vocabulary: ['repo:write:task-worktree'] }, 'manifest_invalid');
});
