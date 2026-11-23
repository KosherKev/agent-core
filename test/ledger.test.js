import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, utimesSync, realpathSync, writeSync, fsyncSync, fstatSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger, defaultLedgerDir, LedgerError, canonicalJson, sha256, acquireLock } from '../src/ledger/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const tdir = () => { const d = mkdtempSync(join(tmpdir(), 'ledger-')); return join(d, 'l'); };
const grant = (over = {}) => ({ schema_version: '1', task_id: 'g-1', scope: { repos: ['agent-core'], paths: ['docs/'] }, budget: { max_usd: 0.001, max_tool_calls: 5 }, expires_at: '2099-01-01T00:00:00Z', allowed_risk_tiers: ['low'], ...over }); // 1000 micro-USD
const files = (dir) => readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
const lines = (dir) => readFileSync(join(dir, files(dir)[0]), 'utf8').trim().split('\n');
const refuses = (fn, kind) => assert.throws(fn, (e) => e instanceof LedgerError && (kind === undefined || e.kind === kind));

test('ledger: sequential runs on one grant share the budget', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r1 = l.openRun(grant(), 'run-1');
  r1.settle(r1.reserve({ micro: 600 }), 600); r1.endRun('completed');
  const r2 = l.openRun(grant(), 'run-2');
  assert.equal(r2.remaining().remaining_micro, 400);
  refuses(() => r2.reserve({ micro: 401 }), 'budget');
  r2.settle(r2.reserve({ micro: 400 }), 400);
  assert.equal(l.remaining(grant()).remaining_micro, 0);
});

test('ledger: run 2 refuses at preflight when run 1 used the whole budget', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r1 = l.openRun(grant(), 'run-1');
  r1.settle(r1.reserve({ micro: 1000 }), 1000); r1.endRun('completed');
  refuses(() => l.openRun(grant(), 'run-2'), 'budget');
  assert.equal(lines(dir).length, 4, 'a refused open appends nothing');
});

test('ledger: run 2 sees only the remaining budget', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r1 = l.openRun(grant(), 'run-1');
  r1.settle(r1.reserve({ micro: 250 }), 250); r1.endRun('completed');
  const s = l.openRun(grant(), 'run-2').remaining();
  assert.equal(s.budget_micro, 1000); assert.equal(s.settled_micro, 250); assert.equal(s.remaining_micro, 750);
});

test('ledger: a crashed run keeps its open reservation counting at the reserved amount', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r1 = l.openRun(grant(), 'run-1');
  r1.reserve({ micro: 700 }); // never settled, never ended: simulated crash
  const r2 = l.openRun(grant(), 'run-2');
  assert.equal(r2.remaining().remaining_micro, 300);
  assert.equal(r2.remaining().open_micro, 700);
  refuses(() => r2.reserve({ micro: 301 }), 'budget');
  // reopening the ledger from scratch (new process) still counts it
  assert.equal(openLedger(dir).remaining(grant()).remaining_micro, 300);
});

test('ledger: max_tool_calls is shared across runs', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r1 = l.openRun(grant(), 'run-1');
  for (let i = 0; i < 3; i += 1) r1.reserveTool();
  r1.endRun('completed');
  const r2 = l.openRun(grant(), 'run-2');
  r2.reserveTool(); r2.reserveTool();
  refuses(() => r2.reserveTool(), 'tool_calls');
  r2.endRun('grant-exceeded');
  refuses(() => l.openRun(grant(), 'run-3'), 'tool_calls');
});

test('ledger: a corrupted line refuses', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r = l.openRun(grant(), 'run-1');
  const f = join(dir, files(dir)[0]);
  const ls = readFileSync(f, 'utf8').split('\n'); ls.splice(1, 0, '{not json'); writeFileSync(f, ls.join('\n'));
  refuses(() => r.reserve({ micro: 1 }));
  refuses(() => l.openRun(grant(), 'run-2'));
  refuses(() => l.remaining(grant()));
});

test('ledger: a torn last line (no newline) refuses', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r = l.openRun(grant(), 'run-1');
  const f = join(dir, files(dir)[0]);
  writeFileSync(f, readFileSync(f, 'utf8').trimEnd());
  refuses(() => r.reserve({ micro: 1 }));
});

test('ledger: a broken hash chain refuses', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r = l.openRun(grant(), 'run-1');
  r.settle(r.reserve({ micro: 100 }), 100);
  const f = join(dir, files(dir)[0]);
  const ls = readFileSync(f, 'utf8').trim().split('\n');
  const e = JSON.parse(ls[1]); e.micro = 1; ls[1] = JSON.stringify(e); // edit the reserve amount after the fact; the next line's prev no longer matches
  writeFileSync(f, ls.join('\n') + '\n');
  refuses(() => r.reserve({ micro: 1 }));
  // deleting a middle line breaks the chain too
  const g = tdir(); const l2 = openLedger(g); const r2 = l2.openRun(grant(), 'run-1'); r2.reserve({ micro: 5 }); r2.reserve({ micro: 5 });
  const f2 = join(g, files(g)[0]); const l2s = readFileSync(f2, 'utf8').trim().split('\n'); l2s.splice(1, 1);
  writeFileSync(f2, l2s.join('\n') + '\n');
  refuses(() => r2.reserve({ micro: 1 }));
});

test('ledger: an unknown entry type refuses', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r = l.openRun(grant(), 'run-1');
  const f = join(dir, files(dir)[0]);
  const ls = readFileSync(f, 'utf8').trim().split('\n');
  const prev = sha256(ls[ls.length - 1]);
  const forged = JSON.stringify({ v: 1, seq: ls.length + 1, at: new Date().toISOString(), prev, type: 'refund', micro: 999 }); // chain is valid, type is not
  writeFileSync(f, ls.join('\n') + '\n' + forged + '\n');
  refuses(() => r.reserve({ micro: 1 }), 'ledger');
});

test('ledger: a lock timeout refuses', () => {
  const dir = tdir(); const l = openLedger(dir, { lockTimeoutMs: 150, lockPollMs: 5 });
  const r = l.openRun(grant(), 'run-1');
  const lock = join(dir, `${files(dir)[0]}.lock`);
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at_ms: Date.now() })); // a live holder: this process
  const t0 = Date.now();
  assert.throws(() => r.reserve({ micro: 1 }), /lock timeout/);
  assert.ok(Date.now() - t0 < 3000, 'the wait is bounded');
  assert.equal(lines(dir).length, 1, 'nothing was appended');
});

test('ledger: a dead-pid lock is never broken, whatever its age, and the refusal names the lock and the clearing command', async () => {
  const dir = tdir();
  const dead = spawn(process.execPath, ['-e', '0']); await new Promise((res) => dead.on('exit', res));
  const l = openLedger(dir, { lockTimeoutMs: 300, lockPollMs: 5 });
  const r = l.openRun(grant(), 'run-1');
  const lock = join(realpathSync.native(dir), `${files(dir)[0]}.lock`);
  for (const ageMs of [10, 60_000, 86_400_000]) {
    mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: dead.pid, at_ms: Date.now() - ageMs }));
    assert.throws(() => r.reserve({ micro: 1 }), (e) => e instanceof LedgerError && e.message.includes(lock) && e.message.includes(`rm -r '${lock}'`) && /no longer running/.test(e.message));
    assert.ok(existsSync(lock), 'not removed'); rmSync(lock, { recursive: true });
  }
  assert.equal(lines(dir).length, 1, 'nothing was appended');
  r.reserve({ micro: 1 });
  assert.equal(existsSync(lock), false, 'the lock is released after use');
});

test('ledger: a mutated grant under the same key refuses', () => {
  const dir = tdir(); const l = openLedger(dir);
  l.openRun(grant(), 'run-1');
  refuses(() => l.openRun(grant({ budget: { max_usd: 100, max_tool_calls: 5 } }), 'run-2'));
  refuses(() => l.openRun(grant({ expires_at: '2100-01-01T00:00:00Z' }), 'run-3'));
  refuses(() => l.remaining(grant({ scope: { repos: ['agent-core'], paths: ['.'] } })));
  l.openRun({ ...grant() }, 'run-4'); // key order does not matter
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('ledger: different grants do not share', () => {
  const dir = tdir(); const l = openLedger(dir);
  const a = l.openRun(grant({ task_id: 'g-a' }), 'run-1'); a.settle(a.reserve({ micro: 1000 }), 1000);
  const b = l.openRun(grant({ task_id: 'g-b' }), 'run-1');
  assert.equal(b.remaining().remaining_micro, 1000);
  assert.equal(files(dir).length, 2);
});

test('ledger: the default directory is outside the repo and is never created by these tests', () => {
  const d = defaultLedgerDir({});
  assert.equal(d, join(homedir(), '.agent-ledger'));
  assert.ok(!d.startsWith(REPO + sep) && d !== REPO);
  assert.equal(defaultLedgerDir({ AGENT_LEDGER_DIR: '/x/y' }), '/x/y');
  assert.throws(() => openLedger(join(REPO, '.agent-ledger')), /outside the repository/);
  assert.throws(() => openLedger(join(REPO, 'a', 'b')), /outside the repository/);
  assert.equal(existsSync(join(REPO, '.agent-ledger')), false);
});

test('ledger: directory is 0700 and files are 0600, and a loose pre-existing directory is refused', () => {
  const dir = tdir(); const l = openLedger(dir); l.openRun(grant(), 'run-1');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, files(dir)[0])).mode & 0o777, 0o600);
  const loose = tdir(); mkdirSync(loose, { mode: 0o755 }); execFileSync('chmod', ['755', loose]);
  refuses(() => openLedger(loose));
});

test('ledger: integer money sums exactly over many small amounts', () => {
  const dir = tdir(); const l = openLedger(dir);
  const g = grant({ budget: { max_usd: 1, max_tool_calls: 5 } }); // 1_000_000 micro
  const r = l.openRun(g, 'run-1');
  for (let i = 0; i < 120; i += 1) r.settle(r.reserve({ micro: 7 }), 7);
  const s = r.remaining();
  assert.equal(s.settled_micro, 840); assert.equal(s.remaining_micro, 999_160);
  assert.ok(Number.isInteger(s.settled_micro) && Number.isInteger(s.remaining_micro));
  r.settle(r.reserve({ micro: 1 }), 1);
  refuses(() => r.settle('r#nope', 1));
  refuses(() => r.reserve({ micro: 1.5 }));
  refuses(() => r.reserve({ micro: -1 }));
});

test('ledger: settle and release are one-shot, and a run cannot touch another run reservation or act after run_end', () => {
  const dir = tdir(); const l = openLedger(dir);
  const a = l.openRun(grant(), 'run-a'); const b = l.openRun(grant(), 'run-b');
  const rid = a.reserve({ micro: 10 });
  refuses(() => b.settle(rid, 10));
  a.release(rid);
  refuses(() => a.settle(rid, 10));
  assert.equal(a.remaining().open_micro, 0);
  a.endRun('completed');
  refuses(() => a.reserve({ micro: 1 }));
  refuses(() => l.openRun(grant(), 'run-a'));
});

test('ledger: two concurrent meters (separate processes) can never overspend', async () => {
  const dir = tdir(); openLedger(dir); // creates the 0700 dir
  const g = grant(); // 1000 micro; 5 workers x 10 attempts x 100 micro would be 5000 without a shared limit
  const worker = (i) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [join(HERE, 'ledger-worker.js'), dir, JSON.stringify(g), `w-${i}`, '100', '10', '15'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('error', rej);
    c.on('exit', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`worker exit ${code}`))));
  });
  const results = await Promise.all([0, 1, 2, 3, 4].map(worker));
  const granted = results.reduce((n, r) => n + r.ok, 0);
  assert.equal(results.reduce((n, r) => n + r.errors, 0), 0, 'no worker hit a ledger error (a broken chain would show here)');
  assert.equal(granted, 10, 'exactly budget/100 reservations were granted across all processes');
  const s = openLedger(dir).remaining(g);
  assert.equal(s.settled_micro, 1000); assert.equal(s.remaining_micro, 0); assert.equal(s.open_micro, 0);
});

test('ledger: no API-key-shaped or unexpected free text can enter a line (only ids and integers)', () => {
  const dir = tdir(); const l = openLedger(dir);
  refuses(() => l.openRun(grant(), 'sk-or-v1-FAKEKEY with spaces'));
  const r = l.openRun(grant(), 'run-1');
  r.settle(r.reserve({ micro: 5 }), 5);
  assert.throws(() => r.endRun('sk-or-v1-FAKEKEY-for-tests-only-0123456789'));
  r.endRun('completed');
  assert.ok(!readFileSync(join(dir, files(dir)[0]), 'utf8').includes('sk-or'));
});

const real = { writeSync, fsyncSync };

test('ledger durability: a short write is retried until every byte is written, and the line is intact', () => {
  const dir = tdir(); let shorted = 0;
  const io = { ...real, writeSync: (fd, buf, off, len) => { if (len > 10 && shorted < 3) { shorted += 1; return writeSync(fd, buf, off, 7); } return writeSync(fd, buf, off, len); } };
  const l = openLedger(dir, { io }); const r = l.openRun(grant(), 'run-1'); r.settle(r.reserve({ micro: 5 }), 5);
  assert.ok(shorted >= 3, 'the injected writer really did write short');
  assert.equal(r.remaining().settled_micro, 5, 'the chain replays cleanly');
  assert.ok(readFileSync(join(dir, files(dir)[0]), 'utf8').endsWith('\n'));
});

test('ledger durability: a write that makes no progress refuses with a clear error (never a silent partial append)', () => {
  const dir = tdir(); let on = false;
  const io = { ...real, writeSync: (fd, buf, off, len) => (on ? 0 : writeSync(fd, buf, off, len)) };
  const l = openLedger(dir, { io }); const r = l.openRun(grant(), 'run-1');
  on = true;
  assert.throws(() => r.reserve({ micro: 1 }), (e) => e instanceof LedgerError && /short write|lock/.test(e.message));
});

test('ledger durability: an impossible write return value refuses', () => {
  const dir = tdir(); let on = false;
  const io = { ...real, writeSync: (fd, buf, off, len) => (on ? len + 5 : writeSync(fd, buf, off, len)) };
  const l = openLedger(dir, { io }); const r = l.openRun(grant(), 'run-1'); on = true;
  assert.throws(() => r.reserve({ micro: 1 }), LedgerError);
});

test('ledger durability: files are fsynced after every append, and directories after a new ledger file or a lock appears', () => {
  const dir = tdir(); const calls = [];
  const io = { ...real, fsyncSync: (fd) => { calls.push(fstatSync(fd).isDirectory() ? 'dir' : 'file'); return fsyncSync(fd); } };
  const l = openLedger(dir, { io });
  l.openRun(grant(), 'run-1'); // new ledger file: lock (file, tmp dir, parent dir) + ledger file + its directory
  assert.deepEqual(calls, ['file', 'dir', 'dir', 'file', 'dir']);
  calls.length = 0;
  l.openRun(grant(), 'run-2'); // existing ledger file: lock (3) + ledger file only
  assert.deepEqual(calls, ['file', 'dir', 'dir', 'file']);
});

test('ledger durability: a failing fsync refuses and does not leave the lock behind', () => {
  const dir = tdir(); let fail = false;
  const io = { ...real, fsyncSync: (fd) => { if (fail) { const e = new Error('x'); e.code = 'EIO'; throw e; } return fsyncSync(fd); } };
  const l = openLedger(dir, { io }); const r = l.openRun(grant(), 'run-1'); fail = true;
  assert.throws(() => r.reserve({ micro: 1 }), LedgerError);
  fail = false;
  r.reserve({ micro: 1 }); // lock was not left behind by the failed attempt
});

test('ledger operator errors: a lock with a missing, corrupt, unreadable or malformed owner refuses at once, names the lock and the command, and is never removed', () => {
  const dir = tdir(); const l = openLedger(dir, { lockTimeoutMs: 5000, lockPollMs: 5 });
  const r = l.openRun(grant(), 'run-1');
  const lock = join(realpathSync.native(dir), `${files(dir)[0]}.lock`);
  const cases = {
    'no owner.json': () => writeFileSync(join(lock, 'stray'), 'x'),
    'corrupt owner.json': () => writeFileSync(join(lock, 'owner.json'), '{not json'),
    'unreadable owner.json': () => mkdirSync(join(lock, 'owner.json')),
    'malformed owner (pid is a string)': () => writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 'abc', at_ms: 1 })),
    'malformed owner (no at_ms)': () => writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 1 })),
  };
  for (const [name, make] of Object.entries(cases)) {
    mkdirSync(lock); make();
    const t0 = Date.now();
    assert.throws(() => r.reserve({ micro: 1 }), (e) => e instanceof LedgerError && e.message.includes(lock) && e.message.includes(`rm -r '${lock}'`) && /NOT broken automatically/.test(e.message), name);
    assert.ok(Date.now() - t0 < 2000, `${name}: refuses promptly, not after the full lock timeout`);
    assert.ok(existsSync(lock), `${name}: the lock is left in place`);
    rmSync(lock, { recursive: true });
  }
  assert.equal(lines(dir).length, 1, 'nothing was appended');
  r.reserve({ micro: 1 });
});

test('ledger operator errors: a live pid holding the lock past the maximum age refuses with the pid, the age and the command; under the maximum it waits', () => {
  const dir = tdir(); const l = openLedger(dir, { lockTimeoutMs: 150, lockPollMs: 5, lockMaxAgeMs: 1000 });
  const r = l.openRun(grant(), 'run-1');
  const lock = join(realpathSync.native(dir), `${files(dir)[0]}.lock`);
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at_ms: Date.now() - 5000 }));
  assert.throws(() => r.reserve({ micro: 1 }), (e) => e instanceof LedgerError && e.message.includes(lock) && e.message.includes(`pid ${process.pid}`) && /maximum/.test(e.message) && e.message.includes(`rm -r '${lock}'`));
  assert.ok(existsSync(lock)); rmSync(lock, { recursive: true });
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at_ms: Date.now() }));
  assert.throws(() => r.reserve({ micro: 1 }), /lock timeout on /); // young live lock: waits, then times out
  assert.ok(existsSync(lock));
});

test('ledger operator errors: the clearing command quotes a path containing a single quote', () => {
  const base = mkdtempSync(join(tmpdir(), "ledger-q'uote-")); const lock = join(base, 'x.lock'); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), '{');
  assert.throws(() => acquireLock(lock, { timeoutMs: 50, pollMs: 5 }), (e) => e.message.includes(`rm -r '${base.replace(/'/g, `'\\''`)}/x.lock'`));
});

test('ledger lock wait: the timeout is honoured even with a long poll interval, and it sleeps rather than spins', () => {
  const dir = tdir(); const l = openLedger(dir, { lockTimeoutMs: 120, lockPollMs: 5000 });
  const r = l.openRun(grant(), 'run-1');
  const lock = join(realpathSync.native(dir), `${files(dir)[0]}.lock`);
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at_ms: Date.now() }));
  const t0 = Date.now(); const cpu0 = process.cpuUsage();
  assert.throws(() => r.reserve({ micro: 1 }), /lock timeout on /);
  const elapsed = Date.now() - t0; const cpu = process.cpuUsage(cpu0);
  assert.ok(elapsed >= 100 && elapsed < 1500, `refused near the 120ms timeout, not after the 5000ms poll (took ${elapsed}ms)`);
  assert.ok((cpu.user + cpu.system) / 1000 < elapsed * 0.6, 'the wait did not burn CPU');
  assert.equal(lines(dir).length, 1);
});
