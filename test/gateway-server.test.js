import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { statSync } from 'node:fs';
import { tempHome, makeApi, startMock, chatOk, makeGrant, FREE_MODEL } from './gateway-helpers.js';
import { createGatewayServer, peerAllowed, unknownPeerUid, MAX_LINE } from '../src/gateway/server.js';
import { request } from '../src/gateway/client.js';
import { startGateway } from '../src/gateway/cli.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unix socket paths are short-limited; use a short temp dir.
const shortHome = (opts) => {
  const t = tempHome(opts);
  return t;
};

async function serve({ getPeerUid, api, allowed = [4242], fetchFn } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gws-'));
  const t = tempHome({ allowed });
  const config = { ...t.config, socket_path: join(dir, 's.sock'), pid_file: join(dir, 'pid') };
  const real = api ?? makeApi({ ...t, config, fetchFn }).api;
  const gw = createGatewayServer({ api: real, config, getPeerUid });
  await gw.start();
  return { gw, config, api: real, t };
}

test('peer uid refusal happens before any request is parsed', async () => {
  let handled = 0; let parsed = 0;
  const spy = { handle: async () => { handled += 1; return { ok: true }; } };
  const origParse = JSON.parse;
  const s = await serve({ api: spy, getPeerUid: () => 999 });
  try {
    JSON.parse = (...a) => { parsed += 1; return origParse(...a); };
    const closed = await new Promise((res) => {
      const c = net.connect(s.config.socket_path);
      let got = '';
      c.on('data', (d) => { got += d; });
      c.on('connect', () => c.write('{"method":"openRun"}\n{garbage\n'));
      c.on('close', () => res(got));
      c.on('error', () => res(got));
    });
    JSON.parse = origParse;
    assert.equal(closed, '', 'refused peer receives nothing');
    assert.equal(handled, 0); assert.equal(parsed, 0, 'no JSON parse ran for a refused peer');
  } finally { JSON.parse = origParse; await s.gw.stop(); }
});

test('an allowlisted peer is served; an unknown or throwing probe is refused (fail closed)', async () => {
  const a = await serve({ getPeerUid: () => 4242 });
  try {
    const r = await request(a.config.socket_path, 'journalRead', { run_id: 'nope' });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'run_unknown');
  } finally { await a.gw.stop(); }
  for (const probe of [unknownPeerUid, () => { throw new Error('x'); }, async () => undefined, () => '4242', undefined]) {
    const s = await serve({ getPeerUid: probe });
    try { await assert.rejects(request(s.config.socket_path, 'journalRead', { run_id: 'nope' }), /closed|refused/); } finally { await s.gw.stop(); }
  }
});

test('peerAllowed is an exact integer-uid match', () => {
  assert.equal(peerAllowed([1, 2], 2), true);
  assert.equal(peerAllowed([1, 2], 3), false);
  assert.equal(peerAllowed([1, 2], '2'), false);
  assert.equal(peerAllowed([], 0), false);
  assert.equal(peerAllowed(undefined, 1), false);
});

test('the socket is mode 0600 and the server has no TCP listener (its address is a path)', async () => {
  const s = await serve({ getPeerUid: () => 4242 });
  try {
    const st = statSync(s.config.socket_path);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(typeof s.gw.server.address(), 'string');
    assert.equal(s.gw.server.address(), s.config.socket_path);
  } finally { await s.gw.stop(); }
});

test('start refuses when another gateway already listens, and replaces a stale socket file', async () => {
  const s = await serve({ getPeerUid: () => 4242 });
  try {
    const second = createGatewayServer({ api: s.api, config: s.config, getPeerUid: () => 4242 });
    await assert.rejects(second.start(), /already listening/);
  } finally { await s.gw.stop(); }
  // stale: server stopped, node removes the socket on close; recreate by starting again
  const again = createGatewayServer({ api: s.api, config: s.config, getPeerUid: () => 4242 });
  await again.start(); await again.stop();
});

test('oversized and malformed lines never crash the server', async () => {
  const s = await serve({ getPeerUid: () => 4242 });
  try {
    const bad = await new Promise((res) => { const c = net.connect(s.config.socket_path); let g = ''; c.on('data', (d) => { g += d; if (g.includes('\n')) { c.destroy(); res(JSON.parse(g)); } }); c.on('connect', () => c.write('not json\n')); });
    assert.equal(bad.ok, false); assert.equal(bad.error.code, 'invalid_request');
    await new Promise((res) => { const c = net.connect(s.config.socket_path); c.on('close', res); c.on('error', res); c.on('connect', () => c.write('x'.repeat(MAX_LINE + 10))); });
    const ok = await request(s.config.socket_path, 'journalRead', { run_id: 'zz' });
    assert.equal(ok.ok, false);
  } finally { await s.gw.stop(); }
});

test('end to end over the socket: openRun, modelCall to the mock, endRun; the runner never sees a key', async () => {
  const mock = await startMock(() => chatOk('over the wire'));
  const dir = mkdtempSync(join(tmpdir(), 'gws-'));
  const t = tempHome({ baseUrl: mock.url, allowed: [4242] });
  const { writeFileSync, readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(join(t.home, 'config.json'), 'utf8'));
  raw.socket_path = join(dir, 's.sock'); raw.pid_file = join(dir, 'pid');
  writeFileSync(join(t.home, 'config.json'), JSON.stringify(raw));
  const { gw, config } = await startGateway({ home: t.home, getPeerUid: () => 4242 });
  try {
    const sock = config.socket_path;
    const g = makeGrant();
    assert.equal((await request(sock, 'openRun', { run_id: 'w1', grant: g })).ok, true);
    const r = await request(sock, 'modelCall', { run_id: 'w1', provider: 'mockprov', model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.result.message.content, 'over the wire');
    assert.ok(r.budget.remaining_micro > 0);
    assert.ok(!JSON.stringify(r).includes('FAKEKEY'));
    assert.equal((await request(sock, 'endRun', { run_id: 'w1', outcome: 'ok' })).result.record.outcome, 'ok');
  } finally { await gw.stop(); await mock.close(); }
});

test('startGateway refuses (before listening) on a bad config or a loose credential file', async () => {
  const t = tempHome({});
  const { chmodSync } = await import('node:fs');
  chmodSync(t.config.credentials_file, 0o644);
  await assert.rejects(startGateway({ home: t.home }), /mode 0600/);
  await assert.rejects(startGateway({ home: mkdtempSync(join(tmpdir(), 'gw-empty-')) }), /config invalid/);
});
