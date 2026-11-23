import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder, EXIT, parseGithubRemote, remoteRepos } from '../src/builder-adapter.js';
import { startMock, reply, happyScript, tempRepo, makeGrant, FAKE_KEY, TEST_PRICES } from './builder-mock.js';

async function run({ model = 'vendor-b/model-b:free', repo = 'agent-core', remote, mutate, env = {} }) {
  const dir = remote === undefined ? tempRepo() : tempRepo('task/mock', remote);
  if (mutate) mutate(dir);
  const mock = await startMock((_r, n) => happyScript(n));
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_MODEL: model, AGENT_BUILDER_BASE_URL: mock.url, ...env }, cwd: tmpdir() });
    const result = await runBuilder({ config, task: { repo, goal: 'Write docs/hello.md', grant: makeGrant({ scope: { repos: [...new Set([repo, 'agent-core'])], paths: ['docs/'] } }), workdir: dir } }, { priceTable: TEST_PRICES });
    if (result.status === 'refused' && process.env.DBG) console.log(result.summary);
    return { result, requests: mock.requests.length };
  } finally { await mock.close(); }
}

test('allowlist: a spoofed repo name in input does not bypass it (workdir remote is a different repo)', async () => {
  const { result, requests } = await run({ repo: 'agent-core', remote: 'https://github.com/KosherKev/private-thing.git' });
  assert.equal(requests, 0);
  assert.equal(result.exit_code, EXIT.REFUSED);
  assert.ok(result.entries.some((e) => e.kind === 'attempt' && e.outcome === 'blocked' && /private-thing/.test(e.reason)));
});

test('allowlist: input repo naming a different repo is ignored when the remote is allowlisted', async () => {
  const { result, requests } = await run({ repo: 'agent-core', remote: 'git@github.com:KosherKev/agent-core.git' });
  assert.equal(result.status, 'completed');
  assert.equal(requests, 2);
});

test('allowlist: a workdir with no remote refuses before any network call', async () => {
  const { result, requests } = await run({ remote: null });
  assert.equal(requests, 0);
  assert.equal(result.exit_code, EXIT.REFUSED);
  assert.ok(result.entries.some((e) => /no git remote/.test(e.reason ?? '')));
});

test('allowlist: unparseable remotes refuse (other host, userinfo, extra path, file path)', async () => {
  for (const remote of ['https://gitlab.com/KosherKev/agent-core.git', 'https://user:tok@github.com/KosherKev/agent-core.git', 'https://github.com/KosherKev/agent-core/extra', '/tmp/agent-core', 'file:///tmp/agent-core', 'https://github.com.evil.io/KosherKev/agent-core']) {
    const { result, requests } = await run({ remote });
    assert.equal(requests, 0, remote);
    assert.equal(result.exit_code, EXIT.REFUSED, remote);
  }
});

test('allowlist: a second remote or a different push URL pointing elsewhere refuses', async () => {
  const a = await run({ mutate: (d) => execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/someone/private.git'], { cwd: d }) });
  assert.equal(a.requests, 0); assert.equal(a.result.exit_code, EXIT.REFUSED);
  const b = await run({ mutate: (d) => execFileSync('git', ['remote', 'set-url', '--push', 'origin', 'https://github.com/someone/private.git'], { cwd: d }) });
  assert.equal(b.requests, 0); assert.equal(b.result.exit_code, EXIT.REFUSED);
});

test('allowlist: a git error (workdir not a repo top level) refuses', async () => {
  const { result, requests } = await run({ mutate: (d) => { execFileSync('mkdir', ['-p', `${d}/sub`]); }, remote: 'https://github.com/KosherKev/agent-core.git' });
  assert.equal(result.status, 'completed'); assert.equal(requests, 2);
  assert.equal(remoteRepos(tmpdir()).ok, false);
  assert.equal(remoteRepos('/definitely/not/here').ok, false);
});

test('allowlist: non-free models are not restricted by the remote; the allowlist can name more repos', async () => {
  const a = await run({ model: 'vendor-a/model-a', remote: 'https://github.com/KosherKev/whatever.git' });
  assert.equal(a.result.status, 'completed');
  const b = await run({ remote: 'https://github.com/KosherKev/other.git', env: { FREE_MODEL_REPO_ALLOWLIST: 'agent-core,other' } });
  assert.equal(b.result.status, 'completed');
});

test('parseGithubRemote accepts the https and ssh forms and nothing else', () => {
  assert.deepEqual(parseGithubRemote('https://github.com/KosherKev/agent-core'), { owner: 'KosherKev', repo: 'agent-core' });
  assert.deepEqual(parseGithubRemote('https://github.com/KosherKev/agent-core.git'), { owner: 'KosherKev', repo: 'agent-core' });
  assert.deepEqual(parseGithubRemote('git@github.com:KosherKev/agent-core.git'), { owner: 'KosherKev', repo: 'agent-core' });
  assert.deepEqual(parseGithubRemote('ssh://git@github.com/KosherKev/agent-core.git'), { owner: 'KosherKev', repo: 'agent-core' });
  for (const bad of ['', 'github.com/a/b', 'http://github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c', 'https://github.com/../b', 'git@gitlab.com:a/b.git', 'ssh://root@github.com/a/b', null, 5]) assert.equal(parseGithubRemote(bad), null, String(bad));
});
