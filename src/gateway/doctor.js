import { loadConfig, agentHome } from './config.js';
import { loadGatewayPrices, checkPriceTable } from './prices.js';
import { DEFAULT_PRICE_FILE } from '../grant/index.js';

const pass = (id, name, why) => ({ id, name, ok: true, why, fix: null });
const fail = (id, name, why, fix) => ({ id, name, ok: false, why, fix });

/**
 * agent doctor. Every check returns { id, name, ok, why (one line), fix (exact remediation, or null when ok) }.
 * All system access goes through `probes` (stat, canRead, connect, peerAllowed, readPid, tcpListeners, lockedChecksum) so tests
 * use fakes. A probe that throws or answers "unknown" is a failure (fail closed). Returns { ok, checks }.
 */
export async function runDoctor({ home = agentHome(), probes, priceFile = DEFAULT_PRICE_FILE } = {}) {
  const checks = [];
  const safe = async (id, name, fn, fixOnError) => {
    try { checks.push(await fn()); } catch { checks.push(fail(id, name, 'check could not run (probe error)', fixOnError)); }
  };

  const loaded = loadConfig(home);
  const cfg = loaded.config;
  checks.push(loaded.valid
    ? pass('a', 'config valid', `config_version 1 under ${home}`)
    : fail('a', 'config valid', loaded.errors[0], 'run `agent init` to create a config, or fix config.json by hand (see docs/gateway.md); unknown keys and versions are refused'));

  const needCfg = (id, name) => fail(id, name, 'skipped: config is not valid', 'fix check (a) first');
  const withCfg = (id, name, fn, fixOnError) => (cfg ? safe(id, name, () => fn(cfg), fixOnError) : checks.push(needCfg(id, name)));

  await withCfg('b', 'gateway reachable', async (c) => {
    const ok = await probes.connect(c.socket_path);
    return ok ? pass('b', 'gateway reachable', 'connected to the gateway socket') : fail('b', 'gateway reachable', 'cannot connect to the gateway socket', `start it as the gateway user: agent gateway   (socket: ${c.socket_path})`);
  }, 'start the gateway: agent gateway');

  await withCfg('c', 'socket mode and owner', async (c) => {
    const st = probes.stat(c.socket_path);
    if (!st) return fail('c', 'socket mode and owner', 'socket does not exist', 'start the gateway: agent gateway');
    if (!st.isSocket) return fail('c', 'socket mode and owner', 'path is not a socket', `remove ${c.socket_path} and restart the gateway`);
    if ((st.mode & 0o777) !== 0o600) return fail('c', 'socket mode and owner', `socket mode is ${(st.mode & 0o777).toString(8).padStart(3, '0')}, must be 600`, `chmod 600 ${c.socket_path}  (run as the gateway user)`);
    if (st.uid !== c.identities.gateway_uid) return fail('c', 'socket mode and owner', `socket owner uid is ${st.uid}, gateway uid is ${c.identities.gateway_uid}`, `the gateway must run as uid ${c.identities.gateway_uid}; restart it under that user`);
    return pass('c', 'socket mode and owner', 'socket is 0600 and owned by the gateway identity');
  }, 'check the socket by hand: ls -l on the socket path');

  await withCfg('d', 'credential and ledger unreadable by runner', async (c) => {
    const files = [c.credentials_file, c.ledger_dir];
    const bad = [];
    for (const f of files) {
      const st = probes.stat(f);
      if (st === null) { bad.push(`${f} (missing)`); continue; }
      if (probes.canRead(f, c.identities.runner_uid)) bad.push(f);
    }
    if (bad.length) return fail('d', 'credential and ledger unreadable by runner', `runner uid ${c.identities.runner_uid} can read, or cannot verify: ${bad.join(', ').slice(0, 160)}`, 'as the gateway user: chmod 600 the credentials file and chmod 700 the ledger directory, owned by the gateway user and not by the runner');
    return pass('d', 'credential and ledger unreadable by runner', 'runner identity cannot read the credential file or the ledger directory');
  }, 'check ownership and modes of the credential file and ledger directory by hand');

  await withCfg('e', 'runner refused once its allowlist entry is removed', async (c) => {
    const without = c.allowed_peer_uids.filter((u) => u !== c.identities.runner_uid);
    const stillAllowed = probes.peerAllowed(without, c.identities.runner_uid);
    const baseline = probes.peerAllowed(c.allowed_peer_uids, c.identities.runner_uid);
    if (stillAllowed) return fail('e', 'runner refused once its allowlist entry is removed', 'runner would still be admitted with its allowlist entry removed', 'the peer check must be exact-uid only; do not use wildcard or group rules');
    return pass('e', 'runner refused once its allowlist entry is removed', baseline ? 'simulated: runner is admitted only while listed in allowed_peer_uids' : 'simulated: runner is refused (it is not currently listed)');
  }, 'check allowed_peer_uids in config.json');

  await withCfg('f', 'no TCP listener', async (c) => {
    const pid = probes.readPid(c.pid_file);
    if (!pid) return fail('f', 'no TCP listener', 'gateway pid is unknown (no pid file)', 'start the gateway so it writes its pid file');
    const l = await probes.tcpListeners(pid);
    if (l === null || l === undefined) return fail('f', 'no TCP listener', 'cannot determine the gateway TCP listeners', 'install lsof (or run on Linux with /proc) so the check can run');
    if (l.length) return fail('f', 'no TCP listener', `gateway listens on TCP: ${l.join(', ').slice(0, 100)}`, 'stop the gateway; M1a must listen only on its Unix socket');
    return pass('f', 'no TCP listener', 'gateway process has no TCP listening socket');
  }, 'check listeners by hand (lsof -nP -iTCP -sTCP:LISTEN)');

  await safe('g', 'price table', async () => {
    const { table, error } = loadGatewayPrices(priceFile);
    if (!table) return fail('g', 'price table', `price table is unusable: ${error}`, 'every entry in the tracked price file needs integer input and output prices; fix it by hand (it is a locked file)');
    const r = checkPriceTable(table);
    return r.ok ? pass('g', 'price table', r.why) : fail('g', 'price table', r.why, 'fix the tracked price file by hand (it is a locked file)');
  }, 'check the tracked price file by hand');

  await safe('h', 'locked-set checksum', async () => {
    const r = probes.lockedChecksum();
    return pass('h', 'locked-set checksum', `sha256 ${r.sha256} over ${r.files} locked files (compare with the value you recorded when you locked it)`);
  }, 'make sure .github/locked-paths.txt exists in the repository');

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatDoctor({ ok, checks }) {
  const lines = checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} (${c.id}) ${c.name}: ${c.why}${c.ok ? '' : `\n       fix: ${c.fix}`}`);
  lines.push('', ok ? 'doctor: all checks passed' : `doctor: ${checks.filter((c) => !c.ok).length} check(s) FAILED`);
  return lines.join('\n');
}
