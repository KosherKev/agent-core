import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { writeFileSync, mkdtempSync, chmodSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatDoctor, wellFormedPing } from '../src/gateway/doctor.js';
import { realProbes, lockedChecksum } from '../src/gateway/probes.js';
import { isGatewayCmdline, processInfo, resolveGroup } from '../src/gateway/sys.js';
import { createGatewayServer, unknownPeerUid } from '../src/gateway/server.js';
import { checkPriceTable } from '../src/gateway/prices.js';
import { parsePriceTable } from '../src/grant/index.js';
import { tempHome, makeApi } from './gateway-helpers.js';
import { REPO_ROOT } from '../src/self-model.js';

const GW = 1001; const RUNNER = 2002; const GID = 3003; const PID = 4321;
const CMD = '/usr/bin/node /opt/agent-core/bin/agent gateway';

/** A fake-uid config on disk (the doctor reads it for real); every system probe is faked. */
function setup() {
  const t = tempHome();
  const raw = { ...t.raw, identities: { gateway_uid: GW, runner_uid: RUNNER }, runner_group: GID };
  writeFileSync(join(t.home, 'config.json'), JSON.stringify(raw));
  const cfg = { ...t.config, identities: { gateway_uid: GW, runner_uid: RUNNER }, runner_group: GID };
  const layout = { config_version: 1, home: t.home, socket_dir: cfg.socket_dir, socket_path: cfg.socket_path, credentials_file: cfg.credentials_file, ledger_dir: cfg.ledger_dir, runs_dir: cfg.runs_dir, pid_file: cfg.pid_file, gateway_uid: GW, runner_group: GID, runner_gid: GID };
  return { t, cfg, layout };
}
/** Every probe healthy. Each test breaks exactly one thing. */
function healthy(s, o = {}) {
  const { t, cfg, layout } = s;
  const table = {
    [t.home]: { ok: true, type: 'dir', mode: 0o700, uid: GW, gid: 5 },
    [join(t.home, 'config.json')]: { ok: true, type: 'file', mode: 0o600, uid: GW, gid: 5 },
    [cfg.socket_dir]: { ok: true, type: 'dir', mode: 0o750, uid: GW, gid: GID },
    [cfg.socket_path]: { ok: true, type: 'socket', mode: 0o660, uid: GW, gid: GID },
  };
  return {
    uid: () => RUNNER,
    readConfig: (h) => ({ valid: true, errors: [], config: cfg, home: h }),
    stat: (p) => table[p] ?? { ok: false, code: 'ENOENT' },
    resolveGroup: (g) => g,
    ping: async () => ({ id: 1, ok: true, result: { version: 'm1a.1', uptime_ms: 1234, pid: PID, access: 'kernel-permissions-only (no peer-uid probe configured)', layout } }),
    tryRead: () => 'denied', tryList: () => 'denied', tryCreate: () => 'denied',
    readPid: () => PID,
    processInfo: (pid) => ({ pid, uid: GW, cmdline: CMD }),
    tcpListeners: async () => [],
    lockedChecksum: () => ({ sha256: 'ab'.repeat(32), files: 3 }),
    table,
    ...o,
  };
}
const withTable = (s, patch) => { const p = healthy(s); const t2 = { ...p.table }; for (const [k, v] of Object.entries(patch)) t2[k] = v === null ? { ok: false, code: 'ENOENT' } : { ...t2[k], ...v }; return { ...p, stat: (x) => t2[x] ?? { ok: false, code: 'ENOENT' } }; };
const priceFile = (models) => { const f = join(mkdtempSync(join(tmpdir(), 'gw-pf-')), 'p.json'); writeFileSync(f, JSON.stringify({ schema_version: '1', models })); return f; };
const run = (s, probes, extra = {}) => runDoctor({ home: s.t.home, probes, ...extra });
const byId = (r, id) => r.checks.find((c) => c.id === id);
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);

test('healthy fakes: all eight checks pass, each with a one-line reason, and the checksum is printed', async () => {
  const s = setup();
  const r = await run(s, healthy(s));
  assert.equal(r.ok, true, formatDoctor(r));
  assert.deepEqual(r.checks.map((c) => c.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  for (const c of r.checks) { assert.ok(c.why.length > 0 && !c.why.includes('\n')); assert.equal(c.fix, null); }
  assert.match(formatDoctor(r), /sha256 (ab){32}/);
  assert.match(byId(r, 'e').why, /kernel permissions only/);
});

// Each entry breaks exactly one thing. `also` lists checks that legitimately depend on the broken one (e passes only if a to d passed).
const home = (s) => s.t.home; const cfgFile = (s) => join(s.t.home, 'config.json');
const breaks = [
  ['a', 'home mode 0755', (s) => withTable(s, { [home(s)]: { mode: 0o755 } }), ['e']],
  ['a', 'home owned by the runner', (s) => withTable(s, { [home(s)]: { uid: RUNNER } }), ['e']],
  ['a', 'home 0750', (s) => withTable(s, { [home(s)]: { mode: 0o750 } }), ['e']],
  ['a', 'config.json group writable', (s) => withTable(s, { [cfgFile(s)]: { mode: 0o660 } }), ['e']],
  ['a', 'config.json owned by the runner', (s) => withTable(s, { [cfgFile(s)]: { uid: RUNNER } }), ['e']],
  ['a', 'socket_dir mode 0770', (s) => withTable(s, { [s.cfg.socket_dir]: { mode: 0o770 } }), ['e']],
  ['a', 'socket_dir wrong group', (s) => withTable(s, { [s.cfg.socket_dir]: { gid: 9 } }), ['e']],
  ['a', 'socket_dir owned by another user', (s) => withTable(s, { [s.cfg.socket_dir]: { uid: 5 } }), ['e']],
  ['a', 'config invalid', (s) => { writeFileSync(join(s.t.home, 'config.json'), '{"config_version":9}'); return { ...healthy(s), readConfig: (h) => ({ valid: false, errors: ['config_version must be 1'], config: null, home: h }) }; }, ['b', 'c', 'd', 'e', 'f']],
  ['b', 'server refuses everyone', (s) => healthy(s, { ping: async () => { throw new Error('gateway closed the connection'); } }), ['e']],
  ['b', 'server silent', (s) => healthy(s, { ping: async () => { throw new Error('gateway request timed out'); } }), ['e']],
  ['b', 'ping reply malformed', (s) => healthy(s, { ping: async () => ({ ok: true, result: { version: 5 } }) }), ['e']],
  ['b', 'ping reply is an error', (s) => healthy(s, { ping: async () => ({ ok: false, error: { code: 'x' } }) }), ['e']],
  ['c', 'socket mode 0600', (s) => withTable(s, { [s.cfg.socket_path]: { mode: 0o600 } }), ['e']],
  ['c', 'socket mode 0666', (s) => withTable(s, { [s.cfg.socket_path]: { mode: 0o666 } }), ['e']],
  ['c', 'socket owned by someone else', (s) => withTable(s, { [s.cfg.socket_path]: { uid: RUNNER } }), ['e']],
  ['c', 'socket in the wrong group', (s) => withTable(s, { [s.cfg.socket_path]: { gid: 9 } }), ['e']],
  ['c', 'socket missing', (s) => withTable(s, { [s.cfg.socket_path]: null }), ['e']],
  ['c', 'path is not a socket', (s) => withTable(s, { [s.cfg.socket_path]: { type: 'file' } }), ['e']],
  ['d', 'runner CAN read the credential file', (s) => healthy(s, { tryRead: (p) => (p.endsWith('credentials.json') ? 'allowed' : 'denied') }), ['e']],
  ['d', 'runner CAN list the ledger', (s) => healthy(s, { tryList: () => 'allowed' }), ['e']],
  ['d', 'runner CAN read config.json', (s) => healthy(s, { tryRead: (p) => (p.endsWith('config.json') ? 'allowed' : 'denied') }), ['e']],
  ['d', 'runner CAN create a file in AGENT_HOME', (s) => healthy(s, { tryCreate: (p) => (p === s.t.home ? 'allowed' : 'denied') }), ['e']],
  ['d', 'runner CAN create a file in socket_dir', (s) => healthy(s, { tryCreate: (p) => (p === s.cfg.socket_dir ? 'allowed' : 'denied') }), ['e']],
  ['d', 'credential file missing (not proven denied)', (s) => healthy(s, { tryRead: (p) => (p.endsWith('credentials.json') ? 'missing' : 'denied') }), ['e']],
  ['d', 'doctor run as the gateway identity', (s) => healthy(s, { uid: () => GW }), ['e']],
  ['d', 'doctor run as root', (s) => healthy(s, { uid: () => 0 }), ['e']],
  ['e', 'gateway uses a peer probe that admits another uid', (s) => healthy(s, { ping: async () => ({ ok: true, result: { version: 'm1a.1', uptime_ms: 1, pid: PID, access: 'kernel-permissions+peer-uid-probe', layout: s.layout } }), peerDecision: async () => ({ runnerAdmitted: true, otherAdmitted: true }) }), []],
  ['e', 'gateway uses a peer probe doctor cannot exercise', (s) => healthy(s, { ping: async () => ({ ok: true, result: { version: 'm1a.1', uptime_ms: 1, pid: PID, access: 'kernel-permissions+peer-uid-probe', layout: s.layout } }) }), []],
  ['e', 'probe refuses the runner too', (s) => healthy(s, { peerDecision: async () => ({ runnerAdmitted: false, otherAdmitted: false }) }), []],
  ['f', 'TCP listener present', (s) => healthy(s, { tcpListeners: async () => ['*:8080'] }), []],
  ['f', 'listeners cannot be determined', (s) => healthy(s, { tcpListeners: async () => null }), []],
  ['f', 'pid cannot be verified (not running)', (s) => healthy(s, { processInfo: () => null }), []],
  ['f', 'pid is not the gateway', (s) => healthy(s, { processInfo: (pid) => ({ pid, uid: GW, cmdline: '/usr/bin/node other.js' }) }), []],
  ['f', 'pid runs as the wrong user', (s) => healthy(s, { processInfo: (pid) => ({ pid, uid: RUNNER, cmdline: CMD }) }), []],
  ['f', 'pid file disagrees with the answering gateway', (s) => healthy(s, { readPid: () => 99 }), []],
  ['f', 'no pid at all', (s) => healthy(s, { ping: async () => { throw new Error('x'); }, readPid: () => null }), ['b', 'e']],
  ['h', 'checksum probe throws', (s) => healthy(s, { lockedChecksum: () => { throw new Error('no list'); } }), []],
];
for (const [id, name, make, also] of breaks) {
  test(`doctor (${id}) fails under a fake that breaks it: ${name}`, async () => {
    const s = setup();
    const r = await run(s, make(s));
    const c = byId(r, id);
    assert.equal(c.ok, false, formatDoctor(r));
    assert.ok(c.why.length > 0 && !c.why.includes('\n') && c.fix && c.fix.length > 10, 'one-line reason and an exact remediation');
    assert.equal(r.ok, false, 'any failure fails the whole doctor');
    assert.deepEqual(failed(r).filter((x) => x !== id).sort(), [...also].sort(), `only ${id} (plus its dependants) fails:\n${formatDoctor(r)}`);
  });
}

test('doctor (e): with a probe in use, the real probe is exercised and passes only if it admits the runner and refuses others', async () => {
  const s = setup();
  const access = 'kernel-permissions+peer-uid-probe';
  const p = healthy(s, { ping: async () => ({ ok: true, result: { version: 'm1a.1', uptime_ms: 1, pid: PID, access, layout: s.layout } }), peerDecision: async () => ({ runnerAdmitted: true, otherAdmitted: false }) });
  const r = await run(s, p);
  assert.equal(r.ok, true, formatDoctor(r)); assert.match(byId(r, 'e').why, /real probe/);
});

test('doctor (g) fails for a bare-model key, a missing price, or an unreadable file; passes when empty or fully priced', async () => {
  const s = setup(); const p = healthy(s);
  assert.equal(byId(await run(s, p, { priceFile: priceFile({}) }), 'g').ok, true);
  assert.equal(byId(await run(s, p, { priceFile: priceFile({ 'prov|m': { input_micro_per_mtok: 1, output_micro_per_mtok: 2 } }) }), 'g').ok, true);
  assert.equal(byId(await run(s, p, { priceFile: priceFile({ 'prov|m': { input_micro_per_mtok: 1 } }) }), 'g').ok, false);
  assert.equal(byId(await run(s, p, { priceFile: priceFile({ 'bare-model': { input_micro_per_mtok: 1, output_micro_per_mtok: 2 } }) }), 'g').ok, false);
  assert.equal(byId(await run(s, p, { priceFile: join(tmpdir(), 'does-not-exist-xyz.json') }), 'g').ok, false);
  assert.equal(checkPriceTable(null).ok, false);
  assert.equal(checkPriceTable(parsePriceTable({ schema_version: '1', models: {} })).ok, true);
});

test('a probe that throws is a failure, never a pass', async () => {
  const s = setup();
  const boom = () => { throw new Error('probe exploded'); };
  const r = await run(s, healthy(s, { ping: boom, stat: boom, tryRead: boom, processInfo: boom, tcpListeners: boom, resolveGroup: boom, uid: boom }));
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(byId(r, id).ok, false, id);
});

test('--only limits what is reported (and what decides the result)', async () => {
  const s = setup();
  const r = await run(s, healthy(s, { tcpListeners: async () => ['x'] }), { only: ['a', 'b'] });
  assert.deepEqual(r.checks.map((c) => c.id), ['a', 'b']); assert.equal(r.ok, true);
  assert.equal((await run(s, healthy(s, { tcpListeners: async () => ['x'] }), { only: ['f'] })).ok, false);
});

test('config.json unreadable by the runner (denied): the layout comes from the gateway ping and the doctor still proves the boundary', async () => {
  const s = setup();
  const denied = (o = {}) => healthy(s, { readConfig: () => ({ valid: false, errors: ['denied'], config: null, denied: true }), tryRead: () => 'denied', ...o });
  const ok = await run(s, denied(), { socketPath: s.cfg.socket_path });
  assert.equal(ok.ok, true, formatDoctor(ok)); assert.match(byId(ok, 'a').why, /unreadable here/);
  const noSock = await run(s, denied());
  assert.equal(byId(noSock, 'a').ok, false); assert.match(byId(noSock, 'a').fix, /AGENT_GATEWAY_SOCKET/);
  const refused = await run(s, denied({ ping: async () => { throw new Error('closed'); } }), { socketPath: s.cfg.socket_path });
  assert.equal(byId(refused, 'a').ok, false); assert.equal(byId(refused, 'b').ok, false);
  const wrongHome = await run(s, denied({ ping: async () => ({ ok: true, result: { version: 'x', uptime_ms: 1, pid: PID, layout: { ...s.layout, home: '/elsewhere' } } }) }), { socketPath: s.cfg.socket_path });
  assert.equal(byId(wrongHome, 'a').ok, false);
  const noLayout = await run(s, denied({ ping: async () => ({ ok: true, result: { version: 'x', uptime_ms: 1, pid: PID } }) }), { socketPath: s.cfg.socket_path });
  assert.equal(byId(noLayout, 'a').ok, false);
});

test('wellFormedPing and isGatewayCmdline', () => {
  assert.equal(wellFormedPing({ ok: true, result: { version: 'v', uptime_ms: 0, pid: 5 } }), true);
  for (const bad of [null, {}, { ok: false }, { ok: true, result: {} }, { ok: true, result: { version: 'v', uptime_ms: -1, pid: 5 } }, { ok: true, result: { version: 'v', uptime_ms: 1, pid: 0 } }]) assert.equal(wellFormedPing(bad), false);
  assert.equal(isGatewayCmdline('node /x/bin/agent gateway'), true);
  assert.equal(isGatewayCmdline('/usr/bin/node /opt/agent gateway --x'), true);
  for (const bad of ['node /x/bin/agent doctor', 'node gateway', 'node agent', '', null, 'sh -c agent-gateway']) assert.equal(isGatewayCmdline(bad), false, String(bad));
});

// ---- real probes against a real server, a real silent socket, real files ----
async function realServer(opts = {}) {
  const t = tempHome({ allowed: [4242] });
  const gw = createGatewayServer({ api: makeApi(t).api, config: t.config, ...opts });
  await gw.start();
  return { t, gw, sock: t.config.socket_path };
}

test('real handshake: a healthy server passes ping; a server that refuses everyone and a silent one fail it', async () => {
  const probes = realProbes({ pingTimeoutMs: 300 });
  const ok = await realServer();
  try { const r = await probes.ping(ok.sock); assert.equal(wellFormedPing(r), true); assert.equal(r.result.pid, process.pid); } finally { await ok.gw.stop(); }
  const refusing = await realServer({ getPeerUid: unknownPeerUid });
  try { await assert.rejects(probes.ping(refusing.sock), /closed|refused/); } finally { await refusing.gw.stop(); }
  const dir = mkdtempSync(join(tmpdir(), 'gw-silent-')); const sock = join(dir, 's.sock');
  const silent = net.createServer(() => { /* accepts, never answers */ });
  await new Promise((r) => silent.listen(sock, r));
  try { await assert.rejects(probes.ping(sock), /timed out/); } finally { silent.close(); }
  // and doctor (b) reports each as a failure with real probes
  const s = setup();
  const real = { ...realProbes({ pingTimeoutMs: 300 }), readConfig: (h) => ({ valid: true, errors: [], config: { ...s.cfg, socket_path: refusing.sock }, home: h }) };
  assert.equal(byId(await run(s, real), 'b').ok, false);
});

test('real boundary probes report allowed, denied and missing honestly', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, () => {
  const p = realProbes();
  const d = mkdtempSync(join(tmpdir(), 'gw-bp-'));
  const open = join(d, 'open'); writeFileSync(open, 'x', { mode: 0o600 });
  const closed = join(d, 'closed'); writeFileSync(closed, 'x', { mode: 0o000 });
  const ro = join(d, 'ro'); mkdirSync(ro); chmodSync(ro, 0o555);
  const noList = join(d, 'nolist'); mkdirSync(noList); chmodSync(noList, 0o000);
  assert.equal(p.tryRead(open), 'allowed'); assert.equal(p.tryRead(closed), 'denied'); assert.equal(p.tryRead(join(d, 'nope')), 'missing');
  assert.equal(p.tryRead(join(noList, 'x')), 'denied');
  assert.equal(p.tryList(d), 'allowed'); assert.equal(p.tryList(noList), 'denied'); assert.equal(p.tryList(join(d, 'nope')), 'missing');
  assert.equal(p.tryCreate(d), 'allowed'); assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('.doctor-probe')), [], 'the probe file is removed');
  assert.equal(p.tryCreate(ro), 'denied'); assert.equal(p.tryCreate(noList), 'denied'); assert.equal(p.tryCreate(join(d, 'nope')), 'missing');
  chmodSync(noList, 0o700); chmodSync(ro, 0o755);
});

test('real processInfo, group lookup and TCP listener inspection', async () => {
  const me = processInfo(process.pid);
  assert.equal(me.pid, process.pid); assert.equal(me.uid, process.getuid()); assert.match(me.cmdline, /node/);
  assert.equal(processInfo(2 ** 22 + 12345), null); assert.equal(processInfo(-1), null); assert.equal(processInfo('x'), null);
  assert.equal(resolveGroup(7), 7); assert.equal(resolveGroup('no-such-group-xyz'), null); assert.equal(resolveGroup('bad name'), null);
  const p = realProbes();
  assert.deepEqual(await p.tcpListeners(me, { gatewayUid: process.getuid() }), [], 'no TCP listener yet');
  const tcp = net.createServer(); await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  try { const l = await p.tcpListeners(me, { gatewayUid: process.getuid() }); assert.ok(Array.isArray(l) && l.length >= 1, `listener seen: ${JSON.stringify(l)}`); } finally { tcp.close(); }
  assert.equal(await p.tcpListeners(null, {}), null);
});

test('real probes: the checksum is stable over the real locked set and changes with its content', () => {
  const a = lockedChecksum(REPO_ROOT); const b = realProbes().lockedChecksum();
  assert.equal(a.sha256, b.sha256); assert.match(a.sha256, /^[0-9a-f]{64}$/); assert.ok(a.files > 5);
  assert.throws(() => lockedChecksum(mkdtempSync(join(tmpdir(), 'gw-nolock-'))));
});

test('real probes: stat reports type, owner and mode; readPid tolerates junk', () => {
  const p = realProbes();
  const f = join(mkdtempSync(join(tmpdir(), 'gw-rp-')), 'x'); writeFileSync(f, 'x', { mode: 0o600 });
  const st = p.stat(f); assert.equal(st.ok, true); assert.equal(st.mode, 0o600); assert.equal(st.type, 'file'); assert.equal(st.uid, process.getuid());
  assert.deepEqual(p.stat(f + 'nope'), { ok: false, code: 'ENOENT' });
  assert.equal(p.readPid(f), null); assert.equal(p.readPid(f + 'nope'), null);
  assert.equal(existsSync(f), true);
});
