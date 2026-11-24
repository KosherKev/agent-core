import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLedgerStore } from '../src/gateway/store.js';
import { makeGrant } from './builder-mock.js';

const store = () => createFileLedgerStore(join(mkdtempSync(join(tmpdir(), 'gw-store-')), 'l'));

test('store interface exposes append, read, lock, report', () => {
  const s = store();
  for (const m of ['append', 'read', 'lock', 'report', 'meterLedger']) assert.equal(typeof s[m], 'function', m);
});

test('append registers a run; read reports integer remaining numbers; report lists the grant', () => {
  const s = store(); const g = makeGrant({ budget: { max_usd: 0.5, max_tool_calls: 4 } });
  const run = s.append(g, 'run-1');
  const rid = run.reserve({ micro: 1000 });
  run.settle(rid, 400);
  const r = s.read(g);
  assert.equal(r.settled_micro, 400);
  assert.equal(r.remaining_micro, 500_000 - 400);
  const rep = s.report();
  assert.equal(rep.failed, false);
  assert.match(rep.lines.join('\n'), /Grant /);
});

test('append refuses a reused run id and a mutated grant (the existing ledger rules apply)', () => {
  const s = store(); const g = makeGrant();
  s.append(g, 'run-1');
  assert.throws(() => s.append(g, 'run-1'), /already used/);
  assert.throws(() => s.append({ ...g, budget: { max_usd: 2, max_tool_calls: 10 } }, 'run-2'), /differs|mutated/);
});

test('lock is exclusive and released afterwards; a bad name is refused', () => {
  const s = createFileLedgerStore(join(mkdtempSync(join(tmpdir(), 'gw-store-')), 'l'), { lockTimeoutMs: 50 });
  let inner = 'not run';
  const out = s.lock('x', () => { assert.throws(() => s.lock('x', () => { inner = 'ran'; }), /lock|held|refus/i); return 'done'; });
  assert.equal(out, 'done'); assert.equal(inner, 'not run');
  assert.equal(s.lock('x', () => 'again'), 'again');
  assert.throws(() => s.lock('../evil', () => 1), /invalid/);
});

test('the store refuses a ledger directory inside the repository', () => {
  assert.throws(() => createFileLedgerStore(join(process.cwd(), 'inside-repo-ledger')), /outside the repository/);
});
