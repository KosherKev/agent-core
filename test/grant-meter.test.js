import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeter, GrantError, isMeter, usdToMicro, microToUsd, callCost, parsePriceTable, loadPriceTable, priceFor, CLOCK_TOLERANCE_MS } from '../src/grant/index.js';
import { makeGrant } from './builder-mock.js';

// $1 per million input tokens, $2 per million output tokens.
const PRICES = parsePriceTable({ schema_version: '1', models: { 'v/paid': { input_micro_per_mtok: 1_000_000, output_micro_per_mtok: 2_000_000 } } });
const T0 = Date.parse('2030-01-01T00:00:00Z');
const clock = (start = T0) => { const c = { t: start, now: () => c.t }; return c; };
const grantOf = (usd, extra = {}) => makeGrant({ budget: { max_usd: usd, max_tool_calls: 3 }, expires_at: '2030-01-01T01:00:00Z', ...extra });
const meterOf = (usd = 1, over = {}) => { const c = clock(); return { c, m: createMeter(grantOf(usd), { now: c.now, priceTable: PRICES, model: 'v/paid', ...over }) }; };
const throwsLimit = (fn, limit) => assert.throws(fn, (e) => e instanceof GrantError && e.limit === limit, `expected GrantError(${limit})`);

test('money: USD decimals convert to integer micro-USD without float error', () => {
  assert.equal(usdToMicro('0.1'), 100000);
  assert.equal(usdToMicro(0.1 + 0.2), 300000);
  assert.equal(usdToMicro('1.0000001', 'ceil'), 1000001);
  assert.equal(usdToMicro('1.0000001', 'floor'), 1000000);
  assert.equal(usdToMicro(1e-7, 'ceil'), 1);
  assert.equal(microToUsd(1234567), '1.234567');
  for (const bad of ['-1', '1e3', 'abc', '', '1.2.3', NaN, Infinity, -0.5, '99999999999999999']) assert.throws(() => usdToMicro(bad), RangeError, String(bad));
  assert.equal(callCost(1, 0, { input_micro_per_mtok: 1, output_micro_per_mtok: 1 }), 1, 'always rounds up');
});

test('meter: reservation refuses when the worst-case cost exceeds the remaining budget', () => {
  const { m } = meterOf(0.001); // 1000 micro-USD
  // Input alone (about 200 bytes at $1/M) is cheap, but 8192 output tokens at $2/M is 16384 micro; the clamp fits it, so shrink the budget below one input estimate instead.
  const big = 'x'.repeat(2_000_000); // 2M bytes of input = 2,000,000 micro at $1/M, far over 1000 micro
  throwsLimit(() => m.reserve({ input: big, max_tokens: 10 }), 'budget');
  assert.equal(m.snapshot().reserved_micro, 0, 'a refused reservation holds nothing');
});

test('meter: max_tokens is clamped so the worst case fits the remaining budget', () => {
  const { m } = meterOf(0.001); // budget 1000 micro
  const r = m.reserve({ input: 'hi', max_tokens: 100000 });
  assert.ok(r.max_tokens < 100000 && r.max_tokens >= 1);
  assert.ok(r.reserved_micro <= 1000);
  assert.ok(callCost(Buffer.byteLength(JSON.stringify('hi')), r.max_tokens + 1, PRICES.models.get('v/paid')) > 1000, 'the clamp is the largest value that fits');
  const log = m.spendLog();
  assert.equal(log[0].clamped, true);
  const { m: roomy } = meterOf(1);
  assert.equal(roomy.reserve({ input: 'hi', max_tokens: 500 }).max_tokens, 500, 'no clamp when it fits');
});

test('meter: settle uses the provider cost when present and the computed cost otherwise', () => {
  const { m } = meterOf(1);
  const a = m.reserve({ input: 'a', max_tokens: 1000 });
  assert.equal(m.settle(a, { prompt_tokens: 10, completion_tokens: 10, cost: '0.000123' }), 123);
  const b = m.reserve({ input: 'b', max_tokens: 1000 });
  // 1000 in at $1/M = 1000 micro; 500 out at $2/M = 1000 micro
  assert.equal(m.settle(b, { prompt_tokens: 1000, completion_tokens: 500 }), 2000);
  assert.deepEqual(m.spendLog().filter((l) => l.event === 'settle').map((l) => l.source), ['provider', 'computed']);
  assert.equal(m.snapshot().settled_micro, 2123);
});

test('meter: missing usage on a paid model settles at the full worst-case reservation, never zero', () => {
  const { m } = meterOf(1);
  for (const usage of [undefined, null, {}, { prompt_tokens: 'x', completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }]) {
    const r = m.reserve({ input: 'a', max_tokens: 100 });
    assert.equal(m.settle(r, usage), r.reserved_micro);
  }
  assert.ok(m.spendLog().filter((l) => l.event === 'settle').every((l) => l.source === 'worst_case' && l.cost_micro > 0));
  const { m: free } = meterOf(1, { model: 'v/x:free' });
  assert.equal(free.settle(free.reserve({ input: 'a', max_tokens: 100 }), null), 0, ':free is price zero');
});

test('meter: an unknown paid model refuses at creation; a :free model needs no price entry', () => {
  throwsLimit(() => createMeter(grantOf(1), { now: clock().now, priceTable: PRICES, model: 'v/unknown' }), 'price');
  throwsLimit(() => createMeter(grantOf(1), { now: clock().now, priceTable: undefined, model: 'v/paid' }), 'price');
  assert.ok(isMeter(createMeter(grantOf(1), { now: clock().now, priceTable: PRICES, model: 'v/unknown:free' })));
  const { m } = meterOf(1);
  throwsLimit(() => m.reserve({ model: 'v/other', input: 'a' }), 'price');
});

test('meter: expiry is checked before every model call and every tool call', () => {
  const { c, m } = meterOf(1);
  m.checkTool();
  c.t = Date.parse('2030-01-01T01:00:00Z') - 1;
  m.reserve({ input: 'a', max_tokens: 10 });
  c.t = Date.parse('2030-01-01T01:00:00Z');
  throwsLimit(() => m.reserve({ input: 'a', max_tokens: 10 }), 'expiry');
  throwsLimit(() => m.checkTool(), 'expiry');
  throwsLimit(() => m.checkExpiry(), 'expiry');
});

test('meter: the clock moving backwards by more than the tolerance refuses; small jitter does not', () => {
  const { c, m } = meterOf(1);
  m.checkExpiry();
  c.t = T0 - CLOCK_TOLERANCE_MS + 1;
  assert.doesNotThrow(() => m.checkExpiry());
  c.t = T0 - CLOCK_TOLERANCE_MS - 1;
  throwsLimit(() => m.checkExpiry(), 'clock');
  throwsLimit(() => m.checkTool(), 'clock');
  c.t = NaN;
  throwsLimit(() => m.checkExpiry(), 'clock');
});

test('meter: the tool-call limit counts calls and refuses the next one', () => {
  const { m } = meterOf(1);
  for (let i = 0; i < 3; i++) m.checkTool();
  throwsLimit(() => m.checkTool(), 'tool_calls');
});

test('meter: it has no way to mutate the grant (attempts throw or have no effect)', () => {
  const grant = grantOf(1);
  const { m } = meterOf(1, {});
  const meter = createMeter(grant, { now: clock().now, priceTable: PRICES, model: 'v/paid' });
  assert.throws(() => { meter.grant.budget.max_usd = 1000; }, TypeError);
  assert.throws(() => { meter.grant.budget.max_tool_calls = 1000; }, TypeError);
  assert.throws(() => { meter.grant.expires_at = '2099-01-01T00:00:00Z'; }, TypeError);
  assert.throws(() => { meter.grant.scope.paths.push('.'); }, TypeError);
  assert.throws(() => { meter.setGrant = () => {}; }, TypeError);
  assert.throws(() => { meter.reserve = () => ({}); }, TypeError);
  assert.throws(() => { delete meter.checkTool; }, TypeError);
  const names = Object.keys(meter).concat(Object.getOwnPropertyNames(meter));
  assert.equal(names.filter((n) => /^(set[A-Z_]|update|extend|widen|raise|increase)/.test(n)).length, 0);
  // Mutating the caller's own object after creation does not change the meter's copy.
  grant.budget.max_usd = 1000; grant.budget.max_tool_calls = 1000; grant.expires_at = '2099-01-01T00:00:00Z';
  assert.equal(meter.grant.budget.max_usd, 1);
  assert.equal(meter.snapshot().max_tool_calls, 3);
  assert.equal(meter.snapshot().budget_micro, 1_000_000);
  assert.ok(m);
});

test('meter: a missing or malformed grant field refuses (fail closed)', () => {
  const ok = grantOf(1);
  const cases = [null, undefined, 'x', {}, { ...ok, budget: undefined }, { ...ok, budget: { max_usd: 1 } }, { ...ok, budget: { max_tool_calls: 3 } }, { ...ok, budget: { max_usd: 0, max_tool_calls: 3 } }, { ...ok, budget: { max_usd: -1, max_tool_calls: 3 } }, { ...ok, budget: { max_usd: '1', max_tool_calls: 3 } }, { ...ok, budget: { max_usd: 1, max_tool_calls: 1.5 } }, { ...ok, budget: { max_usd: 1e-9, max_tool_calls: 3 } }, { ...ok, expires_at: undefined }, { ...ok, expires_at: 'soon' }];
  for (const g of cases) assert.throws(() => createMeter(g, { now: clock().now, priceTable: PRICES, model: 'v/paid' }), GrantError);
  assert.throws(() => createMeter(ok, { now: 'no', priceTable: PRICES, model: 'v/paid' }), GrantError);
});

test('meter: any internal error refuses (a throwing clock, a throwing sink)', () => {
  const { m } = meterOf(1, { now: () => { throw new Error('boom'); } });
  throwsLimit(() => m.checkTool(), 'internal');
  throwsLimit(() => m.reserve({ input: 'a' }), 'internal');
  const c = clock();
  const bad = createMeter(grantOf(1), { now: c.now, priceTable: PRICES, model: 'v/paid', sink: () => { throw new Error('disk full'); } });
  throwsLimit(() => bad.reserve({ input: 'a', max_tokens: 10 }), 'internal');
});

test('meter: float rounding case, thousands of tiny costs sum exactly in micro-USD', () => {
  const { m } = meterOf(1);
  let float = 0;
  for (let i = 0; i < 3000; i++) { const r = m.reserve({ input: 'a', max_tokens: 1 }); m.settle(r, { cost: 0.000003 }); float += 0.1; }
  assert.equal(m.snapshot().settled_micro, 9000);
  assert.notEqual(float, 300, 'sanity: naive float addition of 0.1 does drift');
  const { m: m2 } = meterOf(1);
  for (let i = 0; i < 10; i++) m2.settle(m2.reserve({ input: 'a', max_tokens: 1 }), { cost: '0.1' });
  assert.equal(m2.snapshot().settled_micro, 1_000_000);
  assert.equal(microToUsd(m2.snapshot().settled_micro), '1.000000');
  assert.ok(Number.isSafeInteger(m2.snapshot().remaining_micro));
});

test('meter: reservations hold budget until settled, and a release returns it', () => {
  const { m } = meterOf(0.001);
  const a = m.reserve({ input: 'a', max_tokens: 100 });
  assert.equal(m.snapshot().reserved_micro, a.reserved_micro);
  m.release(a, 'http 429');
  assert.equal(m.snapshot().reserved_micro, 0);
  assert.equal(m.snapshot().settled_micro, 0);
  throwsLimit(() => m.settle(a, null), 'internal');
});

test('prices: the tracked price file loads, validates and lists no paid model without an explicit price', () => {
  const r = loadPriceTable();
  assert.ok(r.table, r.error);
  assert.equal(priceFor(r.table, 'p/q:free').input_micro_per_mtok, 0);
  assert.equal(priceFor(r.table, 'p/q'), null);
  assert.throws(() => parsePriceTable({ schema_version: '1', models: { a: { input_micro_per_mtok: 1.5, output_micro_per_mtok: 1 } } }));
  assert.throws(() => parsePriceTable({ schema_version: '2', models: {} }));
  assert.equal(loadPriceTable('/nonexistent/prices.json').table, null);
});
