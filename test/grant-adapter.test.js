import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder, callModel, dispatchTool, EXIT } from '../src/builder-adapter.js';
import { confine, isLockedPath, ConfineError } from '../src/builder-confine.js';
import { parsePriceTable, createMeter, GrantError } from '../src/grant/index.js';
import { validateJournalEntry } from '../src/validators.js';
import { startMock, toolCall, reply, tempRepo, makeGrant, FAKE_KEY } from './builder-mock.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.parse('2030-01-01T00:00:00Z');
const EXPIRES = '2030-01-01T01:00:00Z';
// 1 micro-USD per token, both ways: easy arithmetic.
const PRICES = parsePriceTable({ schema_version: '1', models: { 'v/paid': { input_micro_per_mtok: 1_000_000, output_micro_per_mtok: 1_000_000 } } });
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const kinds = (r, k) => r.entries.filter((e) => e.kind === k);
const issuesOf = (r, k) => kinds(r, 'issue').filter((e) => e.description.startsWith(`[kind: ${k}]`));
const withUsage = (r, usage) => ({ ...r, body: { ...r.body, usage } });
const write = (name, i = 0) => toolCall('write_file', { path: `docs/${name}.md`, content: 'x' }, `c${name}${i}`);
const spendOf = (result) => readFileSync(result.spend_path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function run({ model = 'v/paid', handler, grant, now, prices = PRICES, env = {}, fetch, workdir }) {
  const mock = await startMock(handler);
  const dir = workdir ?? tempRepo();
  const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_MODEL: model, AGENT_BUILDER_BASE_URL: mock.url, ...env }, cwd: tmpdir() });
  const clock = { t: T0, now: () => clock.t };
  try {
    const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'Write docs', grant: grant ?? makeGrant({ expires_at: EXPIRES }), workdir: dir } }, { sleep: async () => {}, now: now ?? clock.now, priceTable: prices, ...(fetch ? { fetch } : {}) });
    return { result, mock, dir, clock };
  } finally { await mock.close(); }
}

test('budget exhausted mid-run stops with the grant-exceeded exit code, commits work so far and journals the numbers', async () => {
  const grant = makeGrant({ budget: { max_usd: 0.002, max_tool_calls: 10 }, expires_at: EXPIRES }); // 2000 micro-USD
  const { result, mock, dir } = await run({ grant, handler: () => withUsage(reply({ tool_calls: [write('a')] }, 'tool_calls'), { prompt_tokens: 1000, completion_tokens: 10, cost: '0.0018' }) });
  assert.equal(result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.equal(result.status, 'grant-exceeded');
  assert.equal(mock.requests.length, 1, 'the second call was refused before any network call');
  assert.deepEqual(result.files_written, ['docs/a.md']);
  assert.match(gitOut(dir, 'log', '-1', '--format=%s'), /^builder\(grant-exceeded\)/);
  const [iss] = issuesOf(result, 'grant-exceeded');
  assert.match(iss.description, /"budget"/);
  assert.match(iss.description, /remaining_micro=200/);
  assert.equal(validateJournalEntry(iss).valid, true);
  assert.notEqual(result.exit_code, EXIT.RATE_LIMITED);
});

test('the request max_tokens is clamped to what the remaining budget can pay for, and the spend record shows it', async () => {
  const grant = makeGrant({ budget: { max_usd: 0.003, max_tool_calls: 10 }, expires_at: EXPIRES }); // 3000 micro-USD
  const { result, mock } = await run({ grant, handler: () => withUsage(reply({ content: 'done' }), { prompt_tokens: 1200, completion_tokens: 5 }) });
  assert.equal(result.exit_code, EXIT.OK);
  const sent = mock.requests[0].body.max_tokens;
  assert.ok(Number.isInteger(sent) && sent >= 1 && sent < 8192, `clamped from 8192, got ${sent}`);
  const [reserve, settle] = spendOf(result);
  assert.equal(reserve.event, 'reserve'); assert.equal(reserve.clamped, true); assert.equal(reserve.max_tokens, sent);
  assert.equal(settle.event, 'settle'); assert.equal(settle.source, 'computed'); assert.equal(settle.cost_micro, 1205);
});

test('expiry reached mid-run: the clock passes expiry during a model reply, so the tool call it asked for is refused', async () => {
  const t = { v: T0 };
  const { result, dir, mock } = await run({ now: () => t.v, handler: () => { t.v = Date.parse(EXPIRES) + 1; return reply({ tool_calls: [write('a')] }, 'tool_calls'); } });
  assert.equal(result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.equal(mock.requests.length, 1);
  assert.equal(existsSync(join(dir, 'docs/a.md')), false, 'the tool never ran');
  assert.match(issuesOf(result, 'grant-exceeded')[0].description, /"expiry"/);
});

test('expiry reached mid-run: the clock passes expiry after a tool call, so the next model call is never sent', async () => {
  const dir = tempRepo();
  const now = () => (existsSync(join(dir, 'docs/a.md')) ? Date.parse(EXPIRES) + 5 : T0);
  const { result, mock } = await run({ workdir: dir, now, handler: () => reply({ tool_calls: [write('a')] }, 'tool_calls') });
  assert.equal(result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.equal(mock.requests.length, 1, 'no second request');
  assert.deepEqual(result.files_written, ['docs/a.md'], 'work so far is committed');
  assert.match(issuesOf(result, 'grant-exceeded')[0].description, /"expiry"/);
});

test('the clock moving backwards mid-run stops the run', async () => {
  const dir = tempRepo();
  const now = () => (existsSync(join(dir, 'docs/a.md')) ? T0 - 60_000 : T0);
  const { result, mock } = await run({ workdir: dir, now, handler: () => reply({ tool_calls: [write('a')] }, 'tool_calls') });
  assert.equal(result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.equal(mock.requests.length, 1);
  assert.match(issuesOf(result, 'grant-exceeded')[0].description, /"clock"/);
});

test('an unknown paid model with a nonzero budget refuses before any network call (the mock records zero requests)', async () => {
  const { result, mock, dir } = await run({ model: 'v/unpriced', handler: () => reply({ content: 'never' }) });
  assert.equal(mock.requests.length, 0);
  assert.equal(result.exit_code, EXIT.REFUSED);
  assert.equal(result.status, 'refused');
  assert.ok(kinds(result, 'attempt').some((e) => e.outcome === 'blocked' && /no trusted price/.test(e.reason)));
  assert.equal(gitOut(dir, 'log', '--format=%s').trim(), 'init');
  // The tracked price file ships with no paid models, so the default table refuses every paid model too.
  const d = await run({ model: 'v/paid', prices: null, handler: () => reply({ content: 'never' }) });
  assert.equal(d.mock.requests.length, 0);
  assert.equal(d.result.exit_code, EXIT.REFUSED);
});

test('a refused expiry at preflight makes zero requests and exits 2 (no offset, date-only, locale, calendar-invalid, padded, past)', async () => {
  for (const bad of ['2030-01-01T01:00:00', '2030-01-01', 'Mon 23 Nov 2030', '2030-02-30T00:00:00Z', ' 2030-01-01T01:00:00Z', '2029-12-31T23:59:59Z']) {
    const { result, mock } = await run({ grant: makeGrant({ expires_at: bad }), handler: () => reply({ content: 'never' }) });
    assert.equal(mock.requests.length, 0, bad);
    assert.equal(result.exit_code, EXIT.REFUSED, bad);
    assert.equal(result.status, 'refused', bad);
  }
  const ok = await run({ grant: makeGrant({ expires_at: '2029-12-31T20:00:00-05:00' }), handler: () => withUsage(reply({ content: 'done' }), { prompt_tokens: 1, completion_tokens: 1 }) });
  assert.equal(ok.result.exit_code, EXIT.OK, 'an equivalent offset notation is accepted');
});

test('a :free model needs no price but still enforces the tool-call limit and expiry', async () => {
  const many = [write('a', 1), write('b', 2), write('c', 3)];
  const a = await run({ model: 'v/m:free', prices: null, grant: makeGrant({ budget: { max_usd: 1, max_tool_calls: 2 }, expires_at: EXPIRES }), handler: () => reply({ tool_calls: many }, 'tool_calls') });
  assert.equal(a.result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.deepEqual(a.result.files_written, ['docs/a.md', 'docs/b.md']);
  assert.match(issuesOf(a.result, 'grant-exceeded')[0].description, /"tool_calls"/);
  assert.ok(spendOf(a.result).every((l) => l.event === 'reserve' || l.cost_micro === 0), 'free spend is zero');
  const t = { v: T0 };
  const b = await run({ model: 'v/m:free', prices: null, now: () => t.v, handler: () => { t.v = Date.parse(EXPIRES); return reply({ tool_calls: [write('z')] }, 'tool_calls'); } });
  assert.equal(b.result.exit_code, EXIT.GRANT_EXCEEDED);
  assert.match(issuesOf(b.result, 'grant-exceeded')[0].description, /"expiry"/);
});

test('missing usage on a paid model settles at the worst case through the adapter', async () => {
  const { result } = await run({ handler: () => reply({ content: 'done' }) });
  const [reserve, settle] = spendOf(result);
  assert.equal(settle.source, 'worst_case');
  assert.equal(settle.cost_micro, reserve.reserved_micro);
});

test('a provider HTTP rejection releases the reservation at zero; a network error settles at the worst case', async () => {
  const a = await run({ handler: () => ({ status: 400, body: { error: { message: 'bad request' } } }) });
  assert.deepEqual(spendOf(a.result).map((l) => l.event), ['reserve', 'release']);
  const b = await run({ fetch: async () => { throw new Error('socket hang up'); }, handler: () => reply({}) });
  const [r, s] = spendOf(b.result);
  assert.equal(s.cost_micro, r.reserved_micro);
});

test('every reserve and settle is an append-only sidecar line, referenced from the journal; the API key is in none of them', async () => {
  const { result, dir } = await run({ handler: (_r, n) => (n === 1 ? withUsage(reply({ tool_calls: [write('a')] }, 'tool_calls'), { prompt_tokens: 100, completion_tokens: 10, cost: 0.00011 }) : withUsage(reply({ content: 'done' }), { prompt_tokens: 120, completion_tokens: 5 })) });
  assert.equal(result.exit_code, EXIT.OK);
  const raw = readFileSync(result.spend_path, 'utf8');
  assert.ok(result.spend_path.startsWith(join(dir, '.agent-runs')));
  assert.ok(!raw.includes(FAKE_KEY) && !/sk-or-|Bearer/i.test(raw));
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  const lines = spendOf(result);
  assert.deepEqual(lines.map((l) => l.event), ['reserve', 'settle', 'reserve', 'settle']);
  assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3, 4]);
  assert.equal(lines[1].source, 'provider'); assert.equal(lines[1].cost_micro, 110);
  assert.equal(lines[3].source, 'computed'); assert.equal(lines[3].cost_micro, 125);
  assert.equal(lines[3].settled_total_micro, 235);
  assert.ok(kinds(result, 'attempt').some((e) => /spend record/.test(e.tried) && e.reason.includes(`${result.run_id}.spend.jsonl`)));
  assert.equal(issuesOf(result, 'contract-gap').filter((e) => /spend record/.test(e.description)).length, 1);
  assert.ok(readdirSync(join(dir, '.agent-runs')).includes(`${result.run_id}.spend.jsonl`));
});

test('the API key never appears in a spend record even when the model id or an error carries it', async () => {
  const { result } = await run({ fetch: async () => { throw new Error(`boom ${FAKE_KEY}`); }, handler: () => reply({}) });
  const raw = readFileSync(result.spend_path, 'utf8');
  assert.ok(raw.length > 0 && !raw.includes(FAKE_KEY));
});

test('the adapter write tools refuse the grant file, the price table and the meter itself', async () => {
  const dir = tempRepo();
  const targets = ['config/prices.json', 'config/anything.json', 'src/grant/meter.js', 'src/grant/index.js', 'grant.json', 'grants/t-1.json', 'fixtures/grant/valid/x.json', 'Config/Prices.JSON', 'SRC/GRANT/meter.js'];
  for (const p of targets) {
    assert.equal(isLockedPath(p), true, p);
    assert.throws(() => confine(dir, p, { write: true, allowedPaths: ['.'] }), (e) => e instanceof ConfineError && e.blocked, p);
  }
  const calls = targets.map((p, i) => toolCall('write_file', { path: p, content: '{"models":{"x/y":{"input_micro_per_mtok":0,"output_micro_per_mtok":0}}}' }, `c${i}`));
  const grant = makeGrant({ scope: { repos: ['agent-core'], paths: ['.'] }, budget: { max_usd: 1, max_tool_calls: 50 }, expires_at: EXPIRES });
  const { result } = await run({ workdir: dir, grant, handler: (_r, n) => (n === 1 ? reply({ tool_calls: calls }, 'tool_calls') : reply({ content: 'done' })) });
  assert.equal(result.exit_code, EXIT.OK);
  assert.equal(result.commit, null);
  assert.equal(kinds(result, 'attempt').filter((e) => e.outcome === 'blocked' && /^tool write_file/.test(e.tried)).length, targets.length);
  for (const p of targets) assert.equal(existsSync(join(dir, p)), false, p);
});

// ---- the chokepoint: no path to the endpoint or to a tool without a meter ----
test('structural: only callModel reaches the endpoint, only dispatchTool touches the worktree, and both demand a meter', () => {
  const src = readFileSync(join(REPO, 'src/builder-adapter.js'), 'utf8');
  const fn = (name) => { const i = src.search(new RegExp(`(async )?function ${name}\\(`)); assert.ok(i >= 0, name); return src.slice(i).split(/\n\}\n/)[0]; };
  // 1. The endpoint is called from exactly one place, inside requestModel, which is reached only through callModel.
  assert.equal((src.match(/fetchFn\(/g) ?? []).length, 1, 'one fetch call site');
  assert.ok(fn('requestModel').includes('fetchFn('));
  assert.equal((src.match(/requestModel\(/g) ?? []).length, 2, 'declaration plus the single call inside callModel');
  assert.ok(fn('callModel').includes('requestModel('));
  assert.ok(fn('callModel').includes('isMeter('));
  assert.ok(fn('requestModel').indexOf('meter.reserve(') < fn('requestModel').indexOf('fetchFn('), 'reserve before fetch');
  // 2. No other source file can reach the network.
  for (const f of readdirSync(join(REPO, 'src'), { recursive: true })) {
    if (!String(f).endsWith('.js') || f === 'builder-adapter.js') continue;
    const t = readFileSync(join(REPO, 'src', f), 'utf8');
    assert.ok(!/\bfetch\s*\(|fetchFn|node:https?|node:net|XMLHttpRequest|WebSocket/.test(t), `${f} must not reach the network`);
  }
  // 3. Tool side effects (reading and writing the worktree) happen only inside dispatchTool, after meter.checkTool().
  const d = fn('dispatchTool');
  assert.ok(d.includes('isMeter(') && d.indexOf('meter.checkTool()') > 0 && d.indexOf('meter.checkTool()') < d.indexOf('confine('));
  const outside = src.replace(d, '');
  for (const op of ['writeFileSync(abs', 'openSync(abs', 'readdirSync(abs', 'confine(workdir']) assert.ok(!outside.includes(op), `${op} outside dispatchTool`);
  assert.equal((src.match(/dispatchTool\(/g) ?? []).length, 2, 'declaration plus the single call in the loop');
  // 4. The adapter never builds a meter from anything but the run's own grant, and refuses when it cannot.
  assert.ok(src.includes('createMeter(task.grant'));
});

test('behavioural: without a real meter, callModel makes no request and dispatchTool runs nothing', async () => {
  const mock = await startMock(() => reply({ content: 'never' }));
  const dir = tempRepo();
  let fetched = 0;
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_MODEL: 'v/paid', AGENT_BUILDER_BASE_URL: mock.url }, cwd: tmpdir() });
    const fakes = [undefined, null, {}, { reserve: () => ({ id: 'r1', max_tokens: 1 }), settle: () => 0, release: () => 0, checkTool: () => 1 }, Object.create(createMeter(makeGrant(), { now: () => T0, priceTable: PRICES, model: 'v/paid' }))];
    for (const meter of fakes) {
      const r = await callModel({ meter, config, messages: [], fetchFn: async () => { fetched += 1; throw new Error('must not be called'); }, sleep: async () => {}, redact: (x) => x, rec: { attempt() {}, issue() {} }, step: 1 });
      assert.equal(r.stop.code, EXIT.GRANT_EXCEEDED);
      assert.ok(r.stop.grant instanceof GrantError);
      assert.throws(() => dispatchTool(meter, { workdir: dir, allowed: ['.'], written: new Set() }, 'write_file', { path: 'docs/x.md', content: 'x' }), GrantError);
    }
    assert.equal(fetched, 0);
    assert.equal(mock.requests.length, 0);
    assert.equal(existsSync(join(dir, 'docs/x.md')), false);
  } finally { await mock.close(); }
});

test('no meter at all (no grant budget fields) refuses before any network call', async () => {
  for (const budget of [undefined, {}, { max_usd: 1 }, { max_tool_calls: 3 }]) {
    const grant = { ...makeGrant({ expires_at: EXPIRES }), budget };
    const { result, mock } = await run({ grant, handler: () => reply({ content: 'never' }) });
    assert.equal(mock.requests.length, 0);
    assert.equal(result.exit_code, EXIT.REFUSED);
  }
});
