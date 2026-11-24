import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatDoctor } from '../src/gateway/doctor.js';
import { realProbes, modeAllowsRead, lockedChecksum } from '../src/gateway/probes.js';
import { peerAllowed } from '../src/gateway/server.js';
import { checkPriceTable } from '../src/gateway/prices.js';
import { parsePriceTable } from '../src/grant/index.js';
import { tempHome } from './gateway-helpers.js';
import { REPO_ROOT } from '../src/self-model.js';

const GW = 1001; const RUNNER = 2002;
function setup(over = {}) {
  const t = tempHome({ allowed: [RUNNER] });
  const raw = { ...t.raw, identities: { gateway_uid: GW, runner_uid: RUNNER }, allowed_peer_uids: [RUNNER], ...over };
  writeFileSync(join(t.home, 'config.json'), JSON.stringify(raw));
  return t;
}
/** A probe set where everything is healthy. Each test breaks exactly one thing. */
const healthy = (t, o = {}) => ({
  connect: async () => true,
  stat: (p) => (p.endsWith('.sock') ? { mode: 0o600, uid: GW, gid: 0, isSocket: true } : { mode: 0o600, uid: GW, gid: 0, isSocket: false }),
  canRead: () => false,
  peerAllowed,
  readPid: () => 4321,
  tcpListeners: async () => [],
  lockedChecksum: () => ({ sha256: 'ab'.repeat(32), files: 3 }),
  ...o,
});
const priceFile = (models) => { const f = join(mkdtempSync(join(tmpdir(), 'gw-pf-')), 'p.json'); writeFileSync(f, JSON.stringify({ schema_version: '1', models })); return f; };
const run = (t, probes, extra = {}) => runDoctor({ home: t.home, probes, ...extra });
const byId = (r, id) => r.checks.find((c) => c.id === id);

test('healthy fakes: all eight checks pass, each with a reason, and the checksum is printed', async () => {
  const t = setup();
  const r = await run(t, healthy(t));
  assert.equal(r.ok, true, formatDoctor(r));
  assert.deepEqual(r.checks.map((c) => c.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  for (const c of r.checks) { assert.equal(typeof c.why, 'string'); assert.ok(c.why.length > 0 && !c.why.includes('\n')); assert.equal(c.fix, null); }
  assert.match(formatDoctor(r), /sha256 (ab){32}/);
});

const breaks = {
  a: { name: 'config invalid', make: (t) => { writeFileSync(join(t.home, 'config.json'), JSON.stringify({ config_version: 9 })); return healthy(t); } },
  b: { name: 'gateway unreachable', make: (t) => healthy(t, { connect: async () => false }) },
  c1: { id: 'c', name: 'socket mode 0660', make: (t) => healthy(t, { stat: (p) => ({ mode: p.endsWith('.sock') ? 0o660 : 0o600, uid: GW, isSocket: p.endsWith('.sock') }) }) },
  c2: { id: 'c', name: 'socket owned by someone else', make: (t) => healthy(t, { stat: (p) => ({ mode: 0o600, uid: RUNNER, isSocket: p.endsWith('.sock') }) }) },
  c3: { id: 'c', name: 'socket missing', make: (t) => healthy(t, { stat: (p) => (p.endsWith('.sock') ? null : { mode: 0o600, uid: GW }) }) },
  d1: { id: 'd', name: 'runner can read credentials', make: (t) => healthy(t, { canRead: (p) => p.endsWith('credentials.json') }) },
  d2: { id: 'd', name: 'runner can read ledger', make: (t) => healthy(t, { canRead: (p) => p.endsWith('ledger') }) },
  d3: { id: 'd', name: 'credential file missing', make: (t) => healthy(t, { stat: (p) => (p.endsWith('credentials.json') ? null : { mode: 0o600, uid: GW, isSocket: p.endsWith('.sock') }) }) },
  e: { name: 'runner still admitted after removal', make: (t) => healthy(t, { peerAllowed: () => true }) },
  f1: { id: 'f', name: 'TCP listener present', make: (t) => healthy(t, { tcpListeners: async () => ['*:8080'] }) },
  f2: { id: 'f', name: 'listeners unknown', make: (t) => healthy(t, { tcpListeners: async () => null }) },
  f3: { id: 'f', name: 'no pid', make: (t) => healthy(t, { readPid: () => null }) },
  h: { name: 'checksum probe throws', make: (t) => healthy(t, { lockedChecksum: () => { throw new Error('no list'); } }) },
};
for (const [key, b] of Object.entries(breaks)) {
  test(`doctor check (${b.id ?? key}) fails under a fake that breaks it: ${b.name}`, async () => {
    const t = setup();
    const r = await run(t, b.make(t));
    const c = byId(r, b.id ?? key);
    assert.equal(c.ok, false, formatDoctor(r));
    assert.ok(c.why.length > 0 && c.fix && c.fix.length > 10, 'one-line reason and exact remediation');
    assert.equal(r.ok, false, 'any failure fails the whole doctor');
  });
}

test('doctor check (g) fails for a bare-model key, a missing price, or an unreadable file; passes when empty or fully priced', async () => {
  const t = setup();
  const p = healthy(t);
  assert.equal(byId(await run(t, p, { priceFile: priceFile({}) }), 'g').ok, true);
  assert.equal(byId(await run(t, p, { priceFile: priceFile({ 'prov|m': { input_micro_per_mtok: 1, output_micro_per_mtok: 2 } }) }), 'g').ok, true);
  assert.equal(byId(await run(t, p, { priceFile: priceFile({ 'prov|m': { input_micro_per_mtok: 1 } }) }), 'g').ok, false);
  assert.equal(byId(await run(t, p, { priceFile: priceFile({ 'bare-model': { input_micro_per_mtok: 1, output_micro_per_mtok: 2 } }) }), 'g').ok, false);
  assert.equal(byId(await run(t, p, { priceFile: join(tmpdir(), 'does-not-exist-xyz.json') }), 'g').ok, false);
  assert.equal(checkPriceTable(null).ok, false);
  assert.equal(checkPriceTable(parsePriceTable({ schema_version: '1', models: {} })).ok, true);
});

test('with an invalid config every config-dependent check fails (skipped checks are failures)', async () => {
  const t = setup();
  writeFileSync(join(t.home, 'config.json'), '{"config_version":1,"bogus":true}');
  const r = await run(t, healthy(t));
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('a probe that throws is a failure, never a pass', async () => {
  const t = setup();
  const boom = () => { throw new Error('probe exploded'); };
  const r = await run(t, healthy(t, { connect: boom, stat: boom, peerAllowed: boom, readPid: boom, tcpListeners: boom }));
  for (const id of ['b', 'c', 'd', 'e', 'f']) assert.equal(byId(r, id).ok, false, id);
});

test('modeAllowsRead: owner, group/other bits, root', () => {
  assert.equal(modeAllowsRead({ uid: 5, mode: 0o600 }, 5), true);
  assert.equal(modeAllowsRead({ uid: 5, mode: 0o600 }, 6), false);
  assert.equal(modeAllowsRead({ uid: 5, mode: 0o640 }, 6), true);
  assert.equal(modeAllowsRead({ uid: 5, mode: 0o604 }, 6), true);
  assert.equal(modeAllowsRead({ uid: 5, mode: 0o000 }, 0), true);
});

test('real probes: the checksum is stable over the real locked set and changes with its content', () => {
  const a = lockedChecksum(REPO_ROOT); const b = realProbes().lockedChecksum();
  assert.equal(a.sha256, b.sha256); assert.match(a.sha256, /^[0-9a-f]{64}$/); assert.ok(a.files > 5);
  assert.throws(() => lockedChecksum(mkdtempSync(join(tmpdir(), 'gw-nolock-'))));
});

test('real probes: stat/canRead on a real temp file and connect to a dead socket', async () => {
  const p = realProbes();
  const f = join(mkdtempSync(join(tmpdir(), 'gw-rp-')), 'x'); writeFileSync(f, 'x', { mode: 0o600 });
  assert.equal(p.stat(f).mode, 0o600); assert.equal(p.stat(f + 'nope'), null);
  assert.equal(p.canRead(f, process.getuid()), true);
  assert.equal(p.canRead(f + 'nope', 1), false);
  assert.equal(await p.connect(f + '.sock'), false);
  assert.equal(p.readPid(f), null);
});
