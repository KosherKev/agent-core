import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
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

test('agent run requires the FULL doctor: a partial pass is refused', async () => {
  const partial = async () => ({ ok: true, partial: { run: 2, of: 8 }, notes: [], checks: [{ id: 'a', name: 'config valid', ok: true, why: 'fine', fix: null }] });
  const c = cap();
  assert.equal(await main(['run', '--only', 'a'], { env: { AGENT_HOME: newHome() }, io: c.io, deps: { doctor: partial } }), EXIT.FAILED);
  assert.match(c.err.join('\n'), /refused because doctor failed/);
});

test('doctor --only prints PARTIAL and exits non-zero when a selected check fails, zero when the selected ones pass', async () => {
  const mk = (ok) => async () => ({ ok, partial: { run: 1, of: 8 }, notes: [], checks: [{ id: 'a', name: 'config valid', ok, why: ok ? 'fine' : 'bad', fix: ok ? null : 'fix it' }] });
  const a = cap(); assert.equal(await main(['doctor', '--only', 'a'], { env: { AGENT_HOME: newHome() }, io: a.io, deps: { doctor: mk(true) } }), EXIT.OK);
  assert.match(a.out.join('\n'), /PARTIAL: 1 of 8 checks run/); assert.ok(!a.out.join('\n').includes('all checks passed'));
  const b = cap(); assert.equal(await main(['doctor', '--only', 'a'], { env: { AGENT_HOME: newHome() }, io: b.io, deps: { doctor: mk(false) } }), EXIT.FAILED);
  assert.match(b.out.join('\n'), /PARTIAL: 1 of 8 checks run; 1 FAILED/);
});

test('doctor passes --gateway-user to the doctor, rejects a malformed one, and never takes the gateway identity from the environment', async () => {
  let seen; const spy = async (o) => { seen = o; return { ok: true, checks: [], partial: null, notes: [] }; };
  await main(['doctor', '--gateway-user', 'agentgw'], { env: { AGENT_HOME: newHome(), AGENT_GATEWAY_USER: 'evil', AGENT_GATEWAY_SOCKET: '/tmp/x.sock' }, io: cap().io, deps: { doctor: spy } });
  assert.equal(seen.gatewayUser, 'agentgw');
  const c = cap();
  assert.equal(await main(['doctor', '--gateway-user', 'bad name;rm'], { env: { AGENT_HOME: newHome() }, io: c.io, deps: { doctor: spy } }), EXIT.USAGE);
  seen = undefined;
  await main(['doctor'], { env: { AGENT_HOME: newHome(), AGENT_GATEWAY_USER: 'evil' }, io: cap().io, deps: { doctor: spy } });
  assert.equal(seen.gatewayUser, undefined);
});

test('doctor with an unreadable config, AGENT_GATEWAY_SOCKET set and no --gateway-user refuses the trust checks without touching the socket', async () => {
  let pinged = 0;
  const probes = { readConfig: () => ({ valid: false, errors: ['denied'], config: null, denied: true }), ping: async () => { pinged += 1; return { ok: true }; }, uid: () => 2002, stat: () => ({ ok: false, code: 'ENOENT' }), resolveGroup: () => null, lockedChecksum: () => ({ sha256: 'a'.repeat(64), files: 1 }) };
  const c = cap();
  const code = await main(['doctor'], { env: { AGENT_HOME: newHome(), AGENT_GATEWAY_SOCKET: '/tmp/impostor.sock' }, io: c.io, deps: { probes } });
  assert.equal(code, EXIT.FAILED); assert.equal(pinged, 0);
  assert.match(c.out.join('\n'), /--gateway-user/);
  for (const id of ['b', 'c', 'd', 'f']) assert.match(c.out.join('\n'), new RegExp(`FAIL \\(${id}\\)`));
});

test('status: an unreadable config.json is "not readable by this user" (expected for the runner); a readable bad one stays INVALID', async (t) => {
  const home = newHome(); const env = { AGENT_HOME: home };
  assert.equal(await main(['init'], { env, io: cap().io }), EXIT.OK);
  const cfg = join(home, 'config.json');
  const good = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, '{ not json');
  const bad = cap();
  assert.equal(await main(['status'], { env, io: bad.io }), EXIT.FAILED);
  assert.match(bad.out.join('\n'), /config: INVALID/);
  writeFileSync(cfg, good); chmodSync(cfg, 0o000);
  try {
    if (process.getuid?.() === 0) { t.skip('root ignores file modes'); return; }
    const den = cap();
    assert.equal(await main(['status'], { env, io: den.io }), EXIT.FAILED);
    const text = den.out.join('\n');
    assert.match(text, /not readable by this user \(expected for the runner/); assert.match(text, /agent doctor --gateway-user/);
    assert.doesNotMatch(text, /INVALID|EACCES/);
  } finally { chmodSync(cfg, 0o600); }
});
