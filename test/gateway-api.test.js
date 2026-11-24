import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome, makeApi, startMock, chatOk, allFiles, makeGrant, FAKE_KEY, PAID_TABLE, FREE_MODEL } from './gateway-helpers.js';
import { METHODS } from '../src/gateway/api.js';

const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });

async function setup({ handler, priceTable, now } = {}) {
  const mock = await startMock(handler ?? (() => chatOk()));
  const t = tempHome({ baseUrl: mock.url });
  const logs = [];
  const a = makeApi({ ...t, priceTable, logs, now });
  return { mock, t, logs, ...a, close: () => mock.close() };
}
const open = (api, run_id = 'run-1', extra = {}) => call(api, 'openRun', { run_id, grant: makeGrant(), ...extra });

test('modelCall for a free model works against the existing mock server and returns remaining budget', async () => {
  const s = await setup();
  try {
    assert.equal((await open(s.api)).ok, true);
    const r = await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, max_tokens: 50 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.message.content, 'hi');
    assert.equal(r.result.cost_micro, 0);
    assert.equal(r.budget.remaining_micro, 1_000_000);
    assert.equal(r.budget.max_tool_calls, 10);
    assert.equal(s.mock.requests.length, 1);
    assert.equal(s.mock.requests[0].url, '/v1/chat/completions');
    assert.equal(s.mock.requests[0].body.model, FREE_MODEL);
    assert.equal(s.mock.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
  } finally { await s.close(); }
});

test('no key appears in any response, log, journal, record or spend file even when the provider echoes it', async () => {
  const echo = (rec) => chatOk(`echo ${rec.headers.authorization} and ${FAKE_KEY}`);
  const s = await setup({ handler: echo });
  try {
    const responses = [];
    responses.push(await open(s.api));
    responses.push(await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: FREE_MODEL, messages: msgs }));
    responses.push(await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'nope', model: FREE_MODEL, messages: msgs }));
    responses.push(await call(s.api, 'journalRead', { run_id: 'run-1' }));
    responses.push(await call(s.api, 'endRun', { run_id: 'run-1', outcome: 'ok' }));
    const text = JSON.stringify(responses) + s.logs.join('\n');
    assert.ok(!text.includes(FAKE_KEY), 'key in a response or log');
    assert.ok(!/Bearer sk-/.test(text));
    assert.match(text, /REDACTED/);
    for (const f of allFiles(s.t.home)) if (!f.path.endsWith('credentials.json')) assert.ok(!f.text.includes(FAKE_KEY), `key in ${f.path}`);
  } finally { await s.close(); }
});

test('the credential store is read from its own file and a missing credential refuses before any request', async () => {
  const mock = await startMock(() => chatOk());
  const t = tempHome({ baseUrl: mock.url, withCredentials: false });
  try {
    assert.throws(() => makeApi(t), /credential file is missing/);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(t.home, 'credentials.json'), JSON.stringify({ providers: { other: FAKE_KEY } }), { mode: 0o600 });
    const { api } = makeApi(t);
    await open(api);
    const r = await call(api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: FREE_MODEL, messages: msgs });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'credential');
    assert.equal(mock.requests.length, 0);
  } finally { await mock.close(); }
});

test('a credential file with loose mode or a foreign shape is refused at load', async () => {
  const { chmodSync, writeFileSync } = await import('node:fs');
  const { loadCredentials } = await import('../src/gateway/credentials.js');
  const t = tempHome({});
  chmodSync(t.config.credentials_file, 0o644);
  assert.throws(() => loadCredentials(t.config.credentials_file), /mode 0600/);
  chmodSync(t.config.credentials_file, 0o600);
  assert.throws(() => loadCredentials(t.config.credentials_file, { uid: process.getuid() + 1 }), /not owned/);
  writeFileSync(t.config.credentials_file, JSON.stringify({ providers: { p: 'k' } }), { mode: 0o600 });
  assert.throws(() => loadCredentials(t.config.credentials_file), /malformed key/);
  writeFileSync(t.config.credentials_file, JSON.stringify({ providers: { p: FAKE_KEY }, extra: 1 }), { mode: 0o600 });
  assert.throws(() => loadCredentials(t.config.credentials_file), /must be/);
});

test('settle uses the higher of reported and computed cost', async () => {
  // price 1 micro-USD per token: 100 prompt + 5 completion tokens compute to 105 micro-USD
  const lowReport = await setup({ priceTable: PAID_TABLE, handler: () => chatOk('x', { prompt_tokens: 100, completion_tokens: 5, cost: '0.00000001' }) });
  const highReport = await setup({ priceTable: PAID_TABLE, handler: () => chatOk('x', { prompt_tokens: 100, completion_tokens: 5, cost: '0.0005' }) });
  const noReport = await setup({ priceTable: PAID_TABLE, handler: () => chatOk('x', { prompt_tokens: 100, completion_tokens: 5 }) });
  try {
    const run = async (s) => { await open(s.api); return call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 200 }); };
    const a = await run(lowReport); const b = await run(highReport); const c = await run(noReport);
    assert.equal(a.result.cost_micro, 105, 'computed beats a lower report');
    assert.equal(b.result.cost_micro, 500, 'reported beats a lower computed');
    assert.equal(c.result.cost_micro, 105);
    assert.equal(b.budget.settled_micro, 500);
    assert.equal(b.budget.remaining_micro, 1_000_000 - 500);
  } finally { await lowReport.close(); await highReport.close(); await noReport.close(); }
});

test('the tracked (empty) price table refuses every paid model before any network call', async () => {
  const s = await setup();
  try {
    await open(s.api);
    for (const model of ['paid/model', 'vendor/m', 'x:freeish']) {
      const r = await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model, messages: msgs });
      assert.equal(r.ok, false, model); assert.equal(r.error.code, 'price', model);
      assert.ok(r.budget, 'budget still returned on a refusal');
    }
    const rv = await call(s.api, 'reserve', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', input: 'x' });
    assert.equal(rv.error.code, 'price');
    assert.equal(s.mock.requests.length, 0);
  } finally { await s.close(); }
});

test('prices are keyed by provider AND model: a bare model key or another provider does not match', async () => {
  const { parsePriceTable } = await import('../src/grant/index.js');
  const table = parsePriceTable({ schema_version: '1', models: { 'paid/model': { input_micro_per_mtok: 1, output_micro_per_mtok: 1 }, 'otherprov|paid/model': { input_micro_per_mtok: 1, output_micro_per_mtok: 1 } } });
  const s = await setup({ priceTable: table });
  try {
    await open(s.api);
    const r = await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', messages: msgs });
    assert.equal(r.error.code, 'price');
    assert.equal(s.mock.requests.length, 0);
  } finally { await s.close(); }
});

test('reserve, settle and release go through the grant meter and ledger; a runner-supplied usage is ignored', async () => {
  const s = await setup({ priceTable: PAID_TABLE });
  try {
    const grant = makeGrant();
    await call(s.api, 'openRun', { run_id: 'run-1', grant });
    const rv = await call(s.api, 'reserve', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', input: 'hello', max_tokens: 100 });
    assert.equal(rv.ok, true);
    assert.ok(rv.result.reserved_micro >= 100);
    assert.equal(rv.budget.reserved_micro, rv.result.reserved_micro);
    const st = await call(s.api, 'settle', { run_id: 'run-1', reservation_id: rv.result.reservation_id, usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } });
    assert.equal(st.result.cost_micro, rv.result.reserved_micro, 'untrusted usage: settled at the full reservation');
    const rv2 = await call(s.api, 'reserve', { run_id: 'run-1', provider: 'mockprov', model: FREE_MODEL, input: 'x' });
    const rl = await call(s.api, 'release', { run_id: 'run-1', reservation_id: rv2.result.reservation_id });
    assert.equal(rl.result.cost_micro, 0);
    assert.equal((await call(s.api, 'settle', { run_id: 'run-1', reservation_id: rv2.result.reservation_id })).error.code, 'reservation');
    assert.equal(s.store.read(grant).settled_micro, st.result.cost_micro);
  } finally { await s.close(); }
});

test('provider rejection releases the reservation; a network failure settles at worst case', async () => {
  const s = await setup({ priceTable: PAID_TABLE, handler: () => ({ status: 500, body: { error: { message: 'boom' } } }) });
  try {
    await open(s.api);
    const r = await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 100 });
    assert.equal(r.error.code, 'provider_rejected');
    assert.equal(r.budget.settled_micro, 0); assert.equal(r.budget.reserved_micro, 0);
  } finally { await s.close(); }
  const down = tempHome({ baseUrl: 'http://127.0.0.1:1/v1' });
  const d = makeApi({ ...down, priceTable: PAID_TABLE });
  await open(d.api);
  const r2 = await call(d.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', messages: msgs, max_tokens: 100 });
  assert.equal(r2.error.code, 'provider_error');
  assert.ok(r2.budget.settled_micro > 0, 'worst case settled');
});

test('the budget is enforced: a call whose worst case does not fit is refused', async () => {
  const s = await setup({ priceTable: PAID_TABLE });
  try {
    await call(s.api, 'openRun', { run_id: 'run-1', grant: makeGrant({ budget: { max_usd: 0.000001, max_tool_calls: 5 } }) });
    const r = await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: 'paid/model', messages: [{ role: 'user', content: 'a long enough message to exceed one micro-usd budget' }] });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'budget');
    assert.equal(s.mock.requests.length, 0);
  } finally { await s.close(); }
});

test('run record carries start, end, duration, model, provider, outcome and capability_added events', async () => {
  let t = Date.parse('2030-01-01T00:00:00Z');
  const s = await setup({ now: () => t });
  try {
    await call(s.api, 'openRun', { run_id: 'run-9', grant: makeGrant({ expires_at: '2031-01-01T00:00:00Z' }) });
    t += 1500;
    await call(s.api, 'modelCall', { run_id: 'run-9', provider: 'mockprov', model: FREE_MODEL, messages: msgs });
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-9', capability_added: { name: 'git-push', version: '1.0.0' } })).ok, true);
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-9', capability_added: { name: 'web-fetch' } })).ok, true);
    t += 500;
    const end = await call(s.api, 'endRun', { run_id: 'run-9', outcome: 'ok' });
    const rec = end.result.record;
    assert.equal(rec.started_at, '2030-01-01T00:00:00.000Z');
    assert.equal(rec.ended_at, '2030-01-01T00:00:02.000Z');
    assert.equal(rec.duration_ms, 2000);
    assert.equal(rec.model, FREE_MODEL); assert.equal(rec.provider, 'mockprov'); assert.equal(rec.outcome, 'ok');
    assert.deepEqual(rec.capability_added.map((c) => c.name), ['git-push', 'web-fetch']);
    assert.equal((await call(s.api, 'journalRead', { run_id: 'run-9' })).result.record.outcome, 'ok');
    // closed run takes no more calls
    assert.equal((await call(s.api, 'modelCall', { run_id: 'run-9', provider: 'mockprov', model: FREE_MODEL, messages: msgs })).error.code, 'run_not_open');
  } finally { await s.close(); }
});

test('journalAppend validates against the unchanged journal schema and refuses bad, duplicate or foreign entries', async () => {
  const s = await setup();
  try {
    await open(s.api);
    const entry = { schema_version: '1', id: 'e1', run_id: 'run-1', at: '2030-01-01T00:00:00Z', kind: 'attempt', tried: 'x', outcome: 'ok', reason: 'fine' };
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1', entry })).ok, true);
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1', entry })).error.code, 'invalid_request', 'duplicate id');
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1', entry: { ...entry, id: 'e2', run_id: 'other' } })).ok, false);
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1', entry: { ...entry, id: 'e3', outcome: 'ok', started: 'now' } })).ok, false, 'run-record fields cannot be smuggled into a journal entry');
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1' })).ok, false);
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1', entry, capability_added: { name: 'x' } })).ok, false);
    assert.equal((await call(s.api, 'journalAppend', { run_id: 'run-1', capability_added: { name: 'Bad Name' } })).ok, false);
    const rd = await call(s.api, 'journalRead', { run_id: 'run-1', kind: 'attempt' });
    assert.equal(rd.result.entries.length, 1);
  } finally { await s.close(); }
});

test('pushBranch and requestMerge return a structured not-implemented refusal', async () => {
  const s = await setup();
  try {
    for (const m of ['pushBranch', 'requestMerge']) {
      const r = await call(s.api, m, { anything: 1 });
      assert.deepEqual(r.error, { code: 'not_implemented', message: 'not implemented in M1a' });
      assert.equal(r.ok, false);
    }
    assert.equal(METHODS.length, 10);
  } finally { await s.close(); }
});

test('malformed requests, unknown methods and unknown runs fail closed with no internal detail', async () => {
  const s = await setup();
  try {
    for (const bad of [null, [], 'x', { method: 5 }, { method: 'nope' }, { method: 'reserve', params: [] }, { method: 'reserve', params: { run_id: 'ghost' } }]) {
      const r = await s.api.handle(bad);
      assert.equal(r.ok, false);
      assert.ok(!JSON.stringify(r).includes('at '), 'no stack');
    }
    assert.equal((await call(s.api, 'openRun', { run_id: 'bad id!', grant: makeGrant() })).error.code, 'invalid_request');
    assert.equal((await call(s.api, 'openRun', { run_id: 'r2', grant: { nope: 1 } })).error.code, 'invalid_grant');
    await open(s.api);
    assert.equal((await open(s.api)).error.code, 'run_exists');
  } finally { await s.close(); }
});

test('the spend sidecar and ledger record the calls; spend files hold no key', async () => {
  const s = await setup();
  try {
    await open(s.api);
    await call(s.api, 'modelCall', { run_id: 'run-1', provider: 'mockprov', model: FREE_MODEL, messages: msgs });
    const spend = readdirSync(s.t.config.runs_dir).filter((n) => n.endsWith('.spend.jsonl'));
    assert.equal(spend.length, 1);
    assert.match(readFileSync(join(s.t.config.runs_dir, spend[0]), 'utf8'), /"event":"settle"/);
    assert.equal(s.store.report().failed, false);
  } finally { await s.close(); }
});
