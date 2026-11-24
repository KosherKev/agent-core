import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, makeApi, makeGrant, chatOk, PAID_TABLE, FREE_MODEL } from './gateway-helpers.js';
import { createGatewayServer } from '../src/gateway/server.js';
import { createFileLedgerStore } from '../src/gateway/store.js';
import { request } from '../src/gateway/client.js';
import { discoveryPath, readDiscovery } from '../src/gateway/discovery.js';
import { main } from '../src/gateway/cli.js';
import { validateConfig } from '../src/gateway/config.js';

const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ledgerCounts(dir) {
  const text = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
  const count = (k) => (text.match(new RegExp(`"(?:type|kind|event)":"${k}"`, 'g')) ?? []).length;
  return { reserve: count('reserve'), settle: count('settle') };
}
/** Provider mock: `auto` answers at once, otherwise each answer is held until release(). */
async function provider({ auto = false, status = 200 } = {}) {
  const hits = []; const waiting = [];
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const answer = () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(status === 200 ? chatOk('answer').body : { error: { message: 'no' } })); };
      if (auto) answer(); else waiting.push(answer);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, hits, release: () => waiting.splice(0).forEach((f) => f()), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
async function setup({ auto, status, priceTable, limits, serverOpts = {} } = {}) {
  const prov = await provider({ auto, status });
  const t = tempHome({ baseUrl: prov.url, limits });
  const a = makeApi({ ...t, priceTable });
  const gw = createGatewayServer({ api: a.api, config: t.config, ...serverOpts });
  await gw.start();
  return { prov, gw, t, config: t.config, sock: t.config.socket_path, ...a, close: async () => { await gw.stop({ force: true }); await prov.close(); } };
}
const paid = { run_id: 'r1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 100 };
/** Open a raw connection, send one modelCall line, and collect everything the server sends. */
async function rawCall(sock, params, id = 1) {
  const c = net.connect(sock); const got = { text: '', closed: false, c };
  c.setEncoding('utf8'); c.on('data', (d) => { got.text += d; }); c.on('close', () => { got.closed = true; }); c.on('error', () => {});
  await new Promise((r) => c.once('connect', r));
  c.write(JSON.stringify({ id, method: 'modelCall', params }) + '\n');
  return got;
}

test('server.js tracks its own connections and uses no method net.Server lacks', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'gateway', 'server.js'), 'utf8');
  assert.ok(!src.includes('closeAllConnections'));
  assert.ok(!src.includes('closeIdleConnections'));
});

test('discovery file: owner, group, mode and contents; its instance_id is the one ping returns; it is removed on stop', async () => {
  const s = await setup();
  try {
    const f = discoveryPath(s.config.socket_dir);
    const st = statSync(f);
    assert.equal(st.mode & 0o777, 0o640); assert.equal(st.uid, process.getuid()); assert.equal(st.gid, process.getgid());
    const d = readDiscovery(f);
    assert.equal(d.socket_path, s.config.socket_path); assert.equal(d.gateway_uid, process.getuid()); assert.equal(d.pid, process.pid); assert.match(d.instance_id, /^[0-9a-f]{32}$/);
    assert.equal((await request(s.sock, 'ping')).result.instance_id, d.instance_id);
    assert.equal(readDiscovery(f).instance_id, s.gw.instanceId);
  } finally { await s.close(); }
  assert.equal(existsSync(discoveryPath(s.config.socket_dir)), false);
});

test('shutdown with no connections exits promptly and removes the pid file, the socket and the discovery file', async () => {
  const s = await setup();
  assert.ok(existsSync(s.config.pid_file) && existsSync(s.config.socket_path));
  const t0 = Date.now();
  await s.gw.stop();
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(existsSync(s.config.pid_file), false); assert.equal(existsSync(s.config.socket_path), false); assert.equal(existsSync(discoveryPath(s.config.socket_dir)), false);
  await s.prov.close();
});

test('shutdown drops idle connections at once but lets an in-flight call finish within the grace period', async () => {
  const s = await setup({ serverOpts: { shutdownGraceMs: 5000 } });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const idle = net.connect(s.sock); let idleClosed = false; idle.on('close', () => { idleClosed = true; }); idle.on('error', () => {});
    await new Promise((r) => idle.once('connect', r));
    const busy = await rawCall(s.sock, { ...paid, model: FREE_MODEL, request_id: 'q1' });
    await until(() => s.prov.hits.length === 1);
    const t0 = Date.now(); let stopped = false;
    const stopping = s.gw.stop().then(() => { stopped = true; });
    await until(() => idleClosed); assert.equal(stopped, false, 'still waiting for the in-flight call');
    await sleep(100); assert.equal(stopped, false);
    s.prov.release();
    await stopping;
    assert.ok(Date.now() - t0 < 3000);
    const reply = JSON.parse(busy.text.trim());
    assert.equal(reply.ok, true); assert.equal(reply.result.message.content, 'answer');
    assert.equal(existsSync(s.config.socket_path), false);
  } finally { await s.close(); }
});

test('a stuck call is destroyed at the grace limit; its reservation stays in the ledger and a retry never reserves twice', async () => {
  const s = await setup({ priceTable: PAID_TABLE, serverOpts: { shutdownGraceMs: 300 } });
  try {
    const grant = makeGrant();
    await call(s.api, 'openRun', { run_id: 'r1', grant });
    const before = s.store.read(grant).remaining_micro;
    const stuck = await rawCall(s.sock, { ...paid, request_id: 'q1' });
    await until(() => s.prov.hits.length === 1);
    const t0 = Date.now();
    await s.gw.stop();
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 2500, `took ${took} ms`);
    await until(() => stuck.closed);
    assert.equal(stuck.text, '', 'no answer was delivered to the cut-off client');
    assert.equal(existsSync(s.config.pid_file), false); assert.equal(existsSync(s.config.socket_path), false);
    assert.deepEqual(ledgerCounts(s.store.dir), { reserve: 1, settle: 0 }, 'the reservation is still there');
    const after = createFileLedgerStore(s.config.ledger_dir).read(grant).remaining_micro; // as a restarted gateway would see it
    assert.ok(after < before, 'reserved money stays counted after the cut-off');
    const retry = call(s.api, 'modelCall', { ...paid, request_id: 'q1' }); // same request_id: waits for the same call, never a second reservation
    await sleep(50);
    assert.equal(s.prov.hits.length, 1);
    assert.deepEqual(ledgerCounts(s.store.dir), { reserve: 1, settle: 0 });
    s.prov.release();
    const r = await retry; assert.equal(r.ok, true);
    assert.deepEqual(ledgerCounts(s.store.dir), { reserve: 1, settle: 1 });
  } finally { await s.close(); }
});

test('a second stop (second signal) destroys everything and returns at once', async () => {
  const s = await setup({ serverOpts: { shutdownGraceMs: 60_000 } });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const stuck = await rawCall(s.sock, { ...paid, model: FREE_MODEL, request_id: 'q1' });
    await until(() => s.prov.hits.length === 1);
    let first = false; const graceful = s.gw.stop().then(() => { first = true; });
    await sleep(100); assert.equal(first, false);
    const t0 = Date.now();
    await s.gw.stop({ force: true });
    assert.ok(Date.now() - t0 < 500);
    await graceful; assert.equal(first, true);
    await until(() => stuck.closed);
    assert.equal(existsSync(s.config.socket_path), false); assert.equal(existsSync(s.config.pid_file), false); assert.equal(existsSync(discoveryPath(s.config.socket_dir)), false);
  } finally { await s.close(); }
});

test('cleanupSync (the exit hook) removes pid file, socket and discovery file, and only ours', async () => {
  const s = await setup();
  try {
    s.gw.cleanupSync();
    assert.equal(existsSync(s.config.pid_file), false); assert.equal(existsSync(s.config.socket_path), false); assert.equal(existsSync(discoveryPath(s.config.socket_dir)), false);
    s.gw.cleanupSync(); // idempotent
  } finally { await s.close(); }
});

test('agent gateway: the first signal stops gracefully, the second forces and exits at once; an exit hook cleans up', async () => {
  const calls = [];
  const gw = { stop: (o) => { calls.push(o?.force ? 'force' : 'graceful'); return o?.force ? Promise.resolve() : new Promise(() => {}); }, cleanupSync: () => calls.push('cleanup') };
  const proc = Object.assign(new EventEmitter(), { exit: (c) => calls.push(`exit${c}`) });
  const io = { out: () => {}, err: () => {} };
  const code = await main(['gateway'], { env: {}, io, deps: { startGateway: async () => ({ gw, config: { socket_path: '/x' } }), proc } });
  assert.equal(code, null);
  proc.emit('SIGTERM'); assert.deepEqual(calls, ['graceful']);
  proc.emit('SIGINT'); assert.deepEqual(calls, ['graceful', 'force', 'exit0']);
  proc.emit('exit'); assert.equal(calls.at(-1), 'cleanup');
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.ok(proc.listenerCount(sig) >= 1, sig);
});

test('the new limits are validated and defaulted', () => {
  const t = tempHome();
  const ok = validateConfig({ ...t.raw }, t.home);
  assert.equal(ok.config.shutdown_grace_ms, 10_000); assert.equal(ok.config.request_read_timeout_ms, 10_000); assert.equal(ok.config.request_cache_max, 1024);
  assert.equal(validateConfig({ ...t.raw, shutdown_grace_ms: 0, request_cache_max: 5, request_read_timeout_ms: 50 }, t.home).valid, true);
  for (const [k, v] of [['shutdown_grace_ms', -1], ['shutdown_grace_ms', 1.5], ['request_cache_max', 0], ['request_read_timeout_ms', 0], ['request_read_timeout_ms', '5']]) assert.equal(validateConfig({ ...t.raw, [k]: v }, t.home).valid, false, `${k}=${v}`);
});

test('a slow-drip client is destroyed at request_read_timeout_ms; the idle timeout is not what cut it', async () => {
  const s = await setup({ auto: true, serverOpts: { readTimeoutMs: 250, idleMs: 60_000 } });
  try {
    const c = net.connect(s.sock); c.on('error', () => {}); let closed = false; c.on('close', () => { closed = true; });
    await new Promise((r) => c.once('connect', r));
    const t0 = Date.now();
    const drip = setInterval(() => { if (!c.destroyed) c.write('x'); }, 50);
    await until(() => closed, 3000); clearInterval(drip);
    const took = Date.now() - t0;
    assert.ok(took >= 200 && took < 1500, `took ${took} ms`);
  } finally { await s.close(); }
});

test('request_read_timeout_ms does not cut a well-behaved connection, and a quiet one is left to the idle timeout', async () => {
  const s = await setup({ auto: true, serverOpts: { readTimeoutMs: 150, idleMs: 60_000 } });
  try {
    const c = net.connect(s.sock); c.on('error', () => {}); let closed = false; c.on('close', () => { closed = true; });
    await new Promise((r) => c.once('connect', r));
    await sleep(400); assert.equal(closed, false, 'no bytes sent, so the read timer never started');
    for (let i = 0; i < 3; i += 1) { assert.equal((await request(s.sock, 'ping')).ok, true); }
    c.destroy();
  } finally { await s.close(); }
});

test('a slow provider call is not cut off by request_read_timeout_ms', async () => {
  const s = await setup({ serverOpts: { readTimeoutMs: 150, idleMs: 150 } });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const slow = await rawCall(s.sock, { ...paid, model: FREE_MODEL, request_id: 'q1' });
    await until(() => s.prov.hits.length === 1);
    await sleep(600); assert.equal(slow.closed, false, 'still being served');
    s.prov.release();
    await until(() => slow.text.includes('\n'));
    assert.equal(JSON.parse(slow.text.trim()).ok, true);
    slow.c.destroy();
  } finally { await s.close(); }
});

test('the request cache is bounded: settled entries are evicted oldest first, and a retry after eviction returns the persisted result without paying again', async () => {
  const s = await setup({ auto: true, priceTable: PAID_TABLE, limits: { request_cache_max: 2 } });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const first = await call(s.api, 'modelCall', { ...paid, request_id: 'q1' });
    assert.equal(first.ok, true);
    for (const id of ['q2', 'q3', 'q4', 'q5']) assert.equal((await call(s.api, 'modelCall', { ...paid, request_id: id })).ok, true);
    assert.ok(s.api.cacheSize() <= 2, `cache holds ${s.api.cacheSize()}`);
    const counts = ledgerCounts(s.store.dir); const hits = s.prov.hits.length;
    assert.deepEqual(counts, { reserve: 5, settle: 5 });
    const again = await call(s.api, 'modelCall', { ...paid, request_id: 'q1' }); // q1 was evicted from memory
    assert.equal(again.ok, true); assert.deepEqual(again.result, first.result);
    assert.equal(s.prov.hits.length, hits, 'no second provider request');
    assert.deepEqual(ledgerCounts(s.store.dir), counts, 'no second reservation or settlement');
    const conflict = await call(s.api, 'modelCall', { ...paid, max_tokens: 7, request_id: 'q1' });
    assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'request_id_conflict');
    assert.ok(s.api.cacheSize() <= 2);
  } finally { await s.close(); }
});

test('an evicted request that FAILED replays the same error from the persisted record and does not call the provider again', async () => {
  const s = await setup({ auto: true, status: 400, limits: { request_cache_max: 1 } });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const p = { ...paid, model: FREE_MODEL };
    const e1 = await call(s.api, 'modelCall', { ...p, request_id: 'a1' });
    const e2 = await call(s.api, 'modelCall', { ...p, request_id: 'a2' });
    assert.equal(e1.ok, false); assert.equal(e1.error.code, 'provider_rejected'); assert.equal(e2.error.code, 'provider_rejected');
    const hits = s.prov.hits.length;
    const again = await call(s.api, 'modelCall', { ...p, request_id: 'a1' }); // a1 is out of memory
    assert.equal(again.ok, false); assert.equal(again.error.code, 'provider_rejected'); assert.equal(again.error.message, e1.error.message);
    assert.equal(s.prov.hits.length, hits);
  } finally { await s.close(); }
});

test('in-flight entries are never evicted, even over the cap, so a duplicate still waits for the same call', async () => {
  const s = await setup({ priceTable: PAID_TABLE, limits: { request_cache_max: 1 } });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const a = call(s.api, 'modelCall', { ...paid, request_id: 'q1' });
    const b = call(s.api, 'modelCall', { ...paid, request_id: 'q2' });
    await until(() => s.prov.hits.length === 2);
    assert.equal(s.api.cacheSize(), 2, 'both in-flight entries are kept although the cap is 1');
    const dup = call(s.api, 'modelCall', { ...paid, request_id: 'q1' });
    await sleep(50); assert.equal(s.prov.hits.length, 2, 'the duplicate did not call the provider');
    s.prov.release();
    const [ra, rb, rd] = await Promise.all([a, b, dup]);
    assert.equal(ra.ok && rb.ok && rd.ok, true); assert.deepEqual(rd.result, ra.result);
    assert.deepEqual(ledgerCounts(s.store.dir), { reserve: 2, settle: 2 });
    assert.ok(s.api.cacheSize() <= 1);
  } finally { await s.close(); }
});

test('no secret appears in any response, log or run file across eviction, shutdown and replay', async () => {
  const logs = [];
  const prov = await provider({ auto: true });
  const t = tempHome({ baseUrl: prov.url, limits: { request_cache_max: 1 } });
  const a = makeApi({ ...t, priceTable: PAID_TABLE, logs });
  try {
    await call(a.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const outs = [];
    for (const id of ['q1', 'q2', 'q1']) outs.push(await call(a.api, 'modelCall', { ...paid, request_id: id }));
    const files = readdirSync(t.config.runs_dir).map((n) => readFileSync(join(t.config.runs_dir, n), 'utf8'));
    for (const text of [JSON.stringify(outs), logs.join('\n'), ...files]) assert.ok(!text.includes('FAKEKEY') && !/sk-/.test(text));
  } finally { await prov.close(); }
});

test('round 2 low: cleanupSync does not unlink a socket that is not the one this process created (different inode)', async () => {
  const s = await setup();
  const { unlinkSync } = await import('node:fs');
  let other;
  try {
    unlinkSync(s.config.socket_path); // someone replaced our socket with their own
    other = net.createServer(); await new Promise((r) => other.listen(s.config.socket_path, r));
    s.gw.cleanupSync();
    assert.equal(existsSync(s.config.socket_path), true, 'the other process\'s socket was left alone');
    assert.equal(existsSync(s.config.pid_file), false, 'our own pid file is still removed');
  } finally { if (other) await new Promise((r) => other.close(r)); await s.close(); }
});
