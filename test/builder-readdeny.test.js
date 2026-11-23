import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder, EXIT } from '../src/builder-adapter.js';
import { confine, ConfineError, isReadDenied } from '../src/builder-confine.js';
import { startMock, toolCall, reply, tempRepo, makeGrant, FAKE_KEY, TEST_PRICES } from './builder-mock.js';

const SECRET = 'TOP-SECRET-CONTENT-123';
function repoWithSecrets() {
  const dir = tempRepo();
  for (const f of ['.env', '.env.local', '.envrc', 'docs/key.pem', 'docs/server.key', 'docs/id_rsa', 'docs/id_ed25519.pub', 'docs/api-token.txt', 'docs/Credentials.json', 'docs/cert.crt', '.agent-builder.local.json', '.npmrc']) writeFileSync(join(dir, f), SECRET);
  mkdirSync(join(dir, '.ssh')); writeFileSync(join(dir, '.ssh/id_rsa'), SECRET);
  mkdirSync(join(dir, '.aws')); writeFileSync(join(dir, '.aws/credentials'), SECRET);
  symlinkSync('../.env', join(dir, 'docs/envlink'));
  writeFileSync(join(dir, 'docs/ok.md'), 'public text\n');
  return dir;
}

const DENIED = ['.env', '.env.local', '.envrc', '.git/config', '.GIT/config', '.git /config', 'docs/key.pem', 'docs/server.key', 'docs/id_rsa', 'docs/id_ed25519.pub', 'docs/api-token.txt', 'docs/Credentials.json', 'docs/cert.crt',
  '.ssh/id_rsa', '.aws/credentials', '~/.ssh/id_rsa', '~/.aws/credentials', '/etc/passwd', `${process.env.HOME}/.ssh/id_rsa`, '../outside.txt', '.agent-builder.local.json', '.npmrc', 'docs/envlink', 'ENV/../.env'];

test('read denylist: every listed target is refused by confine (one case each)', () => {
  const dir = repoWithSecrets();
  for (const p of DENIED) assert.throws(() => confine(dir, p), ConfineError, p);
  assert.equal(confine(dir, 'docs/ok.md').rel, 'docs/ok.md');
  assert.equal(isReadDenied('docs/readme.md'), false);
  assert.equal(isReadDenied('docs/.ENV.production'), true);
});

test('read denylist: through the adapter, each refusal is journaled as a failed attempt, nothing leaks to the model, no crash', async () => {
  const dir = repoWithSecrets();
  const calls = DENIED.map((p, i) => toolCall('read_file', { path: p }, `c${i}`));
  calls.push(toolCall('list_dir', { path: '.git' }, 'cg'), toolCall('read_file', { path: 'docs/ok.md' }, 'cok'));
  const mock = await startMock((_r, n) => (n === 1 ? reply({ tool_calls: calls }, 'tool_calls') : reply({ content: 'done' })));
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_BASE_URL: mock.url, AGENT_BUILDER_MODEL: 'vendor-a/model-a' }, cwd: tmpdir() });
    const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant({ budget: { max_usd: 1, max_tool_calls: 100 } }), workdir: dir } }, { priceTable: TEST_PRICES });
    assert.equal(result.status, 'completed');
    assert.equal(result.exit_code, EXIT.OK);
    const failed = result.entries.filter((e) => e.kind === 'attempt' && e.outcome === 'failed' && /^tool (read_file|list_dir)/.test(e.tried));
    assert.equal(failed.length, DENIED.length + 1);
    const toolMsgs = mock.requests[1].body.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, DENIED.length + 2);
    assert.ok(!JSON.stringify(mock.requests[1].body).includes(SECRET), 'secret content never reaches the model');
    assert.equal(toolMsgs.at(-1).content, 'public text\n');
  } finally { await mock.close(); }
});

test('read denylist: list_dir hides secrets and git internals; reads cap at the byte limit and refuse non-regular files', async () => {
  const dir = repoWithSecrets();
  mkdirSync(join(dir, 'docs/sub'));
  writeFileSync(join(dir, 'docs/big.md'), 'x'.repeat(200000));
  const calls = [toolCall('list_dir', { path: '.' }, 'l1'), toolCall('list_dir', { path: 'docs' }, 'l2'), toolCall('read_file', { path: 'docs/big.md' }, 'r1'), toolCall('read_file', { path: 'docs/sub' }, 'r2')];
  const mock = await startMock((_r, n) => (n === 1 ? reply({ tool_calls: calls }, 'tool_calls') : reply({ content: 'done' })));
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_BASE_URL: mock.url }, cwd: tmpdir() });
    await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant({ budget: { max_usd: 1, max_tool_calls: 20 } }), workdir: dir } }, { priceTable: TEST_PRICES });
    const [l1, l2, r1, r2] = mock.requests[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    const l1Names = l1.split('\n').map((n) => n.replace(/\/$/, ''));
    for (const hidden of ['.env', '.git', '.ssh', '.aws', '.agent-builder.local.json', '.npmrc']) assert.ok(!l1Names.includes(hidden), hidden);
    for (const hidden of ['key.pem', 'server.key', 'id_rsa', 'api-token.txt', 'Credentials.json', 'cert.crt']) assert.ok(!l2.includes(hidden), hidden);
    assert.ok(l2.includes('ok.md') && l2.includes('big.md'));
    assert.equal(r1.length, 50000);
    assert.match(r2, /^ERROR:/);
  } finally { await mock.close(); }
});

test('list_dir accepts the repository root (., ./, empty) but hides .git and denylisted names; writes to the root stay refused', async () => {
  const dir = repoWithSecrets();
  const calls = ['.', './', ''].map((p, i) => toolCall('list_dir', { path: p }, `r${i}`));
  const mock = await startMock((_r, n) => (n === 1 ? reply({ tool_calls: calls }, 'tool_calls') : reply({ content: 'done' })));
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_BASE_URL: mock.url }, cwd: tmpdir() });
    await runBuilder({ config, task: { repo: 'agent-core', goal: 'g', grant: makeGrant({ budget: { max_usd: 1, max_tool_calls: 20 } }), workdir: dir } }, { priceTable: TEST_PRICES });
    const outs = mock.requests[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.equal(outs.length, 3);
    for (const out of outs) {
      assert.ok(!out.startsWith('ERROR'), out);
      const names = out.split('\n').map((n) => n.replace(/\/$/, ''));
      assert.ok(names.includes('docs'), out);
      for (const hidden of ['.git', '.env', '.env.local', '.envrc', '.ssh', '.aws', '.agent-builder.local.json', '.npmrc', '.agent-runs']) assert.ok(!names.includes(hidden), hidden);
    }
  } finally { await mock.close(); }
  for (const p of ['.', './', '']) assert.throws(() => confine(dir, p, { write: true, allowRoot: true }), ConfineError, p);
  assert.throws(() => confine(dir, '.'), ConfineError);
});
