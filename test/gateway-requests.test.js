import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, makeApi, makeGrant, chatOk, PAID_TABLE, FREE_MODEL } from './gateway-helpers.js';
import { createGatewayServer } from '../src/gateway/server.js';
import { request } from '../src/gateway/client.js';

/** Count reserve and settle events across the ledger files of a store directory. */
function ledgerCounts(dir) {
  const text = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
  const count = (k) => (text.match(new RegExp(`"(?:type|kind|event)":"${k}"`, 'g')) ?? []).length;
  return { reserve: count('reserve'), settle: count('settle') };
}
const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });

/** A provider mock whose answer is held until the test releases it. */
async function slowProvider() {
  const hits = []; const waiting = [];
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); waiting.push(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(chatOk('slow answer').body)); }); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, hits, release: () => waiting.splice(0).forEach((f) => f()), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };

async function setup({ priceTable, idleMs } = {}) {
  const prov = await slowProvider();
  const t = tempHome({ baseUrl: prov.url });
  const a = makeApi({ ...t, priceTable });
  const gw = createGatewayServer({ api: a.api, config: t.config, idleMs }); // real layout check: the temp home is built exactly as required
  await gw.start();
  return { prov, gw, sock: t.config.socket_path, ...a, close: async () => { await gw.stop(); await prov.close(); } };
}
const paid = { run_id: 'r1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 100 };

test('modelCall requires a request_id', async () => {
  const s = await setup();
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    for (const request_id of [undefined, '', 5, 'has space', 'x'.repeat(101)]) {
      const r = await call(s.api, 'modelCall', { run_id: 'r1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, request_id });
      assert.equal(r.ok, false); assert.equal(r.error.code, 'invalid_request');
    }
    assert.equal(s.prov.hits.length, 0, 'nothing reached the provider');
  } finally { await s.close(); }
});

test('a repeated request_id returns the recorded result and never reserves or settles twice', async () => {
  const s = await setup({ priceTable: PAID_TABLE });
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const first = call(s.api, 'modelCall', { ...paid, request_id: 'q1' });
    await until(() => s.prov.hits.length === 1);
    const dup = call(s.api, 'modelCall', { ...paid, request_id: 'q1' }); // arrives while the first is still in flight
    s.prov.release();
    const [a, b] = await Promise.all([first, dup]);
    assert.equal(a.ok, true); assert.deepEqual(b.result, a.result);
    const again = await call(s.api, 'modelCall', { ...paid, request_id: 'q1' }); // and again after it settled
    assert.deepEqual(again.result, a.result);
    assert.equal(s.prov.hits.length, 1, 'one provider request');
    assert.deepEqual(ledgerCounts(s.store.dir), { reserve: 1, settle: 1 });
  } finally { await s.close(); }
});

test('the same request_id with different parameters is refused and costs nothing', async () => {
  const s = await setup();
  try {
    await call(s.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const base = { run_id: 'r1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, request_id: 'q1' };
    const p = call(s.api, 'modelCall', base); await until(() => s.prov.hits.length === 1); s.prov.release(); assert.equal((await p).ok, true);
    for (const change of [{ messages: [{ role: 'user', content: 'other' }] }, { max_tokens: 7 }, { model: 'vendor/n:free' }]) {
      const r = await call(s.api, 'modelCall', { ...base, ...change });
      assert.equal(r.ok, false); assert.equal(r.error.code, 'request_id_conflict');
    }
    assert.equal(s.prov.hits.length, 1);
  } finally { await s.close(); }
});

test('client disconnects mid-call: the gateway still settles once and a retry on a new connection gets the same result', async () => {
  const s = await setup({ priceTable: PAID_TABLE });
  try {
    assert.equal((await request(s.sock, 'openRun', { run_id: 'r1', grant: makeGrant() })).ok, true);
    const c = net.connect(s.sock);
    await new Promise((r) => c.once('connect', r));
    c.write(JSON.stringify({ id: 7, method: 'modelCall', params: { ...paid, request_id: 'q1' } }) + '\n');
    await until(() => s.prov.hits.length === 1);
    c.destroy(); // client gone while the provider is still thinking
    await new Promise((r) => setTimeout(r, 50));
    s.prov.release();
    await until(() => s.api.openRuns().length === 1);
    let retry;
    for (let i = 0; i < 50 && !retry?.ok; i += 1) { retry = await request(s.sock, 'modelCall', { ...paid, request_id: 'q1' }); if (!retry.ok) await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.result.message.content, 'slow answer');
    assert.equal(s.prov.hits.length, 1, 'the retry did not call the provider again');
    const end = await request(s.sock, 'endRun', { run_id: 'r1', outcome: 'ok' });
    assert.equal(end.ok, true);
    assert.deepEqual(ledgerCounts(s.store.dir), { reserve: 1, settle: 1 });
  } finally { await s.close(); }
});

test('no idle timeout fires while a request is in flight, and the connection is still usable after', async () => {
  const s = await setup({ idleMs: 120 });
  try {
    await request(s.sock, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const c = net.connect(s.sock); c.setEncoding('utf8');
    let got = ''; let closed = false;
    c.on('data', (d) => { got += d; }); c.on('close', () => { closed = true; });
    await new Promise((r) => c.once('connect', r));
    c.write(JSON.stringify({ id: 1, method: 'modelCall', params: { run_id: 'r1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, request_id: 'slow1' } }) + '\n');
    await until(() => s.prov.hits.length === 1);
    await new Promise((r) => setTimeout(r, 500)); // several idle periods pass with the request still in flight
    assert.equal(closed, false, 'connection must stay open while a request is in flight');
    s.prov.release();
    await until(() => got.includes('\n'));
    assert.equal(JSON.parse(got.split('\n')[0]).result.message.content, 'slow answer');
    await until(() => closed, 2000); // quiet now: the idle timeout applies again
    assert.equal(closed, true);
  } finally { await s.close(); }
});

test('an idle connection with nothing in flight is closed after the idle timeout', async () => {
  const s = await setup({ idleMs: 80 });
  try {
    const c = net.connect(s.sock);
    const t0 = Date.now();
    await new Promise((r) => { c.on('close', r); c.on('error', r); });
    assert.ok(Date.now() - t0 >= 60 && Date.now() - t0 < 2000, `closed after ${Date.now() - t0}ms`);
  } finally { await s.close(); }
});
