import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, symlinkSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder, EXIT, CONTRACT_GAPS, summarizeJournal, parseRetryAfter } from '../src/builder-adapter.js';
import { BUILDER_CAPABILITIES, validateCapabilities } from '../src/builder-capabilities.js';
import { confine, ConfineError } from '../src/builder-confine.js';
import { validateJournalEntry } from '../src/validators.js';
import { startMock, toolCall, reply, happyScript, tempRepo, makeGrant, FAKE_KEY } from './builder-mock.js';

const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

async function scenario({ model = 'vendor-a/model-a', env = {}, handler, repo = 'agent-core', grant, branch, workdir, opts = {}, goal = 'Write docs/hello.md' }) {
  const mock = await startMock(handler);
  const dir = workdir ?? tempRepo();
  const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_MODEL: model, AGENT_BUILDER_BASE_URL: mock.url, ...env }, cwd: tmpdir() });
  const sleeps = [];
  try {
    const result = await runBuilder({ config, task: { repo, goal, grant: grant ?? makeGrant({ scope: { repos: [repo], paths: ['docs/'] } }), workdir: dir, branch } }, { sleep: async (ms) => { sleeps.push(ms); }, ...opts });
    return { result, mock, dir, sleeps, config };
  } finally { await mock.close(); }
}

const kinds = (r, kind) => r.entries.filter((e) => e.kind === kind);
const issuesOf = (r, k) => kinds(r, 'issue').filter((e) => e.description.startsWith(`[kind: ${k}]`));

test('happy path: two different model IDs both complete against the mock', async () => {
  for (const model of ['vendor-a/model-a', 'vendor-b/model-b:free']) {
    const { result, mock, dir } = await scenario({ model, handler: (_r, n) => happyScript(n) });
    assert.equal(result.status, 'completed', model);
    assert.equal(result.exit_code, EXIT.OK);
    assert.ok(mock.requests.length === 2);
    assert.ok(mock.requests.every((r) => r.body.model === model && r.url === '/v1/chat/completions'));
    assert.equal(mock.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(readFileSync(join(dir, 'docs/hello.md'), 'utf8'), '# Hello\n');
    assert.match(gitOut(dir, 'log', '-1', '--format=%s'), /^builder\(completed\)/);
    assert.equal(gitOut(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'task/mock');
    assert.equal(gitOut(dir, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'no tracked changes left behind');
    assert.deepEqual(result.files_written, ['docs/hello.md']);
    for (const e of result.entries) assert.equal(validateJournalEntry(e).valid, true);
    assert.equal(kinds(result, 'reservation').length, 1);
    assert.ok(kinds(result, 'attempt').some((e) => e.outcome === 'ok'));
  }
});

test('provider preferences pass through to the request when set, and are absent when not', async () => {
  const a = await scenario({ env: { AGENT_BUILDER_PROVIDER_ORDER: 'Foo,Bar', AGENT_BUILDER_ALLOW_FALLBACKS: 'false', AGENT_BUILDER_DATA_COLLECTION: 'deny' }, handler: (_r, n) => happyScript(n) });
  assert.deepEqual(a.mock.requests[0].body.provider, { order: ['Foo', 'Bar'], allow_fallbacks: false, data_collection: 'deny' });
  const b = await scenario({ handler: (_r, n) => happyScript(n) });
  assert.equal('provider' in b.mock.requests[0].body, false);
});

test('free model against a non-allowlisted repo exits before any network call (zero requests)', async () => {
  const { result, mock, dir } = await scenario({ model: 'vendor-b/model-b:free', repo: 'some-private-repo', handler: () => reply({ content: 'should never be called' }) });
  assert.equal(mock.requests.length, 0);
  assert.equal(result.status, 'refused');
  assert.equal(result.exit_code, EXIT.REFUSED);
  assert.ok(kinds(result, 'attempt').some((e) => e.outcome === 'blocked' && /allowlist/i.test(e.reason)));
  assert.equal(gitOut(dir, 'log', '--format=%s').trim(), 'init');
});

test('free model on a repo added to the allowlist is allowed; non-free model is not restricted by it', async () => {
  const a = await scenario({ model: 'x/y:free', repo: 'other', env: { FREE_MODEL_REPO_ALLOWLIST: 'other' }, handler: (_r, n) => happyScript(n) });
  assert.equal(a.result.status, 'completed');
  const b = await scenario({ model: 'x/y', repo: 'other', handler: (_r, n) => happyScript(n) });
  assert.equal(b.result.status, 'completed');
});

test('other preflight refusals make zero requests: no key, expired grant, repo not in grant, bad grant, main branch, wrong branch', async () => {
  const cases = [
    { env: { OPENROUTER_API_KEY: '' } },
    { grant: makeGrant({ expires_at: '2000-01-01T00:00:00Z' }) },
    { grant: makeGrant({ scope: { repos: ['elsewhere'], paths: ['docs/'] } }) },
    { grant: { nope: true } },
    { branch: 'task/other' },
  ];
  for (const c of cases) {
    const { result, mock } = await scenario({ handler: () => reply({ content: 'x' }), ...c });
    assert.equal(mock.requests.length, 0, JSON.stringify(c));
    assert.equal(result.exit_code, EXIT.REFUSED);
  }
  const dir = tempRepo('main-placeholder');
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  const { result, mock } = await scenario({ workdir: dir, handler: () => reply({ content: 'x' }) });
  assert.equal(mock.requests.length, 0);
  assert.equal(result.exit_code, EXIT.REFUSED);
  assert.match(result.entries.find((e) => e.outcome === 'blocked').reason, /branch "main"/);
});

test('the API key never appears in journal, mirror file, summary, commits, errors or results', async () => {
  const leaky = (_r, n) => n === 1
    ? reply({ tool_calls: [toolCall('write_file', { path: 'docs/a.md', content: 'ok' })] }, 'tool_calls')
    : { status: 500, body: { error: { message: `upstream exploded, saw Authorization: Bearer ${FAKE_KEY} and ${FAKE_KEY}` } } };
  const { result, dir } = await scenario({ handler: leaky });
  assert.equal(result.status, 'failed');
  const haystacks = [
    JSON.stringify(result), result.summary, JSON.stringify(result.entries),
    readFileSync(result.journal_path, 'utf8'), readFileSync(result.capabilities_path, 'utf8'),
    gitOut(dir, 'log', '-p', '--all'), gitOut(dir, 'reflog'),
  ];
  for (const h of haystacks) { assert.ok(!h.includes(FAKE_KEY), 'key leaked'); assert.ok(!/sk-or-v1/.test(h), 'key shape leaked'); }
  assert.ok(result.entries.some((e) => e.kind === 'attempt' && e.reason.includes('[REDACTED]')));
});

test('a network error whose message contains the key is redacted everywhere', async () => {
  const dir = tempRepo();
  const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY }, cwd: tmpdir() });
  const boom = async () => { const e = new Error(`connect ECONNREFUSED using ${FAKE_KEY}`); e.stack = `Error: ${FAKE_KEY}\n at x`; throw e; };
  const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant(), workdir: dir } }, { fetch: boom });
  assert.equal(result.exit_code, EXIT.FAILED);
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY) && !readFileSync(result.journal_path, 'utf8').includes(FAKE_KEY));
});

test('an unexpected internal exception is caught, redacted, journaled; nothing thrown', async () => {
  const dir = tempRepo();
  const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY }, cwd: tmpdir() });
  const bad = { ...makeGrant() }; // valid grant but a throwing fetch implementation property access
  const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: bad, workdir: dir } }, { fetch: () => { throw new TypeError(`bad ${FAKE_KEY}`); } });
  assert.equal(result.exit_code, EXIT.FAILED);
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
});

test('429 with Retry-After: bounded retries, stop cleanly, exit 3, rate-limit issue, work committed', async () => {
  const h = (_r, n) => n === 1
    ? reply({ tool_calls: [toolCall('write_file', { path: 'docs/partial.md', content: 'partial work' })] }, 'tool_calls')
    : { status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'Rate limit exceeded: free-models-per-min' } } };
  const { result, mock, sleeps, dir } = await scenario({ handler: h });
  assert.equal(EXIT.RATE_LIMITED, 3);
  assert.equal(result.exit_code, 3);
  assert.equal(result.status, 'rate-limited');
  assert.deepEqual(sleeps, [2000, 2000, 2000], 'honours Retry-After, max 3 retries');
  assert.equal(mock.requests.length, 1 + 1 + 3, 'no unbounded loop');
  const iss = issuesOf(result, 'rate-limit');
  assert.equal(iss.length, 1);
  assert.equal(iss[0].category, 'risk');
  assert.equal(readFileSync(join(dir, 'docs/partial.md'), 'utf8'), 'partial work');
  assert.match(gitOut(dir, 'log', '-1', '--format=%s'), /^builder\(rate-limited\)/);
  assert.ok(result.commit);
});

test('429 without Retry-After uses capped exponential backoff', async () => {
  const { sleeps, result } = await scenario({ handler: () => ({ status: 429, body: { error: { message: 'slow down' } } }) });
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(result.exit_code, 3);
  assert.equal(issuesOf(result, 'rate-limit').length, 1);
  assert.equal(result.commit, null, 'nothing written, nothing to commit');
});

test('Retry-After above the cap, or a daily-cap error, stops immediately with no waiting', async () => {
  const a = await scenario({ handler: () => ({ status: 429, headers: { 'retry-after': '3600' }, body: { error: { message: 'limited' } } }) });
  assert.deepEqual(a.sleeps, []); assert.equal(a.result.exit_code, 3); assert.equal(a.mock.requests.length, 1);
  const b = await scenario({ handler: () => ({ status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day' } } }) });
  assert.deepEqual(b.sleeps, []); assert.equal(b.result.exit_code, 3); assert.equal(b.mock.requests.length, 1);
  const c = await scenario({ handler: () => ({ status: 403, body: { error: { message: 'daily limit reached' } } }) });
  assert.equal(c.result.exit_code, 3);
});

test('a single 429 then success recovers and completes', async () => {
  const { result, sleeps } = await scenario({ handler: (_r, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'x' } } } : n === 2 ? reply({ tool_calls: [toolCall('write_file', { path: 'docs/a.md', content: 'a' })] }, 'tool_calls') : reply({ content: 'done' })) });
  assert.equal(result.status, 'completed'); assert.deepEqual(sleeps, [1000]);
  assert.equal(issuesOf(result, 'rate-limit').length, 0);
});

test('parseRetryAfter handles seconds, dates and junk', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(new Date(Date.now() + 10000).toUTCString(), Date.now()) > 7000, true);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('model not found is a journaled failure, not a crash', async () => {
  for (const h of [() => ({ status: 404, body: { error: { message: 'No endpoints found for vendor/gone:free' } } }), () => ({ status: 400, body: { error: { message: 'gone/model is not a valid model ID' } } })]) {
    const { result } = await scenario({ model: 'vendor/gone:free', handler: h });
    assert.equal(result.exit_code, EXIT.FAILED);
    assert.ok(kinds(result, 'attempt').some((e) => e.outcome === 'failed' && /model not found/.test(e.reason)));
  }
});

test('malformed tool calls: bad JSON, unknown tool, wrong shape are journaled and the model can recover', async () => {
  const script = [
    reply({ tool_calls: [toolCall('write_file', '{not json')] }, 'tool_calls'),
    reply({ tool_calls: [toolCall('delete_everything', { path: 'x' })] }, 'tool_calls'),
    reply({ tool_calls: [toolCall('write_file', { path: 'docs/ok.md', content: 'fine' })] }, 'tool_calls'),
    reply({ tool_calls: [toolCall('write_file', { path: 'docs/a.md' })] }, 'tool_calls'),
    reply({ tool_calls: [toolCall('write_file', { path: 'docs/ok2.md', content: 'fine' })] }, 'tool_calls'),
    reply({ content: 'done' }),
  ];
  const { result, mock } = await scenario({ model: 'vendor-b/model-b', handler: (_r, n) => script[n - 1] });
  assert.equal(result.status, 'completed');
  assert.equal(kinds(result, 'attempt').filter((e) => /malformed/.test(e.reason)).length, 3);
  const toolMsgs = mock.requests[1].body.messages.filter((m) => m.role === 'tool');
  assert.equal(result.files_written.length, 2);
  assert.match(toolMsgs[0].content, /^ERROR: malformed/);
});

test('malformed tool calls three times in a row stop the run with a failure and an issue', async () => {
  const { result } = await scenario({ handler: () => reply({ tool_calls: [toolCall('write_file', '{{')] }, 'tool_calls') });
  assert.equal(result.exit_code, EXIT.FAILED);
  assert.equal(issuesOf(result, 'malformed-tool-calls').length, 1);
});

test('refusal is journaled as blocked plus an issue and the run stops; earlier work is committed', async () => {
  const h = (_r, n) => (n === 1 ? reply({ tool_calls: [toolCall('write_file', { path: 'docs/a.md', content: 'a' })] }, 'tool_calls') : reply({ content: null, refusal: "I can't help with that." }));
  const { result, dir } = await scenario({ handler: h });
  assert.equal(result.exit_code, EXIT.FAILED);
  assert.ok(kinds(result, 'attempt').some((e) => e.outcome === 'blocked' && /refused/.test(e.reason)));
  assert.equal(issuesOf(result, 'refusal').length, 1);
  assert.match(gitOut(dir, 'log', '-1', '--format=%s'), /^builder\(failed\)/);
  const cf = await scenario({ handler: () => reply({ content: 'x' }, 'content_filter') });
  assert.equal(cf.result.exit_code, EXIT.FAILED);
});

test('truncated response: discarded and retried once; a second truncation stops the run', async () => {
  const once = await scenario({ handler: (_r, n) => (n === 1 ? reply({ tool_calls: [toolCall('write_file', '{"path":"docs/a.md","content":"abc')] }, 'length') : n === 2 ? reply({ tool_calls: [toolCall('write_file', { path: 'docs/a.md', content: 'short' })] }, 'tool_calls') : reply({ content: 'done' })) });
  assert.equal(once.result.status, 'completed');
  assert.ok(kinds(once.result, 'attempt').some((e) => /truncated/.test(e.reason)));
  assert.ok(once.mock.requests[1].body.messages.some((m) => /cut off/.test(m.content ?? '')));
  const twice = await scenario({ handler: () => reply({ content: 'part' }, 'length') });
  assert.equal(twice.result.exit_code, EXIT.FAILED);
  assert.equal(issuesOf(twice.result, 'truncation').length, 1);
});

test('malformed or empty HTTP responses are journaled failures', async () => {
  for (const h of [() => ({ status: 200, body: 'not json' }), () => ({ status: 200, body: { choices: [] } }), () => reply({ content: '  ' })]) {
    const { result } = await scenario({ handler: h });
    assert.equal(result.exit_code, EXIT.FAILED);
  }
});

test('writes are confined: traversal, absolute, symlink escape, locked and out-of-grant paths are all rejected', async () => {
  const dir = tempRepo();
  const outside = mkdtempSync(join(tmpdir(), 'bout-'));
  symlinkSync(outside, join(dir, 'docs/link'));
  const attempts = [
    ['../escape.txt'], ['docs/../../escape.txt'], ['/tmp/abs-escape.txt'], ['docs/link/pwn.txt'],
    ['acceptance/new.test.js'], ['acceptance/a.test.js'], ['.github/workflows/x.yml'], ['.git/hooks/pre-commit'],
    ['README.md'], ['.agent-runs/x'], ['.agent-builder.local.json'],
  ];
  const calls = attempts.map(([p], i) => toolCall('write_file', { path: p, content: 'PWNED' }, `c${i}`));
  const { result, mock } = await scenario({ workdir: dir, handler: (_r, n) => (n === 1 ? reply({ tool_calls: calls }, 'tool_calls') : reply({ content: 'done' })), grant: makeGrant({ budget: { max_usd: 1, max_tool_calls: 50 } }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.commit, null);
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(!existsSync(join(tmpdir(), 'escape.txt')) && !existsSync('/tmp/abs-escape.txt'));
  assert.equal(readFileSync(join(dir, 'acceptance/a.test.js'), 'utf8'), '// locked\n');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'x\n');
  const toolMsgs = mock.requests[1].body.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, attempts.length);
  assert.ok(toolMsgs.every((m) => m.content.startsWith('ERROR:')));
  assert.ok(kinds(result, 'attempt').filter((e) => e.outcome === 'blocked').length >= 5);
});

test('reads are confined too (no traversal, no symlink escape)', () => {
  const dir = tempRepo(); const outside = mkdtempSync(join(tmpdir(), 'bout-'));
  writeFileSync(join(outside, 'secret'), 's'); symlinkSync(join(outside, 'secret'), join(dir, 'docs/s'));
  symlinkSync(outside, join(dir, 'docs/d')); symlinkSync(join(dir, 'nowhere'), join(dir, 'docs/dangling'));
  for (const p of ['../x', '/etc/passwd', 'docs/s', 'docs/d/secret', 'docs/dangling', 'a\\b', '', 'a\0b', '.', 'docs/../..']) {
    assert.throws(() => confine(dir, p), ConfineError, p);
  }
  assert.equal(confine(dir, 'docs/new/dir/f.md', { write: true, allowedPaths: ['docs/'] }).rel, 'docs/new/dir/f.md');
  assert.throws(() => confine(dir, 'docs', { write: true, allowedPaths: ['src/'] }), /outside the grant/);
  assert.doesNotThrow(() => confine(dir, 'README.md', { write: true, allowedPaths: ['.'] }));
});

test('grant budget: tool calls beyond max_tool_calls are blocked and the run stops', async () => {
  const many = Array.from({ length: 5 }, (_v, i) => toolCall('write_file', { path: `docs/f${i}.md`, content: 'x' }, `c${i}`));
  const { result } = await scenario({ grant: makeGrant({ budget: { max_usd: 1, max_tool_calls: 2 } }), handler: () => reply({ tool_calls: many }, 'tool_calls') });
  assert.equal(result.exit_code, EXIT.FAILED);
  assert.deepEqual(result.files_written, ['docs/f0.md', 'docs/f1.md']);
  assert.ok(kinds(result, 'attempt').some((e) => e.outcome === 'blocked' && /budget/.test(e.reason)));
});

test('capability manifests are valid under the existing validator, carry undo (R1), and are written for the run', async () => {
  assert.ok(BUILDER_CAPABILITIES.length >= 1);
  for (const c of validateCapabilities()) assert.equal(c.valid, true, c.name);
  for (const m of BUILDER_CAPABILITIES) assert.ok(m.undo.button_ref || m.undo.reversal_steps?.length);
  const { result } = await scenario({ handler: (_r, n) => happyScript(n) });
  assert.deepEqual(JSON.parse(readFileSync(result.capabilities_path, 'utf8')), BUILDER_CAPABILITIES);
});

test('journal: entries mirrored to the untracked run file; contract gaps logged as issues of kind contract-gap', async () => {
  const { result, dir } = await scenario({ handler: (_r, n) => happyScript(n) });
  const lines = readFileSync(result.journal_path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= result.entries.length - 0);
  assert.equal(lines.length, result.entries.length - 0);
  assert.equal(issuesOf(result, 'contract-gap').length, CONTRACT_GAPS.length);
  assert.ok(CONTRACT_GAPS.every((g) => g.file && g.reason));
  assert.match(summarizeJournal(result.entries), /^journal: \d+ entries/);
  assert.equal(gitOut(dir, 'ls-files', '--', '.agent-runs').trim(), '');
});

test('no key-shaped secret is committed in src, scripts, fixtures or docs (the fake test key lives only in test/)', () => {
  const root = join(import.meta.dirname, '..');
  let hits = '';
  try { hits = execFileSync('git', ['grep', '-lE', 'sk-or-v1-[A-Za-z0-9]{10,}', '--', 'src', 'scripts', 'fixtures', 'docs', 'README.md', 'LOG.md', 'self-model.json'], { cwd: root, encoding: 'utf8' }); } catch (e) { if (e.status !== 1) throw e; }
  assert.equal(hits.trim(), '');
});
