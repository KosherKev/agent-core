import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { statSync, chmodSync, existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome, makeApi, startMock, chatOk, makeGrant, FREE_MODEL } from './gateway-helpers.js';
import { createGatewayServer, peerAllowed, unknownPeerUid, MAX_LINE } from '../src/gateway/server.js';
import { createLayoutChecker, MODES } from '../src/gateway/layout.js';
import { request } from '../src/gateway/client.js';
import { startGateway } from '../src/gateway/cli.js';

let ridN = 0; const rid = () => `req-${++ridN}`;

/** A server on a temp home built exactly as the layout rules require (home 700, socket_dir 750, group = this process's group). */
async function serve({ getPeerUid, api, allowed, limits, ...opts } = {}) {
  const t = tempHome({ allowed, limits });
  const real = api ?? makeApi(t).api;
  const gw = createGatewayServer({ api: real, config: t.config, getPeerUid, ...opts });
  await gw.start();
  return { gw, config: t.config, api: real, t };
}

test('with no peer-uid probe configured the server serves a connection (kernel permissions are the boundary)', async () => {
  const s = await serve();
  try {
    const r = await request(s.config.socket_path, 'journalRead', { run_id: 'nope' });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'run_unknown');
    const p = await request(s.config.socket_path, 'ping');
    assert.equal(p.ok, true); assert.equal(typeof p.result.version, 'string'); assert.ok(p.result.uptime_ms >= 0);
  } finally { await s.gw.stop(); }
});

test('a configured peer-uid probe is still enforced, and is checked before any request is parsed', async () => {
  let handled = 0; let parsed = 0;
  const spy = { handle: async () => { handled += 1; return { ok: true }; } };
  const origParse = JSON.parse;
  const s = await serve({ api: spy, allowed: [4242], getPeerUid: () => 999 });
  try {
    JSON.parse = (...a) => { parsed += 1; return origParse(...a); };
    const got = await new Promise((res) => {
      const c = net.connect(s.config.socket_path); let g = '';
      c.on('data', (d) => { g += d; }); c.on('connect', () => c.write('{"method":"openRun"}\n{garbage\n'));
      c.on('close', () => res(g)); c.on('error', () => res(g));
    });
    JSON.parse = origParse;
    assert.equal(got, ''); assert.equal(handled, 0); assert.equal(parsed, 0, 'no JSON parse ran for a refused peer');
  } finally { JSON.parse = origParse; await s.gw.stop(); }
});

test('probe configured: a listed uid is served; unknown, throwing, wrong-typed or missing allowlist answers are refused (fail closed)', async () => {
  const a = await serve({ allowed: [4242], getPeerUid: () => 4242 });
  try { assert.equal((await request(a.config.socket_path, 'journalRead', { run_id: 'nope' })).error.code, 'run_unknown'); } finally { await a.gw.stop(); }
  for (const probe of [unknownPeerUid, () => { throw new Error('x'); }, async () => undefined, () => '4242', () => 7]) {
    const s = await serve({ allowed: [4242], getPeerUid: probe });
    try { await assert.rejects(request(s.config.socket_path, 'journalRead', { run_id: 'nope' }), /closed|refused/); } finally { await s.gw.stop(); }
  }
  const none = await serve({ getPeerUid: () => 4242 }); // a probe with no allowlist admits nobody
  try { await assert.rejects(request(none.config.socket_path, 'ping'), /closed|refused/); } finally { await none.gw.stop(); }
});

test('peerAllowed is an exact integer-uid match', () => {
  assert.equal(peerAllowed([1, 2], 2), true);
  assert.equal(peerAllowed([1, 2], 3), false);
  assert.equal(peerAllowed([1, 2], '2'), false);
  assert.equal(peerAllowed([], 0), false);
  assert.equal(peerAllowed(undefined, 1), false);
});

test('the socket is 0660 owned by the gateway user and the runner group; the server has no TCP listener (its address is a path)', async () => {
  const s = await serve();
  try {
    const st = statSync(s.config.socket_path);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o660); assert.equal(st.uid, process.getuid()); assert.equal(st.gid, process.getgid());
    assert.equal(statSync(s.config.socket_dir).mode & 0o777, 0o750);
    assert.equal(typeof s.gw.server.address(), 'string');
  } finally { await s.gw.stop(); }
});

/** Fake stat map for the layout checker: a healthy layout, with overrides. */
const GW = 1001; const GID = 3003;
function fakeLayout(over = {}) {
  const t = tempHome();
  const config = { ...t.config, identities: { gateway_uid: GW, runner_uid: 2002 } };
  const table = {
    [config.home]: { ok: true, type: 'dir', mode: 0o700, uid: GW, gid: 5 },
    [`${config.home}/config.json`]: { ok: true, type: 'file', mode: 0o600, uid: GW, gid: 5 },
    [config.socket_dir]: { ok: true, type: 'dir', mode: 0o750, uid: GW, gid: GID },
    ...over,
  };
  const check = (extra = {}) => createLayoutChecker({ stat: (p) => table[p] ?? { ok: false, code: 'ENOENT' }, getuid: () => GW, ...extra })(config, { gid: GID });
  return { config, table, check };
}

test('startup layout check: a healthy layout passes and each wrong owner, group or mode is refused', () => {
  assert.deepEqual(fakeLayout().check(), []);
  const wrong = (label, key, patch) => {
    const f = fakeLayout();
    const path = key === 'home' ? f.config.home : key === 'config' ? `${f.config.home}/config.json` : f.config.socket_dir;
    f.table[path] = { ...f.table[path], ...patch };
    const problems = f.check();
    assert.ok(problems.length >= 1, `${label} must be refused`);
    return problems;
  };
  wrong('home owned by another user', 'home', { uid: 1 });
  wrong('home 0750', 'home', { mode: 0o750 });
  wrong('home 0755', 'home', { mode: 0o755 });
  wrong('home 0770', 'home', { mode: 0o770 });
  wrong('home is a symlink', 'home', { type: 'link' });
  wrong('config owned by another user', 'config', { uid: 1 });
  wrong('config group writable', 'config', { mode: 0o660 });
  wrong('config world writable', 'config', { mode: 0o602 });
  wrong('socket_dir owned by another user', 'socketDir', { uid: 1 });
  wrong('socket_dir wrong group', 'socketDir', { gid: 9 });
  wrong('socket_dir 0700 (group cannot traverse)', 'socketDir', { mode: 0o700 });
  wrong('socket_dir 0770 (group can create or delete)', 'socketDir', { mode: 0o770 });
  wrong('socket_dir 0755', 'socketDir', { mode: 0o755 });
  wrong('socket_dir is a file', 'socketDir', { type: 'file' });
  const f = fakeLayout();
  assert.match(createLayoutChecker({ stat: () => ({ ok: false, code: 'ENOENT' }), getuid: () => GW, mkdir: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } })(f.config, { gid: GID })[0], /cannot create socket_dir/);
  assert.match(createLayoutChecker({ stat: (p) => f.table[p], getuid: () => 77 })(f.config, { gid: GID })[0], /must run as uid 1001/);
  assert.match(createLayoutChecker({ stat: (p) => f.table[p], getuid: () => GW })(f.config, { gid: null })[0], /does not resolve/);
  assert.equal(MODES.socket, 0o660);
});

test('startup creates a missing socket_dir as 0750 with the runner group and then accepts it', () => {
  const f = fakeLayout(); const calls = [];
  const table = { ...f.table }; delete table[f.config.socket_dir];
  const check = createLayoutChecker({
    stat: (p) => table[p] ?? { ok: false, code: 'ENOENT' }, getuid: () => GW,
    mkdir: (p, m) => { calls.push(['mkdir', m]); table[p] = { ok: true, type: 'dir', mode: m, uid: GW, gid: 5 }; },
    chown: (p, u, g) => { calls.push(['chown', u, g]); table[p] = { ...table[p], uid: u, gid: g }; },
    chmod: (p, m) => { calls.push(['chmod', m]); table[p] = { ...table[p], mode: m }; },
  });
  assert.deepEqual(check(f.config, { gid: GID }), []);
  assert.deepEqual(calls, [['mkdir', 0o750], ['chown', GW, GID], ['chmod', 0o750]]);
});

test('the server refuses to listen on each wrong real layout (no socket is created)', async () => {
  const cases = [
    ['home 0755', (t) => chmodSync(t.home, 0o755)],
    ['socket_dir 0770', (t) => chmodSync(t.socketDir, 0o770)],
    ['socket_dir 0700', (t) => chmodSync(t.socketDir, 0o700)],
    ['config.json 0666', (t) => chmodSync(join(t.home, 'config.json'), 0o666)],
  ];
  for (const [label, breakIt] of cases) {
    const t = tempHome(); breakIt(t);
    const gw = createGatewayServer({ api: makeApi(t).api, config: t.config });
    await assert.rejects(gw.start(), /layout refused/, label);
    assert.equal(existsSync(t.config.socket_path), false, `${label}: no socket`);
    assert.equal(gw.server.listening, false);
  }
  const t = tempHome();
  const wrongUser = { ...t.config, identities: { gateway_uid: process.getuid() + 1, runner_uid: 0 } };
  await assert.rejects(createGatewayServer({ api: makeApi(t).api, config: wrongUser }).start(), /must run as uid/);
  const noGroup = { ...t.config, runner_group: 'no-such-group-xyz' };
  await assert.rejects(createGatewayServer({ api: makeApi(t).api, config: noGroup }).start(), /does not resolve/);
});

test('start refuses when another gateway already listens, and replaces a stale socket file', async () => {
  const s = await serve();
  try {
    const second = createGatewayServer({ api: s.api, config: s.config });
    await assert.rejects(second.start(), /already listening/);
  } finally { await s.gw.stop(); }
  const again = createGatewayServer({ api: s.api, config: s.config });
  await again.start(); await again.stop();
});

test('end to end over the socket: openRun, modelCall to the mock, endRun; the runner never sees a key', async () => {
  const mock = await startMock(() => chatOk('over the wire'));
  const t = tempHome({ baseUrl: mock.url });
  const { gw, config } = await startGateway({ home: t.home });
  try {
    const sock = config.socket_path;
    assert.equal((await request(sock, 'openRun', { run_id: 'w1', grant: makeGrant() })).ok, true);
    const r = await request(sock, 'modelCall', { request_id: rid(), run_id: 'w1', provider: 'mockprov', model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.result.message.content, 'over the wire');
    assert.ok(r.budget.remaining_micro > 0);
    assert.ok(!JSON.stringify(r).includes('FAKEKEY'));
    assert.equal((await request(sock, 'endRun', { run_id: 'w1', outcome: 'ok' })).result.record.outcome, 'ok');
    const p = await request(sock, 'ping');
    assert.match(p.result.access, /kernel-permissions-only/);
    assert.equal(p.result.layout.runner_gid, process.getgid());
    assert.ok(!JSON.stringify(p).includes('FAKEKEY'));
  } finally { await gw.stop(); await mock.close(); }
});

test('startGateway refuses (before listening) on a bad config, a bad layout or a loose credential file', async () => {
  const t = tempHome({});
  chmodSync(t.config.credentials_file, 0o644);
  await assert.rejects(startGateway({ home: t.home }), /mode 0600/);
  await assert.rejects(startGateway({ home: mkdtempSync(join(tmpdir(), 'gw-empty-')) }), /config invalid/);
  const u = tempHome({}); chmodSync(u.home, 0o755);
  await assert.rejects(startGateway({ home: u.home }), /layout refused/);
  assert.equal(existsSync(join(u.home, 'ledger')), false, 'nothing is created under a refused home');
});
