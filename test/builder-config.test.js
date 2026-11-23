import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, DEFAULTS } from '../src/builder-config.js';
import { makeRedactor, redactError } from '../src/builder-redact.js';

const FAKE_KEY = 'sk-or-FAKE-test-key-0000000000';
const withDir = (fn) => { const d = mkdtempSync(join(tmpdir(), 'bcfg-')); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('config: defaults', () => withDir((cwd) => {
  const c = loadConfig({ env: {}, cwd });
  assert.equal(c.model, 'particle-ai/particle-1:free');
  assert.equal(c.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(c.role, 'builder');
  assert.deepEqual(c.free_model_repo_allowlist, ['agent-core']);
  assert.deepEqual(c.provider, {});
  assert.equal(DEFAULTS.rate_limit.max_retries, 3);
}));

test('config: rejects role overseer with a clear error', () => withDir((cwd) => {
  assert.throws(() => loadConfig({ env: { AGENT_BUILDER_ROLE: 'overseer' }, cwd }), (e) => e instanceof ConfigError && /overseer.*rejected.*R2/.test(e.message));
  writeFileSync(join(cwd, '.agent-builder.local.json'), JSON.stringify({ role: 'overseer' }));
  assert.throws(() => loadConfig({ env: {}, cwd }), /overseer/);
}));

test('config: rejects unknown and empty roles', () => withDir((cwd) => {
  assert.throws(() => loadConfig({ env: { AGENT_BUILDER_ROLE: 'admin' }, cwd }), /unknown role "admin"/);
  assert.throws(() => loadConfig({ env: { AGENT_BUILDER_ROLE: '' }, cwd }), /role/);
  writeFileSync(join(cwd, '.agent-builder.local.json'), JSON.stringify({ role: 7 }));
  assert.throws(() => loadConfig({ env: {}, cwd }), /role/);
}));

test('config: env overrides local file; provider prefs and allowlist pass through', () => withDir((cwd) => {
  writeFileSync(join(cwd, '.agent-builder.local.json'), JSON.stringify({ model: 'a/b', provider: { order: ['X'], allow_fallbacks: false, data_collection: 'deny' } }));
  const c = loadConfig({ env: { AGENT_BUILDER_MODEL: 'c/d:free', FREE_MODEL_REPO_ALLOWLIST: 'one, two' }, cwd });
  assert.equal(c.model, 'c/d:free');
  assert.deepEqual(c.provider, { order: ['X'], allow_fallbacks: false, data_collection: 'deny' });
  assert.deepEqual(c.free_model_repo_allowlist, ['one', 'two']);
}));

test('config: API key is env only, never in file, never enumerable', () => withDir((cwd) => {
  writeFileSync(join(cwd, '.agent-builder.local.json'), JSON.stringify({ api_key: FAKE_KEY }));
  assert.throws(() => loadConfig({ env: {}, cwd }), (e) => /environment only/.test(e.message) && !e.message.includes(FAKE_KEY));
  rmSync(join(cwd, '.agent-builder.local.json'));
  const c = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY }, cwd });
  assert.equal(c.apiKey, FAKE_KEY);
  assert.ok(!JSON.stringify(c).includes(FAKE_KEY));
  assert.ok(!JSON.stringify({ ...c }).includes(FAKE_KEY));
}));

test('config: rejects bad values', () => withDir((cwd) => {
  assert.throws(() => loadConfig({ env: { AGENT_BUILDER_BASE_URL: 'ftp://x' }, cwd }), /http/);
  assert.throws(() => loadConfig({ env: { AGENT_BUILDER_BASE_URL: 'http://u:p@x' }, cwd }), /credentials/);
  assert.throws(() => loadConfig({ env: { AGENT_BUILDER_DATA_COLLECTION: 'maybe' }, cwd }), /data_collection/);
  writeFileSync(join(cwd, '.agent-builder.local.json'), JSON.stringify({ rate_limit: { max_retries: 99 } }));
  assert.throws(() => loadConfig({ env: {}, cwd }), /max_retries/);
  writeFileSync(join(cwd, '.agent-builder.local.json'), JSON.stringify({ bogus: 1 }));
  assert.throws(() => loadConfig({ env: {}, cwd }), /unknown key/);
}));

test('redact: removes exact key and key-shaped strings from messages and stacks', () => {
  const r = makeRedactor(FAKE_KEY);
  assert.ok(!r(`boom ${FAKE_KEY} Bearer abcdefghijkl sk-or-zzzzzzzzzz`).match(/FAKE|abcdefghijkl|zzzzzzzzzz/));
  const e = redactError(new Error(`fetch failed for ${FAKE_KEY}`), r);
  assert.ok(!e.message.includes(FAKE_KEY) && !e.stack.includes(FAKE_KEY));
});
