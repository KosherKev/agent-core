import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger } from '../src/ledger/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const grant = (over = {}) => ({ schema_version: '1', task_id: 'g-report', scope: { repos: ['agent-core'], paths: ['docs/'] }, budget: { max_usd: 0.001, max_tool_calls: 5 }, expires_at: '2099-01-01T00:00:00Z', allowed_risk_tiers: ['low'], ...over });
const tdir = () => join(mkdtempSync(join(tmpdir(), 'ledger-rep-')), 'l');
const report = (dir) => spawnSync(process.execPath, [join(REPO, 'src/ledger/report.js'), '--dir', dir], { encoding: 'utf8', env: { ...process.env, AGENT_LEDGER_DIR: dir } });
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));

test('ledger report: shows limit, settled, open reservations, remaining and a run without run_end', () => {
  const dir = tdir(); const l = openLedger(dir);
  const r1 = l.openRun(grant(), 'run-done'); r1.settle(r1.reserve({ micro: 300 }), 300); r1.reserveTool(); r1.endRun('completed');
  const r2 = l.openRun(grant(), 'run-crashed'); r2.reserve({ micro: 200 });
  const before = snapshot(dir);
  const out = report(dir);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Grant g-report/);
  assert.match(out.stdout, /limit:\s+1000 micro-USD.*5 tool calls/);
  assert.match(out.stdout, /settled:\s+300 micro-USD/);
  assert.match(out.stdout, /open reservations: 1 holding 200 micro-USD/);
  assert.match(out.stdout, /remaining:\s+500 micro-USD \([^)]*\), 4 tool calls \(1 used\)/);
  assert.match(out.stdout, /runs without run_end: run-crashed/);
  assert.deepEqual(snapshot(dir), before, 'the report is read-only');
});

test('ledger report: fails with a clear error on a broken chain, and still reports healthy grants', () => {
  const dir = tdir(); const l = openLedger(dir);
  const a = l.openRun(grant({ task_id: 'g-ok' }), 'run-1'); a.reserve({ micro: 1 });
  const b = l.openRun(grant({ task_id: 'g-bad' }), 'run-1'); b.reserve({ micro: 1 }); b.reserve({ micro: 1 });
  const bad = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n)).find((f) => readFileSync(f, 'utf8').includes('g-bad'));
  const ls = readFileSync(bad, 'utf8').trim().split('\n'); ls.splice(1, 1); writeFileSync(bad, ls.join('\n') + '\n');
  const out = report(dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /ERROR .*hash chain broken/);
  assert.match(out.stdout, /Grant g-ok/);
  assert.match(out.stderr, /failed verification/);
});

test('ledger report: a missing directory is reported, not created', () => {
  const dir = tdir();
  const out = report(dir);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /No ledger directory yet/);
  assert.equal(existsSync(dir), false);
});

const corrupt = (dir) => { // two grants' worth of damage: delete a middle line from one ledger
  const l = openLedger(dir); const r = l.openRun(grant({ task_id: 'g-corrupt' }), 'run-1'); r.reserve({ micro: 1 }); r.reserve({ micro: 1 });
  const f = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n))[0];
  const ls = readFileSync(f, 'utf8').trim().split('\n'); ls.splice(1, 1); writeFileSync(f, ls.join('\n') + '\n');
};
const run = (script, dir) => spawnSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });

test('ledger report: a repo path containing a space still runs the CLI and flags a corrupt ledger', () => {
  const dir = tdir(); corrupt(dir);
  const copy = join(mkdtempSync(join(tmpdir(), 'ledger rep space-')), 'my repo');
  mkdirSync(copy); cpSync(join(REPO, 'src'), join(copy, 'src'), { recursive: true });
  const out = run(join(copy, 'src/ledger/report.js'), dir);
  assert.equal(out.status, 1, `stdout=${out.stdout} stderr=${out.stderr}`);
  assert.match(out.stdout, /ERROR .*hash chain broken/);
  assert.match(out.stderr, /failed verification/);
});

test('ledger report: a symlinked invocation path still runs the CLI and flags a corrupt ledger', () => {
  const dir = tdir(); corrupt(dir);
  const link = join(mkdtempSync(join(tmpdir(), 'ledger-rep-link-')), 'report-link.js');
  symlinkSync(join(REPO, 'src/ledger/report.js'), link);
  const out = run(link, dir);
  assert.equal(out.status, 1, `stdout=${out.stdout} stderr=${out.stderr}`);
  assert.match(out.stdout, /ERROR .*hash chain broken/);
});

test('ledger report: a space path AND a symlink together, with a healthy ledger, print the report and exit 0', () => {
  const dir = tdir(); openLedger(dir).openRun(grant(), 'run-1');
  const base = mkdtempSync(join(tmpdir(), 'ledger rep both-'));
  const copy = join(base, 'my repo'); mkdirSync(copy); cpSync(join(REPO, 'src'), join(copy, 'src'), { recursive: true });
  const link = join(base, 'link to report.js'); symlinkSync(join(copy, 'src/ledger/report.js'), link);
  const out = run(link, dir);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Grant g-report/);
});

test('ledger report: an unexpected ledger error exits non-zero with a clear message', () => {
  const dir = tdir(); corrupt(dir);
  const out = spawnSync(process.execPath, [join(REPO, 'src/ledger/report.js'), '--dir', join(dir, readdirSync(dir)[0])], { encoding: 'utf8' }); // a file, not a directory
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ledger:report: ERROR/);
});

test('ledger report: isCliEntry fails closed when the comparison throws, and is false when imported', async () => {
  const { isCliEntry } = await import('../src/ledger/report.js');
  assert.equal(isCliEntry('/definitely/not/a/real/path/x.js'), true);
  assert.equal(isCliEntry(undefined), false);
  assert.equal(isCliEntry(join(REPO, 'test/ledger.test.js')), false);
});
