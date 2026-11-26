import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, makeGrant, chatOk, FREE_MODEL } from './gateway-helpers.js';
import { createFileLedgerStore } from '../src/gateway/store.js';
import { createRunStore } from '../src/gateway/runs.js';
import { loadCredentials, makeRedactor } from '../src/gateway/credentials.js';
import { createGatewayApi } from '../src/gateway/api.js';
import { loadPriceTable, createSpendSink } from '../src/grant/index.js';

const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });
const req = { run_id: 'r1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, max_tokens: 100, request_id: 'q1' };

/**
 * Like the round 5 rig: sync, reserve and provider calls log into one `events` array. A sync event is named after the last line the run file holds,
 * so 'sync:request' is the flush of an outcome line. `failAt` is a list of event names whose flush throws. `status` is the provider's HTTP status.
 */
function build(t, { failAt = [], status = 200 } = {}) {
  const events = [];
  const lastType = () => { const ls = readFileSync(join(t.config.runs_dir, 'r1.jsonl'), 'utf8').split('\n').filter(Boolean); return JSON.parse(ls[ls.length - 1]).type; };
  const fileSync = {
    file: () => { const e = `sync:${lastType()}`; events.push(e); if (failAt.includes(e)) throw new Error('EIO'); },
    dir: () => { events.push('dir'); if (failAt.includes('dir')) throw new Error('EIO'); },
  };
  const credentials = loadCredentials(t.config.credentials_file);
  const redact = makeRedactor(credentials.secrets());
  const plain = createFileLedgerStore(t.config.ledger_dir, {});
  const store = { ...plain, meterLedger: () => ({ openRun: (grant, runId) => { const h = plain.meterLedger().openRun(grant, runId); return { ...h, reserve: (...a) => { events.push('reserve'); return h.reserve(...a); } }; } }) };
  const runs = createRunStore(t.config.runs_dir, { fileSync });
  const transport = async () => { events.push('provider'); return new Response(JSON.stringify(status === 200 ? chatOk('ok').body : { error: 'no' }), { status, headers: { 'content-type': 'application/json' } }); };
  const api = createGatewayApi({ config: t.config, store, runs, credentials, priceTable: loadPriceTable().table, transport, makeSink: (id) => createSpendSink(join(t.config.runs_dir, `${id}.spend.jsonl`), redact) });
  return { api, events };
}
const open = async (api) => assert.equal((await call(api, 'openRun', { run_id: 'r1', grant: makeGrant() })).ok, true);
const count = (events, e) => events.filter((x) => x === e).length;

test('round 6 (a): a failed request_reserved flush releases the reservation and the provider is never called', async () => {
  const t = tempHome();
  const { api, events } = build(t, { failAt: ['sync:request_reserved'] });
  await open(api); events.length = 0;
  const r = await call(api, 'modelCall', req);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'request_start_not_durable');
  assert.deepEqual(events, ['sync:request_start', 'reserve', 'sync:request_reserved', 'sync:request'], 'the failure outcome line is flushed after the release');
  assert.ok(!events.includes('provider'));
  assert.equal(r.budget.reserved_micro, 0, 'the reservation was released');
  assert.equal(r.budget.settled_micro, 0, 'nothing was paid');
});

test('round 6 (b): after (a) a retry gets the durable record\'s answer and never reserves twice, in the same process and after a restart', async () => {
  const t = tempHome();
  const first = build(t, { failAt: ['sync:request_reserved'] });
  await open(first.api); first.events.length = 0;
  assert.equal((await call(first.api, 'modelCall', req)).ok, false);
  const again = await call(first.api, 'modelCall', req);
  assert.equal(again.ok, false); assert.equal(again.error.code, 'request_start_not_durable');
  assert.equal(count(first.events, 'reserve'), 1);
  // a new gateway over the same run file (the run is not open there): the persisted failure line answers; it never claims "reservation kept"
  const second = build(t);
  const after = await call(second.api, 'modelCall', req);
  assert.equal(after.ok, false); assert.equal(after.error.code, 'request_start_not_durable');
  assert.doesNotMatch(after.error.message, /reservation is kept/);
  assert.equal(count(second.events, 'reserve'), 0); assert.ok(!second.events.includes('provider'));
  // the run file holds the failure outcome line after the reservation line, so the retry is not "outcome unknown"
  const types = readFileSync(join(t.config.runs_dir, 'r1.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
  assert.deepEqual(types.slice(-3), ['request_start', 'request_reserved', 'request']);
});

test('round 6 (b2): when both the request_reserved flush and the outcome-line flush fail, the caller still gets the durability error and a retry never reserves or calls again', async () => {
  const t = tempHome();
  const { api, events } = build(t, { failAt: ['sync:request_reserved', 'sync:request'] });
  await open(api); events.length = 0;
  const r = await call(api, 'modelCall', req);
  assert.equal(r.ok, false); assert.equal(r.error.code, 'request_start_not_durable');
  assert.equal(r.budget.reserved_micro, 0);
  const again = await call(api, 'modelCall', req);
  assert.equal(again.ok, false); assert.equal(again.error.code, 'request_start_not_durable');
  assert.equal(count(events, 'reserve'), 1); assert.ok(!events.includes('provider'));
});

test('round 6 (c): a failed outcome-line flush fails closed (a provider rejection is not reported as the plain provider error, and is not retried)', async () => {
  const t = tempHome();
  const { api, events } = build(t, { failAt: ['sync:request'], status: 500 });
  await open(api); events.length = 0;
  const r = await call(api, 'modelCall', req);
  assert.equal(r.ok, false); assert.equal(r.error.code, 'request_start_not_durable');
  assert.match(r.error.message, /outcome of this request could not be made durable/);
  assert.deepEqual(events, ['sync:request_start', 'reserve', 'sync:request_reserved', 'provider', 'sync:request']);
  const again = await call(api, 'modelCall', req);
  assert.equal(again.ok, false); assert.equal(again.error.code, 'request_start_not_durable');
  assert.equal(count(events, 'provider'), 1); assert.equal(count(events, 'reserve'), 1);
});

test('round 6 (c2): with a healthy disk the failure outcome line is flushed before the caller hears of it, and the plain error is returned', async () => {
  const t = tempHome();
  const { api, events } = build(t, { status: 500 });
  await open(api); events.length = 0;
  const r = await call(api, 'modelCall', req);
  assert.equal(r.ok, false); assert.equal(r.error.code, 'provider_rejected');
  assert.deepEqual(events, ['sync:request_start', 'reserve', 'sync:request_reserved', 'provider', 'sync:request']);
});
