import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, EXIT } from '../src/gateway/cli.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cap = () => { const out = []; const err = []; return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err }; };
const failing = async () => ({ ok: false, checks: [{ id: 'b', name: 'gateway reachable', ok: false, why: 'nope', fix: 'start it' }] });
const passing = async () => ({ ok: true, checks: [{ id: 'a', name: 'config valid', ok: true, why: 'fine', fix: null }] });
const newHome = () => join(mkdtempSync(join(tmpdir(), 'gw-cli-')), 'ah');

test('a failing doctor blocks agent run, whatever flags or environment are given', async () => {
  for (const argv of [['run'], ['run', '--skip-doctor'], ['run', '--force', '--no-doctor'], ['run', '--', '--doctor=off']]) {
    const c = cap();
    const code = await main(argv, { env: { AGENT_HOME: newHome(), AGENT_SKIP_DOCTOR: '1', SKIP_DOCTOR: '1', CI: '1' }, io: c.io, deps: { doctor: failing } });
    assert.equal(code, EXIT.FAILED, argv.join(' '));
    assert.match(c.err.join('\n'), /refused because doctor failed/);
    assert.ok(!c.err.join('\n').includes('not implemented'), 'never reaches the run body');
  }
});

test('with doctor passing, run prints not implemented in M1a and exits non-zero', async () => {
  const c = cap();
  const code = await main(['run'], { env: { AGENT_HOME: newHome() }, io: c.io, deps: { doctor: passing } });
  assert.equal(code, EXIT.NOT_IMPLEMENTED);
  assert.match(c.err.join('\n'), /not implemented in M1a/);
});

test('upgrade is not implemented; unknown commands print usage', async () => {
  const c = cap();
  assert.equal(await main(['upgrade'], { env: { AGENT_HOME: newHome() }, io: c.io }), EXIT.NOT_IMPLEMENTED);
  assert.match(c.err.join('\n'), /not implemented in M1a/);
  const d = cap();
  assert.equal(await main(['frobnicate'], { env: { AGENT_HOME: newHome() }, io: d.io }), EXIT.USAGE);
  assert.match(d.err.join('\n'), /usage: agent/);
});

test('doctor exits non-zero on any failure and zero when all pass', async () => {
  const c = cap();
  assert.equal(await main(['doctor'], { env: { AGENT_HOME: newHome() }, io: c.io, deps: { doctor: failing } }), EXIT.FAILED);
  assert.match(c.out.join('\n'), /FAIL \(b\)/);
  assert.equal(await main(['doctor'], { env: { AGENT_HOME: newHome() }, io: cap().io, deps: { doctor: passing } }), EXIT.OK);
});

test('init creates the home and never overwrites; status and ledger:report work on it', async () => {
  const home = newHome(); const env = { AGENT_HOME: home };
  const c = cap();
  assert.equal(await main(['init'], { env, io: c.io }), EXIT.OK);
  assert.ok(existsSync(join(home, 'config.json')));
  assert.equal(statSync(join(home, 'ledger')).mode & 0o777, 0o700);
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  const c2 = cap();
  assert.equal(await main(['init'], { env, io: c2.io }), EXIT.OK);
  assert.match(c2.out.join('\n'), /kept/); assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
  const rep = cap();
  assert.equal(await main(['ledger:report'], { env, io: rep.io }), EXIT.OK);
  assert.match(rep.out.join('\n'), /No grant ledgers found/);
  const st = cap();
  assert.equal(await main(['status'], { env, io: st.io, deps: { ping: async () => { throw new Error('down'); } } }), EXIT.FAILED);
  assert.match(st.out.join('\n'), /NOT reachable/);
  const up = cap();
  assert.equal(await main(['status'], { env, io: up.io, deps: { ping: async () => ({ ok: true, result: { version: 'm1a.1', uptime_ms: 5, access: 'kernel-permissions-only (no peer-uid probe configured)' } }) } }), EXIT.OK);
  assert.match(up.out.join('\n'), /access:\s+kernel-permissions-only/);
});

test('commands that need a config fail closed without one', async () => {
  const env = { AGENT_HOME: newHome() };
  const c = cap();
  assert.equal(await main(['status'], { env, io: c.io }), EXIT.FAILED);
  assert.equal(await main(['ledger:report'], { env, io: cap().io }), EXIT.FAILED);
});

test('bin/agent is a real executable: doctor against an empty home exits 1, init then run is refused', () => {
  const home = newHome();
  const env = { ...process.env, AGENT_HOME: home };
  const bin = join(root, 'bin', 'agent');
  assert.ok(statSync(bin).mode & 0o100, 'executable bit');
  assert.equal(spawnSync(process.execPath, [bin, 'doctor'], { env, encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [bin, 'init'], { env, encoding: 'utf8' }).status, 0);
  const r = spawnSync(process.execPath, [bin, 'run'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /refused because doctor failed/);
  assert.equal(spawnSync(process.execPath, [bin, 'upgrade'], { env, encoding: 'utf8' }).status, 2);
});
