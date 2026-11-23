import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, ConfineError, isLockedPath, isReadDenied, ALWAYS_LOCKED } from '../src/builder-confine.js';
import { dispatchTool } from '../src/builder-adapter.js';
import { createMeter } from '../src/grant/index.js';
import { openLedger } from '../src/ledger/index.js';
import { makeGrant } from './builder-mock.js';

const refused = (fn) => assert.throws(fn, (e) => e instanceof ConfineError);
const meter = () => createMeter(makeGrant({ budget: { max_usd: 1, max_tool_calls: 50 } }), { now: () => Date.parse('2030-01-01T00:00:00Z') });

test('ledger confine: src/ledger/ and the ledger directory name are always locked, with case and unicode folding', () => {
  assert.ok(ALWAYS_LOCKED.includes('src/ledger/') && ALWAYS_LOCKED.includes('.agent-ledger/'));
  for (const p of ['src/ledger/ledger.js', 'SRC/Ledger/x.js', 'src/LEDGER​/x.js', 'src/ledger./x.js', '.agent-ledger/g.jsonl', '.AGENT-LEDGER/g.jsonl', './.Agent-Ledger/a/b']) assert.equal(isLockedPath(p), true, p);
  assert.equal(isLockedPath('src/ledgerish/x.js'), false);
  const root = mkdtempSync(join(tmpdir(), 'conf-'));
  for (const p of ['src/ledger/new.js', 'SRC/LEDGER/new.js', '.agent-ledger/x.jsonl', '.Agent-Ledger/x.jsonl']) refused(() => confine(root, p, { write: true, allowedPaths: ['.'] }));
});

test('ledger confine: the read denylist refuses the ledger directory name in any case', () => {
  for (const p of ['.agent-ledger/g.jsonl', '.AGENT-LEDGER', 'a/.Agent-Ledger/x']) { assert.equal(isReadDenied(p), true, p); }
  const root = mkdtempSync(join(tmpdir(), 'conf-')); mkdirSync(join(root, '.agent-ledger')); writeFileSync(join(root, '.agent-ledger', 'g.jsonl'), 'x');
  refused(() => confine(root, '.agent-ledger/g.jsonl'));
  refused(() => confine(root, '.Agent-Ledger/g.jsonl'));
});

test('ledger confine: a ledger directory inside the worktree under any name is refused for read and write, including via symlink', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conf-')));
  const ldir = join(root, 'vault'); mkdirSync(ldir, { mode: 0o700 }); writeFileSync(join(ldir, 'g.jsonl'), 'x');
  mkdirSync(join(root, 'docs'));
  symlinkSync(ldir, join(root, 'docs', 'link'));
  const opts = { protectedDirs: [ldir], allowedPaths: ['.'] };
  for (const p of ['vault/g.jsonl', 'VAULT/g.jsonl', 'vault/new.jsonl', 'docs/link/g.jsonl']) {
    refused(() => confine(root, p, opts));
    refused(() => confine(root, p, { ...opts, write: true }));
  }
  assert.doesNotThrow(() => confine(root, 'docs/ok.md', { ...opts, write: true }));
});

test('ledger confine: the adapter read_file, list_dir and write_file tools refuse the ledger directory', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conf-')));
  const ldir = join(root, 'vault'); mkdirSync(ldir, { mode: 0o700 }); writeFileSync(join(ldir, 'g.jsonl'), 'SECRET-LEDGER');
  mkdirSync(join(root, 'docs'));
  const ctx = { workdir: root, allowed: ['.'], written: new Set(), protectedDirs: [ldir] };
  const m = meter();
  refused(() => dispatchTool(m, ctx, 'read_file', { path: 'vault/g.jsonl' }));
  refused(() => dispatchTool(m, ctx, 'list_dir', { path: 'vault' }));
  refused(() => dispatchTool(m, ctx, 'write_file', { path: 'vault/g.jsonl', content: 'forged' }));
  refused(() => dispatchTool(m, ctx, 'write_file', { path: 'src/ledger/ledger.js', content: 'x' }));
  refused(() => dispatchTool(m, ctx, 'read_file', { path: '.agent-ledger/g.jsonl' }));
  assert.equal(readFileSync(join(ldir, 'g.jsonl'), 'utf8'), 'SECRET-LEDGER');
  assert.match(dispatchTool(m, ctx, 'write_file', { path: 'docs/ok.md', content: 'fine' }), /wrote docs\/ok\.md/);
});

test('ledger confine: the real ledger is outside the worktree, so an absolute or parent-relative path to it is refused too', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conf-')));
  const dir = join(mkdtempSync(join(tmpdir(), 'ledger-out-')), 'l'); const l = openLedger(dir);
  l.openRun(makeGrant(), 'run-1');
  refused(() => confine(root, dir));
  refused(() => confine(root, `../${dir}`));
  refused(() => confine(root, '../l/x.jsonl', { write: true }));
  assert.equal(existsSync(dir), true);
});
