import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tempHome, makeGrant, chatOk, FREE_MODEL } from './gateway-helpers.js';
import { createFileLedgerStore } from '../src/gateway/store.js';
import { createRunStore } from '../src/gateway/runs.js';
import { loadCredentials, makeRedactor } from '../src/gateway/credentials.js';
import { createGatewayApi } from '../src/gateway/api.js';
import { loadPriceTable, createSpendSink } from '../src/grant/index.js';

const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });
const req = { run_id: 'r1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, max_tokens: 100 };
const runFile = (t, id = 'r1') => join(t.config.runs_dir, `${id}.jsonl`);

/** An api whose run store and provider transport are the test's own. `hits` counts provider calls. */
function build(t, { runsOpts = {} } = {}) {
  const credentials = loadCredentials(t.config.credentials_file);
  const redact = makeRedactor(credentials.secrets());
  const hits = [];
  const wrapped = async (...a) => { hits.push(1); return okTransport(...a); };
  const store = createFileLedgerStore(t.config.ledger_dir, {});
  const runs = createRunStore(t.config.runs_dir, runsOpts);
  const api = createGatewayApi({ config: t.config, store, runs, credentials, priceTable: loadPriceTable().table, transport: wrapped, makeSink: (id) => createSpendSink(join(t.config.runs_dir, `${id}.spend.jsonl`), redact) });
  return { api, runs, hits, store };
}
async function okTransport() { return new Response(JSON.stringify(chatOk('ok').body), { status: 200, headers: { 'content-type': 'application/json' } }); }

// ---- item 1: the request_start line is flushed before the provider is called ----
test('item 1: the provider is not called when the file sync fails, and the error is its own code', async () => {
  const t = tempHome();
  const { api, hits } = build(t, { runsOpts: { fileSync: { file: () => { throw new Error('EIO'); }, dir: () => {} } } });
  await call(api, 'openRun', { run_id: 'r1', grant: makeGrant() });
  const r = await call(api, 'modelCall', { ...req, request_id: 'q1' });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'request_start_not_durable');
  assert.equal(hits.length, 0, 'the provider must not be called');
  // a retry with the same id is answered from the record and still never calls the provider
  const again = await call(api, 'modelCall', { ...req, request_id: 'q1' });
  assert.equal(again.ok, false); assert.equal(hits.length, 0);
});

test('item 1: a rejected (async) file sync and a failing directory sync both fail closed', async () => {
  const t = tempHome();
  const bad = { file: () => {}, dir: () => { throw new Error('EIO'); } };
  // a brand new file, so the directory sync is exercised
  await assert.rejects(() => createRunStore(t.config.runs_dir, { fileSync: bad }).recordRequestStart('fresh', 'q', 'fp'), /could not be flushed/);
  await assert.rejects(() => createRunStore(t.config.runs_dir, { fileSync: { file: async () => { throw new Error('EIO'); }, dir: () => {} } }).recordRequestStart('fresh2', 'q', 'fp'), /could not be flushed/);
  const { api, hits } = build(t, { runsOpts: { fileSync: { file: async () => { throw new Error('EIO'); }, dir: () => {} } } });
  await call(api, 'openRun', { run_id: 'r2', grant: makeGrant() });
  const r = await call(api, 'modelCall', { ...req, run_id: 'r2', request_id: 'q1' });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'request_start_not_durable'); assert.equal(hits.length, 0);
});

test('item 1: the provider is not called before the sync resolves, and is called after it does', async () => {
  const t = tempHome();
  let release; const gate = new Promise((res) => { release = res; });
  const calls = [];
  const fileSync = { file: async (fd) => { calls.push('file'); await gate; calls.push('file-resolved'); }, dir: () => { calls.push('dir'); } };
  const { api, hits } = build(t, { runsOpts: { fileSync } });
  await call(api, 'openRun', { run_id: 'r1', grant: makeGrant() });
  const pending = call(api, 'modelCall', { ...req, request_id: 'q1' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls, ['file']); assert.equal(hits.length, 0, 'still waiting for the sync: the provider has not been called');
  release();
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(hits.length, 1);
  assert.deepEqual(calls, ['file', 'file-resolved']);
});

test('item 1: the directory is flushed only when the write created the run file', async () => {
  const t = tempHome();
  const calls = [];
  const runs = createRunStore(t.config.runs_dir, { fileSync: { file: () => calls.push('file'), dir: (p) => calls.push(`dir:${p === t.config.runs_dir}`) } });
  await runs.recordRequestStart('fresh', 'q1', 'fp');
  assert.deepEqual(calls, ['file', 'dir:true']);
  calls.length = 0;
  await runs.recordRequestStart('fresh', 'q2', 'fp'); // file exists now
  assert.deepEqual(calls, ['file']);
  assert.match(readFileSync(runFile(t, 'fresh'), 'utf8'), /"request_id":"q2"/);
});

// ---- item 2: request_outcome_unknown only claims a reservation the run file shows ----
const fpOf = (p) => createHash('sha256').update(JSON.stringify([p.provider, p.model, p.messages, p.max_tokens ?? null])).digest('hex');

test('item 2: start recorded with no reservation: the message does not claim one', async () => {
  const t = tempHome();
  const first = build(t);
  await call(first.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
  await first.runs.recordRequestStart('r1', 'q1', fpOf({ ...req })); // a crash right after the start line, before anything was reserved
  const second = build(t); // a restart over the same files
  const r = await call(second.api, 'modelCall', { ...req, request_id: 'q1' });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'request_outcome_unknown');
  assert.match(r.error.message, /no reservation/); assert.doesNotMatch(r.error.message, /reservation is kept/);
  assert.equal(second.hits.length, 0);
});

test('item 2: start recorded with a reservation: the message says it is kept', async () => {
  const t = tempHome();
  const first = build(t);
  await call(first.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
  await first.runs.recordRequestStart('r1', 'q1', fpOf({ ...req }));
  first.runs.recordRequestReserved('r1', 'q1', 'res-1');
  assert.equal(first.runs.findRequest('r1', 'q1').reserved, true);
  const r = await call(build(t).api, 'modelCall', { ...req, request_id: 'q1' });
  assert.equal(r.error.code, 'request_outcome_unknown'); assert.match(r.error.message, /its reservation is kept/);
});

test('item 2: a real call writes the reservation line between the start line and the outcome', async () => {
  const t = tempHome();
  const a = build(t);
  await call(a.api, 'openRun', { run_id: 'r1', grant: makeGrant() });
  assert.equal((await call(a.api, 'modelCall', { ...req, request_id: 'q1' })).ok, true);
  const types = readFileSync(runFile(t), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
  assert.ok(types.indexOf('request_start') < types.indexOf('request_reserved') && types.indexOf('request_reserved') < types.indexOf('request'), types.join(','));
  assert.equal(a.runs.findRequest('r1', 'q1').type, 'request');
});
