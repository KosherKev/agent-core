import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome, makeApi, makeGrant, chatOk, PAID_TABLE, FREE_MODEL } from './gateway-helpers.js';
import { callProvider } from '../src/gateway/proxy.js';
import { createGatewayServer } from '../src/gateway/server.js';
import { isGatewayCmdline, processInfo } from '../src/gateway/sys.js';
import { request } from '../src/gateway/client.js';
import { FAKE_KEY } from './builder-mock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const msgs = [{ role: 'user', content: 'hello' }];
const until = async (f, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 15)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- provider response cap ----
const cfg = { providers: { p: { base_url: 'https://provider.example/v1' } } };
const creds = { get: () => FAKE_KEY };
/** A response whose body is an endless stream; records how many bytes were pulled and whether it was cancelled. */
function endless(chunkBytes = 1024, headers = {}) {
  const st = { pulled: 0, cancelled: false };
  const body = new ReadableStream({ pull(c) { st.pulled += chunkBytes; c.enqueue(new Uint8Array(chunkBytes).fill(97)); }, cancel() { st.cancelled = true; } }, { highWaterMark: 0 });
  return { st, res: new Response(body, { status: 200, headers }) };
}
const call = (send, maxBytes) => callProvider({ config: cfg, credentials: creds, provider: 'p', model: 'm', messages: msgs, maxTokens: 10, send, maxBytes });

test('response cap: an endless provider body is aborted at the limit and never buffered past it', async () => {
  const e = endless(1024);
  const r = await call(async () => e.res, 10_000);
  assert.equal(r.networkError, true); assert.equal(r.tooLarge, true); assert.equal(r.json, null);
  assert.equal(e.st.cancelled, true, 'the stream was cancelled');
  assert.ok(e.st.pulled <= 10_000 + 1024, `pulled ${e.st.pulled} bytes, limit 10000 plus one chunk`);
});

test('response cap: a declared content-length over the limit reads nothing at all', async () => {
  const e = endless(1024, { 'content-length': '999999' });
  const r = await call(async () => e.res, 10_000);
  assert.equal(r.tooLarge, true); assert.equal(e.st.pulled, 0);
});

test('response cap: a body at or under the limit parses normally', async () => {
  const body = JSON.stringify(chatOk('fine').body);
  const r = await call(async () => new Response(body, { status: 200 }), body.length);
  assert.equal(r.networkError, false); assert.equal(r.json.choices[0].message.content, 'fine');
  const over = await call(async () => new Response(body, { status: 200 }), body.length - 1);
  assert.equal(over.tooLarge, true);
});

test('response cap through the API: an oversize reply is refused, settled at worst case, and nothing of it is returned', async () => {
  const t = tempHome({ limits: { max_response_bytes: 2048 } });
  const huge = new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  const { api } = makeApi({ ...t, priceTable: PAID_TABLE, fetchFn: async () => huge });
  await api.handle({ id: 1, method: 'openRun', params: { run_id: 'r1', grant: makeGrant() } });
  const r = await api.handle({ id: 2, method: 'modelCall', params: { run_id: 'r1', request_id: 'q1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 100 } });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'provider_error');
  assert.ok(!JSON.stringify(r).includes('xxxx'));
  assert.ok(r.budget.settled_micro > 0, 'worst case was charged');
});

// ---- request limits ----
async function serve(limits = {}, { slow = false } = {}) {
  let release = () => {}; let hits = 0; let upstream = null;
  if (slow) {
    const pending = [];
    upstream = createServer((req, res) => { req.resume(); req.on('end', () => { hits += 1; pending.push(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(chatOk('late').body)); }); }); });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    release = () => pending.splice(0).forEach((f) => f());
  }
  const t = tempHome({ limits, baseUrl: upstream ? `http://127.0.0.1:${upstream.address().port}/v1` : undefined });
  const gw = createGatewayServer({ api: makeApi(t).api, config: t.config });
  await gw.start();
  return { gw, t, sock: t.config.socket_path, release, hits: () => hits, close: async () => { await gw.stop(); upstream?.closeAllConnections?.(); upstream?.close(); } };
}
const closedAfter = (c) => new Promise((res) => { c.on('close', () => res(true)); c.on('error', () => {}); });

test('a request line over max_request_bytes closes the connection, with or without a newline, and the server keeps serving', async () => {
  const s = await serve({ max_request_bytes: 2048 });
  try {
    for (const payload of ['x'.repeat(5000), `${'x'.repeat(5000)}\n`, `{"id":1,"method":"ping","params":{"pad":"${'y'.repeat(3000)}"}}\n`]) {
      const c = net.connect(s.sock); const done = closedAfter(c);
      let got = ''; c.on('data', (d) => { got += d; });
      await new Promise((r) => c.once('connect', r)); c.write(payload);
      assert.equal(await done, true); assert.ok(!got.includes('"ok":true'), 'the oversize request was not served');
    }
    assert.equal((await request(s.sock, 'ping')).ok, true);
  } finally { await s.close(); }
});

test('a pipelined second request while one is in flight gets busy; the first still completes once', async () => {
  const s = await serve({}, { slow: true });
  try {
    await request(s.sock, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const c = net.connect(s.sock); c.setEncoding('utf8'); let got = '';
    c.on('data', (d) => { got += d; });
    await new Promise((r) => c.once('connect', r));
    const first = JSON.stringify({ id: 'a', method: 'modelCall', params: { run_id: 'r1', request_id: 'q1', provider: 'mockprov', model: FREE_MODEL, messages: msgs } });
    c.write(`${first}\n`);
    await until(() => s.hits() === 1);
    c.write(`${JSON.stringify({ id: 'b', method: 'ping' })}\n${JSON.stringify({ id: 'c', method: 'ping' })}\nnot json\n`);
    await until(() => got.split('\n').filter(Boolean).length >= 3);
    const early = got.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(early.map((r) => [r.id, r.error?.code]), [['b', 'busy'], ['c', 'busy'], [null, 'busy']]);
    s.release();
    await until(() => got.split('\n').filter(Boolean).length >= 4);
    const last = JSON.parse(got.split('\n').filter(Boolean)[3]);
    assert.equal(last.id, 'a'); assert.equal(last.result.message.content, 'late');
    assert.equal(s.hits(), 1);
    c.write(`${JSON.stringify({ id: 'd', method: 'ping' })}\n`); // idle again: served
    await until(() => got.split('\n').filter(Boolean).length >= 5);
    assert.equal(JSON.parse(got.split('\n').filter(Boolean)[4]).ok, true);
    c.destroy();
  } finally { await s.close(); }
});

test('max_connections caps simultaneous connections', async () => {
  const s = await serve({ max_connections: 2 });
  try {
    const open = async () => { const c = net.connect(s.sock); c.on('error', () => {}); let closed = false; c.on('close', () => { closed = true; }); await new Promise((r) => c.once('connect', r)); await sleep(60); return { c, closed: () => closed }; };
    const a = await open(); const b = await open(); const third = await open();
    assert.equal(a.closed(), false); assert.equal(b.closed(), false);
    assert.equal(third.closed(), true, 'the third connection is dropped');
    a.c.destroy(); await sleep(60);
    assert.equal((await request(s.sock, 'ping')).ok, true, 'a freed slot is usable again');
    b.c.destroy();
  } finally { await s.close(); }
});

// ---- pid file ----
test('pid file: written at start, removed on stop; a stale one (dead pid) is replaced; a live non-gateway pid is replaced', async () => {
  const t = tempHome(); const api = makeApi(t).api;
  writeFileSync(t.config.pid_file, `${2 ** 22 + 99}\n`);
  const a = createGatewayServer({ api, config: t.config, procInfo: () => null });
  await a.start();
  assert.equal(Number(readFileSync(t.config.pid_file, 'utf8')), process.pid);
  await a.stop();
  assert.equal(existsSync(t.config.pid_file), false, 'removed on shutdown');
  writeFileSync(t.config.pid_file, '123\n');
  const b = createGatewayServer({ api, config: t.config, procInfo: (pid) => ({ pid, uid: 1, cmdline: '/usr/bin/node something-else.js' }) });
  await b.start(); await b.stop();
  writeFileSync(t.config.pid_file, 'garbage\n');
  const c = createGatewayServer({ api, config: t.config }); await c.start(); await c.stop();
});

test('pid file naming a live gateway makes startup refuse (and leaves that pid file alone)', async () => {
  const t = tempHome(); const api = makeApi(t).api;
  writeFileSync(t.config.pid_file, '123\n');
  const gw = createGatewayServer({ api, config: t.config, procInfo: (pid) => ({ pid, uid: 1, cmdline: '/usr/bin/node /opt/bin/agent gateway' }) });
  await assert.rejects(gw.start(), /already running \(pid 123\)/);
  assert.equal(readFileSync(t.config.pid_file, 'utf8'), '123\n'); assert.equal(existsSync(t.config.socket_path), false);
});

// ---- a real gateway process: shutdown on signals, real pid verification ----
for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`a real gateway process removes its pid file and socket on ${sig}, and a second start refuses while it runs`, async () => {
    const t = tempHome();
    const child = spawn(process.execPath, [join(root, 'bin', 'agent'), 'gateway'], { env: { ...process.env, AGENT_HOME: t.home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((res) => child.once('exit', (code, signal) => res({ code, signal })));
    try {
      await until(() => existsSync(t.config.pid_file) && existsSync(t.config.socket_path), 8000);
      const pong = await request(t.config.socket_path, 'ping');
      assert.equal(pong.ok, true); assert.equal(pong.result.pid, child.pid);
      const info = processInfo(child.pid);
      assert.equal(isGatewayCmdline(info.cmdline), true, info.cmdline); assert.equal(info.uid, process.getuid());
      const second = createGatewayServer({ api: makeApi(t).api, config: t.config });
      await assert.rejects(second.start(), /already running/);
      child.kill(sig);
      const r = await exited;
      assert.equal(r.code, 0, `exit ${JSON.stringify(r)} ${err}`);
      assert.equal(existsSync(t.config.pid_file), false, 'pid file removed'); assert.equal(existsSync(t.config.socket_path), false, 'socket removed');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  });
}
