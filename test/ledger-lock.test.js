import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger, fileNameFor } from '../src/ledger/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'ledger-lock-worker.js');
const PROCS = 6;
const ITERATIONS = 40;
const GRANT = { schema_version: '1', task_id: 'g-race', scope: { repos: ['agent-core'], paths: ['docs/'] }, budget: { max_usd: 1, max_tool_calls: 5 }, expires_at: '2099-01-01T00:00:00Z', allowed_risk_tiers: ['low'] };

const deadPid = async () => { const c = spawn(process.execPath, ['-e', '0']); await new Promise((r) => c.on('exit', r)); return c.pid; };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const seedLock = (lock, pid) => { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid, at_ms: Date.now() - 600_000 })); };

/** Run PROCS processes through ITERATIONS rounds; before each round `before(i)` prepares the lock. Returns each process's totals. */
async function race({ mode, syncDir, ledgerDir, lockTimeoutMs, before }) {
  const procs = [];
  const kids = [...Array(PROCS).keys()].map((id) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [WORKER, syncDir, ledgerDir, mode, String(id), String(ITERATIONS), String(lockTimeoutMs), JSON.stringify(GRANT)], { stdio: ['ignore', 'pipe', 'inherit'] });
    procs.push(c);
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('error', rej);
    c.on('exit', (code) => (code === 0 ? res(JSON.parse(o)) : rej(new Error(`worker exit ${code}`))));
  }));
  kids.forEach((k) => k.catch(() => {}));
  try {
  for (let i = 0; i < ITERATIONS; i += 1) {
    before(i);
    writeFileSync(join(syncDir, `go-${i}`), '');
    const t0 = Date.now();
    while (readdirSync(syncDir).filter((n) => n.startsWith(`done-${i}-`)).length < PROCS) {
      if (Date.now() - t0 > 30_000) throw new Error(`round ${i} did not finish`);
      await sleepMs(2);
    }
  }
  return await Promise.all(kids);
  } finally { for (const c of procs) c.kill('SIGKILL'); }
}
const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0);
const mk = () => { const base = mkdtempSync(join(tmpdir(), 'ledger-lock-')); const syncDir = join(base, 'sync'); const ledgerDir = join(base, 'l'); mkdirSync(syncDir); return { syncDir, ledgerDir }; };

test('ledger lock race: 6 processes over a pre-seeded dead-pid lock never enter the critical section, never overlap, and leave the lock untouched', async () => {
  const { syncDir, ledgerDir } = mk(); const lock = join(syncDir, 'cs.lock'); const dead = await deadPid();
  let disturbed = 0;
  const rs = await race({ mode: 'cs', syncDir, ledgerDir, lockTimeoutMs: 500, before: (i) => {
    if (i > 0) { try { if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid !== dead) disturbed += 1; } catch { disturbed += 1; } rmSync(lock, { recursive: true, force: true }); }
    seedLock(lock, dead);
  } });
  assert.equal(disturbed, 0, 'the dead-pid lock was left exactly as seeded in every round');
  assert.equal(sum(rs, 'entered'), 0, 'a dead-pid lock is never taken over');
  assert.equal(sum(rs, 'overlaps'), 0, 'no two processes were ever inside the critical section together');
  assert.equal(sum(rs, 'entered'), 0, 'a dead-pid lock is never taken over');
  assert.equal(sum(rs, 'refused'), PROCS * ITERATIONS);
  assert.equal(sum(rs, 'errors'), 0);
  assert.match(rs[0].messages[0], new RegExp(`${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*rm -r`), 'the message names the lock and the clearing command');
});

test('ledger lock race: 6 processes over a pre-seeded dead-pid lock on a real ledger never append and never fork the chain', async () => {
  const { syncDir, ledgerDir } = mk(); const l = openLedger(ledgerDir); l.openRun(GRANT, 'seed');
  const file = join(ledgerDir, fileNameFor(GRANT.task_id)); const lock = `${file}.lock`; const dead = await deadPid();
  const rs = await race({ mode: 'ledger', syncDir, ledgerDir, lockTimeoutMs: 500, before: (i) => { if (i > 0) rmSync(lock, { recursive: true, force: true }); seedLock(lock, dead); } });
  assert.doesNotThrow(() => openLedger(ledgerDir).remaining(GRANT), 'the hash chain still verifies (no fork)');
  assert.equal(sum(rs, 'entered'), 0, 'no process appended through a dead-pid lock');
  assert.equal(sum(rs, 'errors'), 0);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'only the seed entry exists');
});

test('ledger lock race: after a human clears a dead-pid lock the ledger works again', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ledger-lock-clear-')), 'l'); const l = openLedger(dir);
  l.openRun(GRANT, 'run-1'); const lock = `${join(dir, readdirSync(dir).find((n) => n.endsWith('.jsonl')))}.lock`;
  seedLock(lock, await deadPid());
  let msg; try { l.openRun(GRANT, 'run-2'); } catch (e) { msg = e.message; }
  assert.match(msg, /no longer running/);
  rmSync(lock, { recursive: true }); // what the message tells the operator to do
  l.openRun(GRANT, 'run-2');
  assert.equal(l.remaining(GRANT).key, 'g-race');
});

test('ledger lock race (control): 6 processes racing a fresh lock never overlap and every entry is a valid chain link', async () => {
  const { syncDir, ledgerDir } = mk(); const l = openLedger(ledgerDir); l.openRun(GRANT, 'seed');
  const file = join(ledgerDir, fileNameFor(GRANT.task_id));
  const rs = await race({ mode: 'ledger', syncDir, ledgerDir, lockTimeoutMs: 20000, before: () => {} });
  assert.equal(sum(rs, 'errors'), 0, JSON.stringify(rs.map((r) => r.messages)));
  assert.equal(sum(rs, 'entered'), PROCS * ITERATIONS, 'every contender got its turn');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1 + PROCS * ITERATIONS);
  assert.doesNotThrow(() => openLedger(ledgerDir).remaining(GRANT));
});

test('ledger lock race (control): the critical-section detector sees zero overlap on a fresh lock', async () => {
  const { syncDir, ledgerDir } = mk();
  const rs = await race({ mode: 'cs', syncDir, ledgerDir, lockTimeoutMs: 20000, before: () => {} });
  assert.equal(sum(rs, 'overlaps'), 0); assert.equal(sum(rs, 'errors'), 0);
  assert.equal(sum(rs, 'entered'), PROCS * ITERATIONS);
});

test('ledger lock: the overlap detector works (a second entry into the critical section is counted)', async () => {
  const { syncDir, ledgerDir } = mk(); mkdirSync(join(syncDir, 'in-cs')); // someone is already "inside"
  const rs = await race({ mode: 'cs', syncDir, ledgerDir, lockTimeoutMs: 20000, before: () => {} });
  assert.ok(sum(rs, 'overlaps') > 0, 'a planted occupant is detected');
});
