import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder, EXIT } from '../src/builder-adapter.js';
import { parsePriceTable, createMeter, GrantError } from '../src/grant/index.js';
import { openLedger } from '../src/ledger/index.js';
import { startMock, toolCall, reply, tempRepo, makeGrant, FAKE_KEY } from './builder-mock.js';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const EXPIRES = '2030-01-01T01:00:00Z';
const PRICES = parsePriceTable({ schema_version: '1', models: { 'v/paid': { input_micro_per_mtok: 1_000_000, output_micro_per_mtok: 1_000_000 } } }); // 1 micro-USD per token
const tledger = () => join(mkdtempSync(join(tmpdir(), 'ledger-int-')), 'l');
const usage = (u) => (r) => ({ ...r, body: { ...r.body, usage: u } });
const write = (name) => toolCall('write_file', { path: `docs/${name}.md`, content: 'x' }, `c${name}`);
const done = (u = { prompt_tokens: 100, completion_tokens: 5 }) => usage(u)(reply({ content: 'done' }));
const ledgerFile = (dir) => join(dir, readdirSync(dir).find((n) => n.endsWith('.jsonl')));
const issues = (r, k) => r.entries.filter((e) => e.kind === 'issue' && e.description.startsWith(`[kind: ${k}]`));

async function run({ ledger, grant, handler, ledgerOpt }) {
  const mock = await startMock(handler);
  const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_MODEL: 'v/paid', AGENT_BUILDER_BASE_URL: mock.url }, cwd: tmpdir() });
  try {
    const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'Write docs', grant, workdir: tempRepo() } },
      { sleep: async () => {}, now: () => T0, priceTable: PRICES, ...(ledgerOpt === undefined ? { ledger } : { ledger: ledgerOpt }) });
    return { result, mock };
  } finally { await mock.close(); }
}

test('ledger meter: a second run on the same grant refuses at preflight (exit 2, no request) when run 1 used the budget', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ budget: { max_usd: 0.01, max_tool_calls: 10 }, expires_at: EXPIRES });
  const a = await run({ ledger, grant, handler: () => usage({ prompt_tokens: 100, completion_tokens: 5, cost: '0.01' })(reply({ content: 'done' })) });
  assert.equal(a.result.exit_code, EXIT.OK);
  const b = await run({ ledger, grant, handler: () => done() });
  assert.equal(b.result.exit_code, EXIT.REFUSED);
  assert.equal(b.result.status, 'refused');
  assert.equal(b.mock.requests.length, 0, 'refused before any network call');
  assert.match(b.result.entries.find((e) => e.outcome === 'blocked').reason, /exhausted/);
});

test('ledger meter: run 2 is clamped to the budget run 1 left', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ budget: { max_usd: 0.01, max_tool_calls: 10 }, expires_at: EXPIRES }); // 10000 micro
  await run({ ledger, grant, handler: () => usage({ prompt_tokens: 100, completion_tokens: 5, cost: '0.0065' })(reply({ content: 'done' })) }); // settles 6500
  const b = await run({ ledger, grant, handler: () => done() });
  assert.equal(b.result.exit_code, EXIT.OK);
  const sent = b.mock.requests[0].body.max_tokens;
  assert.ok(sent < 3500 && sent >= 1, `max_tokens ${sent} must fit the 3500 micro-USD left, not the full 10000`);
});

test('ledger meter: a crashed run holding an open reservation keeps counting against the next run', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ budget: { max_usd: 0.01, max_tool_calls: 10 }, expires_at: EXPIRES });
  const crashed = ledger.openRun(grant, 'run-crashed'); crashed.reserve({ micro: 10000 }); // never settled, never ended
  const b = await run({ ledger, grant, handler: () => done() });
  assert.equal(b.result.exit_code, EXIT.REFUSED);
  assert.equal(b.mock.requests.length, 0);
});

test('ledger meter: max_tool_calls is shared across runs through the adapter', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ budget: { max_usd: 0.01, max_tool_calls: 2 }, expires_at: EXPIRES });
  const handler = (_r, n) => (n === 1 ? usage({ prompt_tokens: 100, completion_tokens: 5 })(reply({ tool_calls: [write('a'), write('b')] }, 'tool_calls')) : done());
  const a = await run({ ledger, grant, handler });
  assert.equal(a.result.exit_code, EXIT.OK);
  const b = await run({ ledger, grant, handler });
  assert.equal(b.result.exit_code, EXIT.REFUSED);
  assert.equal(b.mock.requests.length, 0);
});

test('ledger meter: a missing ledger refuses at preflight with no network call', async () => {
  const grant = makeGrant({ expires_at: EXPIRES });
  const a = await run({ grant, ledgerOpt: null, handler: () => done() });
  assert.equal(a.result.exit_code, EXIT.REFUSED); assert.equal(a.mock.requests.length, 0);
  const b = await run({ grant, ledgerOpt: {}, handler: () => done() });
  assert.equal(b.result.exit_code, EXIT.REFUSED); assert.equal(b.mock.requests.length, 0);
});

test('ledger meter: an unreadable or corrupted ledger refuses at preflight', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ expires_at: EXPIRES });
  ledger.openRun(grant, 'earlier').reserve({ micro: 1 });
  appendFileSync(ledgerFile(dir), 'garbage\n');
  const a = await run({ ledger, grant, handler: () => done() });
  assert.equal(a.result.exit_code, EXIT.REFUSED); assert.equal(a.mock.requests.length, 0);
});

test('ledger meter: a mutated grant under the same task_id refuses at preflight', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ expires_at: EXPIRES });
  await run({ ledger, grant, handler: () => done() });
  const b = await run({ ledger, grant: { ...grant, budget: { max_usd: 50, max_tool_calls: 10 } }, handler: () => done() });
  assert.equal(b.result.exit_code, EXIT.REFUSED); assert.equal(b.mock.requests.length, 0);
});

test('ledger meter: a ledger failure mid-run is a grant stop (exit 4) with a grant-exceeded issue naming ledger', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ expires_at: EXPIRES });
  const { result, mock } = await run({ ledger, grant, handler: (_r, n) => { if (n === 1) appendFileSync(ledgerFile(dir), 'corrupted\n'); return done(); } });
  assert.equal(result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.equal(result.status, 'grant-exceeded');
  assert.equal(mock.requests.length, 1);
  assert.match(issues(result, 'grant-exceeded')[0].description, /"ledger"/);
});

test('ledger meter: the run_end is written, and the API key never appears in any ledger line', async () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ expires_at: EXPIRES });
  const { result } = await run({ ledger, grant, handler: (_r, n) => (n === 1 ? usage({ prompt_tokens: 100, completion_tokens: 5 })(reply({ tool_calls: [write('k')] }, 'tool_calls')) : done()) });
  assert.equal(result.exit_code, EXIT.OK);
  const text = readFileSync(ledgerFile(dir), 'utf8');
  assert.ok(!text.includes(FAKE_KEY) && !text.includes('sk-or') && !text.includes('FAKEKEY'));
  const types = text.trim().split('\n').map((l) => JSON.parse(l).type);
  assert.equal(types[0], 'open'); assert.equal(types.at(-1), 'run_end');
  assert.deepEqual(ledger.remaining(grant).unended_runs ?? [], []);
});

test('ledger meter: the stricter of in-memory and ledger accounting wins, and a meter built with a bad ledger throws', () => {
  const dir = tledger(); const ledger = openLedger(dir);
  const grant = makeGrant({ budget: { max_usd: 0.001, max_tool_calls: 10 }, expires_at: EXPIRES });
  const other = ledger.openRun(grant, 'other'); other.reserve({ micro: 600 });
  const m = createMeter(grant, { now: () => T0, priceTable: PRICES, model: 'v/paid', ledger, runId: 'mine' });
  const r = m.reserve({ model: 'v/paid', input: 'x'.repeat(100), max_tokens: 500 });
  assert.ok(r.reserved_micro <= 400 && r.max_tokens < 500, 'clamped to the 400 micro-USD the ledger shows, not the 1000 in memory');
  assert.throws(() => m.reserve({ model: 'v/paid', input: 'x'.repeat(100), max_tokens: 500 }), (e) => e instanceof GrantError && e.limit === 'budget');
  assert.throws(() => createMeter(grant, { now: () => T0, priceTable: PRICES, model: 'v/paid', ledger: {}, runId: 'x' }), (e) => e.limit === 'ledger');
});
