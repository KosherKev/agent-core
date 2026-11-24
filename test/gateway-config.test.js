import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, loadConfig, agentHome, defaultConfig, CONFIG_VERSION } from '../src/gateway/config.js';
import { runInit } from '../src/gateway/init.js';

const good = () => defaultConfig({ gatewayUid: 10, runnerUid: 20 });

test('AGENT_HOME comes from the environment, else ~/.agent under the real home', () => {
  assert.equal(agentHome({ AGENT_HOME: '/some/where' }), '/some/where');
  assert.match(agentHome({}), /\.agent$/);
});

test('a valid config resolves relative paths under home and is frozen', () => {
  const r = validateConfig(good(), '/h');
  assert.ok(r.valid, r.errors.join());
  assert.equal(r.config.socket_path, '/h/gateway.sock');
  assert.equal(r.config.config_version, CONFIG_VERSION);
  assert.ok(Object.isFrozen(r.config));
});

test('unknown version is refused', () => {
  for (const v of [2, 0, '1', undefined, null]) {
    const r = validateConfig({ ...good(), config_version: v }, '/h');
    assert.equal(r.valid, false, String(v));
    assert.match(r.errors[0], /config_version/);
  }
});

test('unknown keys are refused at every level', () => {
  assert.equal(validateConfig({ ...good(), extra: 1 }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), identities: { gateway_uid: 1, runner_uid: 2, root: 0 } }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), providers: { p: { base_url: 'https://x.example/v1', api_key: 'no' } } }, '/h').valid, false);
});

test('bad uids, bad paths, bad provider names and non-https base urls are refused', () => {
  assert.equal(validateConfig({ ...good(), allowed_peer_uids: [-1] }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), allowed_peer_uids: ['501'] }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), socket_path: '' }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), providers: { 'Bad Name': { base_url: 'https://x.example' } } }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), providers: { p: { base_url: 'http://example.com/v1' } } }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), providers: { p: { base_url: 'https://u:p@example.com/v1' } } }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), providers: { p: { base_url: 'http://127.0.0.1:1/v1' } } }, '/h').valid, true);
  assert.equal(validateConfig([], '/h').valid, false);
  assert.equal(validateConfig(null, '/h').valid, false);
});

test('loadConfig never throws: missing and non-JSON files give valid:false', () => {
  const home = mkdtempSync(join(tmpdir(), 'gw-cfg-'));
  assert.equal(loadConfig(home).valid, false);
  writeFileSync(join(home, 'config.json'), '{nope');
  assert.equal(loadConfig(home).valid, false);
});

test('init creates home, directories (0700) and config (0600), and never overwrites', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'gw-init-')), 'ah');
  const a = runInit({ home });
  assert.ok(a.made.length >= 4);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'ledger')).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.ok(loadConfig(home).valid);
  writeFileSync(join(home, 'config.json'), '{"marker":true}', { mode: 0o600 });
  const b = runInit({ home });
  assert.equal(b.made.length, 0);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{"marker":true}');
  assert.ok(existsSync(join(home, 'ledger')));
});
