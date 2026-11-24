import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, loadConfig, agentHome, defaultConfig, CONFIG_VERSION } from '../src/gateway/config.js';
import { runInit } from '../src/gateway/init.js';

const good = () => defaultConfig({ gatewayUid: 10, runnerUid: 20, socketDir: '/run/gw-test', runnerGroup: 'agent-runner' });

test('AGENT_HOME comes from the environment, else ~/.agent under the real home', () => {
  assert.equal(agentHome({ AGENT_HOME: '/some/where' }), '/some/where');
  assert.match(agentHome({}), /\.agent$/);
});

test('a valid config resolves relative paths under home and is frozen', () => {
  const r = validateConfig(good(), '/h');
  assert.ok(r.valid, r.errors.join());
  assert.equal(r.config.socket_path, '/run/gw-test/gateway.sock');
  assert.equal(r.config.ledger_dir, '/h/ledger');
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
  assert.equal(validateConfig({ ...good(), allowed_peer_uids: [501] }, '/h').valid, true, 'allowed_peer_uids is optional but valid when given');
  assert.equal(validateConfig({ ...good(), socket_dir: '' }, '/h').valid, false);
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
  const a = runInit({ home, socketDir: join(mkdtempSync(join(tmpdir(), 'gw-initsock-')), 'sd') });
  assert.ok(a.made.length >= 4);
  assert.ok(!a.made.some((p) => p.includes('initsock')), 'init does not create socket_dir');
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'ledger')).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.ok(loadConfig(home).valid);
  writeFileSync(join(home, 'config.json'), '{"marker":true}', { mode: 0o600 });
  const b = runInit({ home, socketDir: loadConfig(home).config?.socket_dir ?? '/run/x' });
  assert.equal(b.made.length, 0);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{"marker":true}');
  assert.ok(existsSync(join(home, 'ledger')));
});

test('new keys: socket_dir, runner_group and limits are validated, defaulted and bounded; config_version stays 1', () => {
  const ok = validateConfig(good(), '/h');
  assert.equal(ok.config.idle_timeout_ms, 30_000); assert.equal(ok.config.provider_timeout_ms, 120_000);
  assert.equal(ok.config.max_response_bytes, 8 * 1024 * 1024); assert.equal(ok.config.max_request_bytes, 1024 * 1024); assert.equal(ok.config.max_connections, 8);
  assert.equal(validateConfig({ ...good(), peer_uid_allowlist: [1] }, '/h').valid, false, 'unknown keys are still refused');
  assert.equal(validateConfig({ ...good(), idle_timeout_ms: 500, max_connections: 2 }, '/h').config.idle_timeout_ms, 500);
  for (const bad of [{ idle_timeout_ms: 0 }, { provider_timeout_ms: 1.5 }, { max_response_bytes: -1 }, { max_request_bytes: '1' }, { max_connections: 0 }, { max_connections: 100000 }]) assert.equal(validateConfig({ ...good(), ...bad }, '/h').valid, false, JSON.stringify(bad));
  const { runner_group, ...noGroup } = good(); assert.equal(validateConfig(noGroup, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), runner_group: 'bad name' }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), runner_group: 1000 }, '/h').valid, true);
  const { socket_dir, ...noDir } = good(); assert.equal(validateConfig(noDir, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), socket_dir: 'relative/dir' }, '/h').valid, false, 'socket_dir must be absolute');
  assert.equal(validateConfig({ ...good(), socket_dir: '/h/run' }, '/h').valid, false, 'socket_dir must not live inside AGENT_HOME');
  assert.equal(validateConfig({ ...good(), socket_dir: '/' }, '/h').valid, false, 'AGENT_HOME must not live inside socket_dir');
  assert.equal(validateConfig({ ...good(), socket_path: '../elsewhere.sock' }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), socket_path: 'a/b.sock' }, '/h').valid, false);
  assert.equal(validateConfig({ ...good(), socket_path: 'x.sock' }, '/h').config.socket_path, '/run/gw-test/x.sock');
  for (const k of ['ledger_dir', 'credentials_file', 'runs_dir', 'pid_file']) assert.equal(validateConfig({ ...good(), [k]: '/elsewhere/x' }, '/h').valid, false, `${k} must stay inside AGENT_HOME`);
  assert.equal(validateConfig({ ...good(), ledger_dir: '..' }, '/h').valid, false);
});
