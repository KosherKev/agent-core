import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, makeApi, makeGrant, chatOk, PAID_TABLE, FREE_MODEL } from './gateway-helpers.js';
import { createGatewayServer } from '../src/gateway/server.js';

const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ledgerCounts(dir) {
  const text = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
  const count = (k) => (text.match(new RegExp(`"(?:type|kind|event)":"${k}"`, 'g')) ?? []).length;
  return { reserve: count('reserve'), settle: count('settle') };
}
async function provider({ auto = false } = {}) {
  const hits = []; const waiting = [];
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push(1);
      const answer = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(chatOk('answer').body)); };
      if (auto) answer(); else waiting.push(answer);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, hits, release: () => waiting.splice(0).forEach((f) => f()), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const paid = { run_id: 'r1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 100 };
const runFile = (t, id = 'r1') => join(t.config.runs_dir, `${id}.jsonl`);

test('restart, case (i): a settled request is answered from the persisted record even though the run is no longer open (same bytes, conflict on a different fingerprint)', async () => {
  const prov = await provider({ auto: true });
  const t = tempHome({ baseUrl: prov.url });
  try {
    const grant = makeGrant();
    const a1 = makeApi({ ...t });
    await call(a1.api, 'openRun', { run_id: 'r1', grant });
    const first = await call(a1.api, 'modelCall', { ...paid, model: FREE_MODEL, request_id: 'q1' });
    assert.equal(first.ok, true);
    const hits = prov.hits.length;
    const a2 = makeApi({ ...t }); // a restart: a new gateway instance over the same files; no run is open
    assert.deepEqual(a2.api.openRuns(), []);
    const again = await call(a2.api, 'modelCall', { ...paid, model: FREE_MODEL, request_id: 'q1' });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(JSON.stringify(again.result), JSON.stringify(first.result));
    assert.equal(prov.hits.length, hits, 'the provider was not called again');
    const conflict = await call(a2.api, 'modelCall', { ...paid, model: FREE_MODEL, messages: [{ role: 'user', content: 'other' }], request_id: 'q1' });
    assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'request_id_conflict');
    // an unknown request_id on a closed run keeps the old behaviour
    const unknown = await call(a2.api, 'modelCall', { ...paid, model: FREE_MODEL, request_id: 'q2' });
    assert.equal(unknown.error.code, 'run_not_open');
    // and the same holds for a run that was ended normally in the same instance
    await call(a1.api, 'endRun', { run_id: 'r1', outcome: 'ok' });
    const afterEnd = await call(a1.api, 'modelCall', { ...paid, model: FREE_MODEL, request_id: 'q1' });
    assert.equal(afterEnd.ok, true); assert.equal(JSON.stringify(afterEnd.result), JSON.stringify(first.result));
    assert.equal(prov.hits.length, hits);
  } finally { await prov.close(); }
});

test('restart, case (i) for a failed call: the recorded error is replayed, not re-run', async () => {
  const prov = await provider({ auto: true });
  const t = tempHome({ baseUrl: prov.url });
  try {
    const grant = makeGrant();
    const a1 = makeApi({ ...t, priceTable: PAID_TABLE });
    await call(a1.api, 'openRun', { run_id: 'r1', grant });
    const bad = await call(a1.api, 'modelCall', { ...paid, model: 'paid/unpriced', request_id: 'q1' });
    assert.equal(bad.ok, false);
    const a2 = makeApi({ ...t, priceTable: PAID_TABLE });
    const again = await call(a2.api, 'modelCall', { ...paid, model: 'paid/unpriced', request_id: 'q1' });
    assert.equal(again.ok, false); assert.equal(again.error.code, bad.error.code);
  } finally { await prov.close(); }
});

test('restart, case (ii): a call cut off before its outcome was persisted answers request_outcome_unknown, never calls the provider and never reserves again', async () => {
  const prov = await provider();
  const t = tempHome({ baseUrl: prov.url });
  const a1 = makeApi({ ...t, priceTable: PAID_TABLE });
  const gw = createGatewayServer({ api: a1.api, config: t.config, shutdownGraceMs: 200 });
  await gw.start();
  try {
    const grant = makeGrant();
    await call(a1.api, 'openRun', { run_id: 'r1', grant });
    const c = net.connect(t.config.socket_path); c.on('error', () => {}); c.setEncoding('utf8');
    await new Promise((r) => c.once('connect', r));
    c.write(JSON.stringify({ id: 1, method: 'modelCall', params: { ...paid, request_id: 'q1' } }) + '\n');
    await until(() => prov.hits.length === 1);
    await gw.stop(); // the grace period ends with the provider still holding the call
    assert.deepEqual(ledgerCounts(a1.store.dir), { reserve: 1, settle: 0 });
    const hits = prov.hits.length;
    // restart over the same files
    const a2 = makeApi({ ...t, priceTable: PAID_TABLE });
    const before = a2.store.read(grant).remaining_micro;
    for (let i = 0; i < 2; i += 1) {
      const r = await call(a2.api, 'modelCall', { ...paid, request_id: 'q1' });
      assert.equal(r.ok, false); assert.equal(r.error.code, 'request_outcome_unknown');
    }
    assert.equal(prov.hits.length, hits, 'no provider call');
    assert.deepEqual(ledgerCounts(a2.store.dir), { reserve: 1, settle: 0 }, 'no second reservation, existing one kept');
    assert.equal(a2.store.read(grant).remaining_micro, before);
    // the run cannot be reopened under the same id either, so the unfinished call cannot be re-bought by any route
    assert.equal((await call(a2.api, 'openRun', { run_id: 'r1', grant })).error.code, 'run_exists');
    assert.equal((await call(a2.api, 'modelCall', { ...paid, request_id: 'q2' })).error.code, 'run_not_open');
    assert.deepEqual(ledgerCounts(a2.store.dir), { reserve: 1, settle: 0 });
    // a different fingerprint under the same id is still a conflict
    assert.equal((await call(a2.api, 'modelCall', { ...paid, max_tokens: 7, request_id: 'q1' })).error.code, 'request_id_conflict');
  } finally { prov.release(); await gw.stop({ force: true }); await prov.close(); }
});

test('a start line is written before the call reserves, and a finished call supersedes it', async () => {
  const prov = await provider({ auto: true });
  const t = tempHome({ baseUrl: prov.url });
  try {
    const a = makeApi({ ...t });
    await call(a.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    await call(a.api, 'modelCall', { ...paid, model: FREE_MODEL, request_id: 'q1' });
    const types = readFileSync(runFile(t), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    assert.ok(types.indexOf('request_start') >= 0 && types.indexOf('request_start') < types.indexOf('request'), types.join(','));
    assert.equal(a.runs.findRequest('r1', 'q1').pending, undefined);
    assert.equal(a.runs.findRequest('r1', 'nope'), null);
  } finally { await prov.close(); }
});

test('shutdown waits for a detached call: the client hangs up mid-call, stop() holds until the outcome is persisted, then a retry gets the stored result', async () => {
  const prov = await provider();
  const t = tempHome({ baseUrl: prov.url });
  const a1 = makeApi({ ...t, priceTable: PAID_TABLE });
  const gw = createGatewayServer({ api: a1.api, config: t.config, shutdownGraceMs: 5000 });
  await gw.start();
  try {
    const grant = makeGrant();
    await call(a1.api, 'openRun', { run_id: 'r1', grant });
    const c = net.connect(t.config.socket_path); c.on('error', () => {});
    await new Promise((r) => c.once('connect', r));
    c.write(JSON.stringify({ id: 1, method: 'modelCall', params: { ...paid, request_id: 'q1' } }) + '\n');
    await until(() => prov.hits.length === 1);
    c.destroy(); // the client is gone, the call is still running
    await sleep(100);
    let stopped = false;
    const stopping = gw.stop().then(() => { stopped = true; });
    await sleep(300);
    assert.equal(stopped, false, 'stop() must wait for the detached call');
    assert.equal(a1.runs.findRequest('r1', 'q1').pending, true, 'not persisted yet');
    prov.release();
    await stopping;
    const rec = a1.runs.findRequest('r1', 'q1');
    assert.equal(rec.ok, true); assert.ok(rec.result, 'the outcome is persisted before stop() returned');
    assert.equal(existsSync(t.config.socket_path), false);
    assert.deepEqual(ledgerCounts(a1.store.dir), { reserve: 1, settle: 1 });
    const a2 = makeApi({ ...t, priceTable: PAID_TABLE });
    const retry = await call(a2.api, 'modelCall', { ...paid, request_id: 'q1' });
    assert.equal(retry.ok, true); assert.equal(retry.result.message.content, 'answer');
    assert.equal(prov.hits.length, 1);
    assert.deepEqual(ledgerCounts(a2.store.dir), { reserve: 1, settle: 1 });
  } finally { prov.release(); await gw.stop({ force: true }); await prov.close(); }
});

test('shutdown deadline: a detached call still running at shutdown_grace_ms stays reserved, stop() does not wait past the deadline and settles nothing itself', async () => {
  const prov = await provider();
  const t = tempHome({ baseUrl: prov.url });
  const a1 = makeApi({ ...t, priceTable: PAID_TABLE });
  const gw = createGatewayServer({ api: a1.api, config: t.config, shutdownGraceMs: 300 });
  await gw.start();
  try {
    await call(a1.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    const c = net.connect(t.config.socket_path); c.on('error', () => {});
    await new Promise((r) => c.once('connect', r));
    c.write(JSON.stringify({ id: 1, method: 'modelCall', params: { ...paid, request_id: 'q1' } }) + '\n');
    await until(() => prov.hits.length === 1);
    c.destroy();
    const t0 = Date.now();
    await gw.stop();
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 2500, `took ${took} ms`);
    assert.deepEqual(ledgerCounts(a1.store.dir), { reserve: 1, settle: 0 });
    assert.equal(a1.runs.findRequest('r1', 'q1').pending, true);
  } finally { prov.release(); await gw.stop({ force: true }); await prov.close(); }
});

test('round 2 low: if the start line cannot be written nothing is reserved or sent, and a persist failure is logged, not silent', async (t) => {
  if (process.getuid?.() === 0) { t.skip('root ignores file modes'); return; }
  const { chmodSync } = await import('node:fs');
  const prov = await provider({ auto: true });
  const tt = tempHome({ baseUrl: prov.url });
  try {
    const a = makeApi({ ...tt, priceTable: PAID_TABLE });
    await call(a.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    chmodSync(runFile(tt), 0o400);
    const r = await call(a.api, 'modelCall', { ...paid, request_id: 'q1' });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'internal');
    assert.equal(prov.hits.length, 0); assert.deepEqual(ledgerCounts(a.store.dir), { reserve: 0, settle: 0 });
    assert.ok(a.logs.some((l) => /could not be persisted/.test(l)), a.logs.join('|'));
    chmodSync(runFile(tt), 0o600);
  } finally { await prov.close(); }
});
