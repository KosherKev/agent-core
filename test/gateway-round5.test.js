import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome, makeGrant, chatOk, FREE_MODEL } from './gateway-helpers.js';
import { createFileLedgerStore } from '../src/gateway/store.js';
import { createRunStore } from '../src/gateway/runs.js';
import { loadCredentials, makeRedactor } from '../src/gateway/credentials.js';
import { createGatewayApi } from '../src/gateway/api.js';
import { loadPriceTable, createSpendSink } from '../src/grant/index.js';
import { validateConfig, LIMITS } from '../src/gateway/config.js';
import { findSymlinkComponent, SYSTEM_SYMLINKS } from '../src/gateway/layout.js';
import { main, EXIT } from '../src/gateway/cli.js';

const msgs = [{ role: 'user', content: 'hello' }];
const call = (api, method, params) => api.handle({ id: 1, method, params });
const req = { run_id: 'r1', provider: 'mockprov', model: FREE_MODEL, messages: msgs, max_tokens: 100 };

/**
 * An api whose sync, ledger reservation and provider transport all log into one `events` array, in the order they happen.
 * A sync event is named after the last line the run file holds when the flush is called, so "sync:request_start" means that line was flushed.
 * `failAt` names one event ('sync:run_start', 'dir', 'sync:request_start', 'sync:request_reserved') whose flush throws.
 */
function build(t, { failAt } = {}) {
  const events = [];
  const lastType = (fd) => { const f = join(t.config.runs_dir, 'r1.jsonl'); const ls = readFileSync(f, 'utf8').split('\n').filter(Boolean); return JSON.parse(ls[ls.length - 1]).type; };
  const fileSync = {
    file: (fd) => { const e = `sync:${lastType(fd)}`; events.push(e); if (failAt === e) throw new Error('EIO'); },
    dir: () => { events.push('dir'); if (failAt === 'dir') throw new Error('EIO'); },
  };
  const credentials = loadCredentials(t.config.credentials_file);
  const redact = makeRedactor(credentials.secrets());
  const plain = createFileLedgerStore(t.config.ledger_dir, {});
  const store = { ...plain, meterLedger: () => ({ openRun: (grant, runId) => { const h = plain.meterLedger().openRun(grant, runId); return { ...h, reserve: (...a) => { events.push('reserve'); return h.reserve(...a); } }; } }) };
  const runs = createRunStore(t.config.runs_dir, { fileSync });
  const transport = async () => { events.push('provider'); return new Response(JSON.stringify(chatOk('ok').body), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const api = createGatewayApi({ config: t.config, store, runs, credentials, priceTable: loadPriceTable().table, transport, makeSink: (id) => createSpendSink(join(t.config.runs_dir, `${id}.spend.jsonl`), redact) });
  return { api, runs, events };
}

// ---- items 1 and 2: the order of everything that matters ----
test('items 1 and 2: run file create, dir sync, request_start flushed, reserve, request_reserved flushed, provider: in that order', async () => {
  const t = tempHome();
  const { api, events } = build(t);
  assert.equal((await call(api, 'openRun', { run_id: 'r1', grant: makeGrant() })).ok, true);
  assert.deepEqual(events, ['sync:run_start', 'dir'], 'opening the run flushes the file with its first line, then the directory');
  events.length = 0;
  const r = await call(api, 'modelCall', { ...req, request_id: 'q1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(events, ['sync:request_start', 'reserve', 'sync:request_reserved', 'provider']);
});

test('items 1 and 2: a flush that fails at ANY step means the provider is never called (and nothing is paid)', async () => {
  for (const failAt of ['sync:run_start', 'dir', 'sync:request_start', 'sync:request_reserved']) {
    const t = tempHome();
    const { api, events } = build(t, { failAt });
    const opened = await call(api, 'openRun', { run_id: 'r1', grant: makeGrant() });
    if (failAt === 'sync:run_start' || failAt === 'dir') {
      assert.equal(opened.ok, false, failAt); assert.equal(opened.error.code, 'request_start_not_durable', failAt);
      const r = await call(api, 'modelCall', { ...req, request_id: 'q1' });
      assert.equal(r.ok, false, failAt); assert.equal(r.error.code, 'run_not_open', failAt);
    } else {
      assert.equal(opened.ok, true, failAt);
      const r = await call(api, 'modelCall', { ...req, request_id: 'q1' });
      assert.equal(r.ok, false, failAt); assert.equal(r.error.code, 'request_start_not_durable', failAt);
      if (failAt === 'sync:request_start') assert.ok(!events.includes('reserve'), 'nothing is reserved before the start line is durable');
      else assert.ok(events.includes('reserve'));
      // a retry replays the recorded failure: still no provider call
      const again = await call(api, 'modelCall', { ...req, request_id: 'q1' });
      assert.equal(again.ok, false, failAt);
    }
    assert.ok(!events.includes('provider'), `the provider was called after a failure at ${failAt}`);
  }
});

test('item 1: a run file created by a non-durable write gets its directory flushed once, at the next durable write', async () => {
  const t = tempHome();
  const calls = [];
  const runs = createRunStore(t.config.runs_dir, { fileSync: { file: () => calls.push('file'), dir: () => calls.push('dir') } });
  runs.setModel('side', 'mockprov', FREE_MODEL); // creates the file without a flush
  assert.deepEqual(calls, []);
  await runs.recordRequestStart('side', 'q1', 'fp');
  assert.deepEqual(calls, ['file', 'dir']);
  await runs.recordRequestStart('side', 'q2', 'fp');
  assert.deepEqual(calls, ['file', 'dir', 'file'], 'the directory is flushed once per run file');
  // start() itself is durable and returns a promise
  calls.length = 0;
  await runs.start('fresh', {});
  assert.deepEqual(calls, ['file', 'dir']);
});

// ---- item 3: the ceiling ----
test('item 3: run_file_max_bytes is capped at 256 MiB, with a clear message above it; the default is unchanged', () => {
  const t = tempHome();
  assert.equal(LIMITS.run_file_max_bytes[0], 64 * 1024 * 1024);
  assert.equal(LIMITS.run_file_max_bytes[2], 256 * 1024 * 1024);
  assert.equal(validateConfig({ ...t.raw, run_file_max_bytes: 256 * 1024 * 1024 }, t.home).valid, true);
  const over = validateConfig({ ...t.raw, run_file_max_bytes: 256 * 1024 * 1024 + 1 }, t.home);
  assert.equal(over.valid, false);
  assert.match(over.errors.join('\n'), /run_file_max_bytes is 268435457, over the ceiling of 268435456 bytes \(256 MiB\)/);
  assert.equal(validateConfig({ ...t.raw, run_file_max_bytes: 1024 * 1024 * 1024 }, t.home).valid, false);
  assert.match(validateConfig({ ...t.raw, run_file_max_bytes: 10 }, t.home).errors.join('\n'), /integer from 1024 to 268435456/);
});

// ---- item 4: the macOS symlink allowlist is /var only ----
test('item 4: on macOS only /var is an allowed root symlink; /tmp and /etc are refused', () => {
  assert.deepEqual(Object.keys(SYSTEM_SYMLINKS.darwin), ['/var']);
  const link = (name, target) => ({ lstat: (p) => ({ isSymbolicLink: () => p === name, uid: 0 }), readlink: () => target, platform: 'darwin' });
  assert.deepEqual(findSymlinkComponent('/var/run/x', link('/var', 'private/var')), { ok: true, link: null });
  assert.equal(findSymlinkComponent('/tmp/x', link('/tmp', 'private/tmp')).link, '/tmp');
  assert.equal(findSymlinkComponent('/etc/x', link('/etc', 'private/etc')).link, '/etc');
});

// ---- item 5 (spec item 5): readable but invalid config makes `agent status` fail ----
test('status: a readable config that parses but is INVALID exits non-zero; the denied case still exits 0', async (t) => {
  const cap = () => { const out = []; return { io: { out: (l) => out.push(l), err: (l) => out.push(l) }, out }; };
  const t5 = tempHome();
  const env = { AGENT_HOME: t5.home };
  const cfg = join(t5.home, 'config.json');
  // valid JSON, but the config is wrong in the ways validateConfig checks: unknown key, bad limit
  for (const bad of [{ ...t5.raw, surprise: 1 }, { ...t5.raw, run_file_max_bytes: 1024 * 1024 * 1024 }, { ...t5.raw, config_version: 99 }]) {
    writeFileSync(cfg, JSON.stringify(bad), { mode: 0o600 });
    const c = cap();
    assert.equal(await main(['status'], { env, io: c.io }), EXIT.FAILED);
    assert.match(c.out.join('\n'), /config: INVALID/);
  }
  writeFileSync(cfg, JSON.stringify(t5.raw), { mode: 0o600 });
  chmodSync(cfg, 0o000);
  try {
    if (process.getuid?.() === 0) { t.skip('root ignores file modes'); return; }
    const den = cap();
    assert.equal(await main(['status'], { env, io: den.io }), EXIT.OK);
    assert.match(den.out.join('\n'), /not readable by this user/);
  } finally { chmodSync(cfg, 0o600); }
});
