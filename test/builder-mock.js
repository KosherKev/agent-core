import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_KEY = 'sk-or-v1-FAKEKEY-for-tests-only-0123456789';

/** Local OpenAI-compatible mock on 127.0.0.1 with an ephemeral port. `handler(req, n)` returns {status, headers, body}. */
export async function startMock(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(rec);
      const out = handler(rec, requests.length) ?? { status: 500, body: { error: { message: 'no handler' } } };
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export const toolCall = (name, args, id = `call_${name}`) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
export const reply = (message, finish_reason = 'stop') => ({ status: 200, body: { choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason }] } });
export const happyScript = (n, file = 'docs/hello.md') => (n === 1
  ? reply({ tool_calls: [toolCall('write_file', { path: file, content: '# Hello\n' })] }, 'tool_calls')
  : reply({ content: 'Done: wrote the file.' }));

/** Temp git repo on a task branch with one commit; returns its path. */
export function tempRepo(branch = 'task/mock') {
  const d = mkdtempSync(join(tmpdir(), 'brepo-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: d, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  mkdirSync(join(d, 'docs')); mkdirSync(join(d, 'acceptance')); mkdirSync(join(d, '.github'));
  writeFileSync(join(d, 'README.md'), 'x\n');
  writeFileSync(join(d, 'acceptance/a.test.js'), '// locked\n');
  writeFileSync(join(d, '.github/locked-paths.txt'), 'acceptance/\n.github/\n');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', branch);
  return d;
}

export const makeGrant = (over = {}) => ({
  schema_version: '1', task_id: 't-1',
  scope: { repos: ['agent-core'], paths: ['docs/'] },
  budget: { max_usd: 1, max_tool_calls: 10 },
  expires_at: '2099-01-01T00:00:00Z', allowed_risk_tiers: ['low'], ...over,
});
