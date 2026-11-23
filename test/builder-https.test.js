import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError, checkBaseUrl } from '../src/builder-config.js';
import { runBuilder, EXIT } from '../src/builder-adapter.js';
import { tempRepo, makeGrant, FAKE_KEY } from './builder-mock.js';

const load = (url, extra = {}) => loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_BASE_URL: url, ...extra }, cwd: tmpdir() });

test('https: non-https, non-loopback base URLs are refused at config load', () => {
  for (const url of ['http://openrouter.ai/api/v1', 'http://example.com', 'http://10.0.0.5:8080/v1', 'http://127.0.0.1.evil.com/v1', 'http://localhost.evil.com/v1', 'ftp://x/v1', 'ws://localhost/v1', 'http://0.0.0.0/v1', 'http://127.0.0.2/v1']) {
    assert.throws(() => load(url), ConfigError, url);
  }
  assert.throws(() => load('http://example.com', { AGENT_BUILDER_MODEL: 'x/y:free' }), /https/);
});

test('https: the loopback exception is explicit (127.0.0.1, ::1, localhost) and https is always fine', () => {
  for (const url of ['http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1', 'http://localhost:1234/v1', 'http://LOCALHOST/v1']) {
    assert.equal(load(url).base_url, url.replace(/\/+$/, ''), url);
    assert.equal(checkBaseUrl(url).loopback, true);
  }
  assert.equal(load('https://openrouter.ai/api/v1').base_url, 'https://openrouter.ai/api/v1');
  assert.equal(checkBaseUrl('https://example.com').ok, true);
  assert.equal(load('https://example.com/v1', { AGENT_BUILDER_MODEL: 'x/y:free' }).model, 'x/y:free');
});

test('https: the adapter re-checks a hand-built config and refuses before any request', async () => {
  const dir = tempRepo();
  let calls = 0;
  const config = { ...load('https://openrouter.ai/api/v1'), base_url: 'http://example.com/v1' };
  Object.defineProperty(config, 'apiKey', { value: FAKE_KEY });
  const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant(), workdir: dir } }, { fetch: async () => { calls += 1; throw new Error('must not be called'); } });
  assert.equal(calls, 0);
  assert.equal(result.exit_code, EXIT.REFUSED);
  assert.ok(result.entries.some((e) => e.kind === 'attempt' && e.outcome === 'blocked' && /https/.test(e.reason)));
});

test('https: requests refuse to follow redirects (the Bearer key must not move hosts)', async () => {
  const dir = tempRepo();
  let init;
  const config = load('https://openrouter.ai/api/v1');
  await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant(), workdir: dir } }, { fetch: async (_u, i) => { init = i; throw new Error('stop'); } });
  assert.equal(init.redirect, 'error');
});
