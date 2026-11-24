import { join, dirname, resolve } from 'node:path';
import { agentHome } from './config.js';
import { loadGatewayPrices, checkPriceTable } from './prices.js';
import { DEFAULT_PRICE_FILE } from '../grant/index.js';
import { homeProblems, configFileProblems, socketDirProblems, socketProblems } from './layout.js';
import { isGatewayCmdline } from './sys.js';

const pass = (id, name, why) => ({ id, name, ok: true, why, fix: null });
const fail = (id, name, why, fix) => ({ id, name, ok: false, why, fix });
const CHECK_NAMES = { b: 'gateway answers ping', c: 'socket owner, group and mode', d: 'boundary probes denied', f: 'no TCP listener' };
const one = (s) => String(s).replace(/\s+/g, ' ').slice(0, 220);
const isInt = (n) => Number.isSafeInteger(n) && n >= 0;
const isStr = (s) => typeof s === 'string' && s.length > 0 && s.length < 1024;

/** A reply to `ping` is well formed only if it is ok:true with a version, an uptime and a pid. A refused or silent server never gets this far. */
export const wellFormedPing = (r) => !!r && r.ok === true && !!r.result && typeof r.result.version === 'string' && isInt(r.result.uptime_ms) && Number.isSafeInteger(r.result.pid) && r.result.pid > 0;

function describedConfig(layout, home) {
  const l = layout;
  if (!l || typeof l !== 'object' || l.home !== home) return null;
  for (const k of ['socket_dir', 'socket_path', 'credentials_file', 'ledger_dir', 'runs_dir', 'pid_file']) if (!isStr(l[k])) return null;
  if (!isInt(l.gateway_uid) || !(isInt(l.runner_group) || isStr(l.runner_group))) return null;
  return { home, socket_dir: l.socket_dir, socket_path: l.socket_path, credentials_file: l.credentials_file, ledger_dir: l.ledger_dir, runs_dir: l.runs_dir, pid_file: l.pid_file, runner_group: l.runner_group, runner_gid: isInt(l.runner_gid) ? l.runner_gid : null, identities: { gateway_uid: l.gateway_uid } };
}

/**
 * agent doctor. Every check returns { id, name, ok, why (one line), fix (exact remediation, or null when ok) }.
 * All system access goes through `probes` so tests use fakes; a probe that throws or answers "unknown" is a failure (fail closed).
 * Run it as the RUNNER user: the boundary probes (d) are only meaningful as the identity that must be kept out.
 * When config.json itself is unreadable by this identity (which is what the boundary demands of the runner), the layout is taken
 * from the running gateway's own `ping` answer, and NOTHING in this identity's environment is trusted for who the gateway is:
 * `socketPath` (the AGENT_GATEWAY_SOCKET variable) is only a location hint. The trust anchor is `gatewayUser`, a name the human
 * types on the command line (--gateway-user). The socket, its directory and the discovery file must be owned by that user's uid,
 * the directory must not be writable by this identity, and the ping's instance_id must equal the discovery file's. Without it
 * the trust checks are refused. A run with a readable config.json (the gateway user's own) proves nothing about the runner boundary.
 * Returns { ok, checks, partial, notes }; `partial` is { run, of } when --only left checks out, else null.
 */
export async function runDoctor({ home = agentHome(), probes, priceFile = DEFAULT_PRICE_FILE, socketPath, only, gatewayUser } = {}) {
  const checks = [];
  const safe = async (id, name, fn, fixOnError) => {
    try { checks.push(await fn()); } catch { checks.push(fail(id, name, 'check could not run (probe error)', fixOnError)); }
  };

  // The handshake runs at most once; (a) may need it to learn the layout and (b), (e), (f) reuse it.
  let pinged = null;
  const ping = async (path) => {
    if (!pinged) { try { const r = await probes.ping(path); pinged = wellFormedPing(r) ? { ok: true, reply: r.result } : { ok: false, why: 'the gateway answered, but not with a well-formed ping reply' }; } catch { pinged = { ok: false, why: 'the gateway refused the connection, closed it or did not answer' }; } }
    return pinged;
  };

  let loaded; try { loaded = probes.readConfig(home); } catch { loaded = { valid: false, errors: ['config probe error'] }; }
  let cfg = loaded.valid ? loaded.config : null; let described = false; let aFail = null; let anchorUid = null;
  const notes = [];
  if (cfg) notes.push('config.json is readable by this identity, so this run is the gateway side looking at itself: it proves nothing about the runner boundary. The proof is a human running `agent doctor --gateway-user <name>` as the runner (docs/gateway.md).');
  if (!cfg) {
    if (loaded.denied && !gatewayUser) aFail = 'config.json is not readable by this user (expected for the runner), so the trust checks are refused: say who the gateway is with --gateway-user <name>';
    else if (loaded.denied && !socketPath) aFail = 'config.json is not readable by this user (expected for the runner) and AGENT_GATEWAY_SOCKET (the location hint) is not set';
    else if (loaded.denied) {
      try { anchorUid = probes.resolveUser(gatewayUser); } catch { anchorUid = null; }
      if (!isInt(anchorUid)) aFail = `--gateway-user ${one(gatewayUser).slice(0, 40)} does not resolve to a user on this machine`;
      else {
        const p = await ping(socketPath);
        cfg = p.ok ? describedConfig(p.reply.layout, home) : null;
        if (cfg) cfg = { ...cfg, identities: { gateway_uid: anchorUid } }; // the human-supplied identity, never the one the socket claims
        described = !!cfg;
        if (!cfg) aFail = p.ok ? 'config.json is not readable here and the gateway did not describe its layout' : `config.json is not readable here and the gateway did not answer (${p.why})`;
      }
    } else aFail = loaded.errors[0];
  }
  const aFix = loaded.denied ? 'run `agent doctor --gateway-user <name>` with AGENT_GATEWAY_SOCKET=<socket_dir>/gateway.sock as a location hint (docs/gateway.md), and start the gateway' : 'run `agent init` to create a config, or fix config.json by hand (see docs/gateway.md); unknown keys and versions are refused';
  const gw = cfg?.identities.gateway_uid;
  let gid = null;
  if (cfg) { try { gid = probes.resolveGroup(cfg.runner_group); } catch { gid = null; } if (gid === null || gid === undefined) gid = cfg.runner_gid ?? null; }
  const cfgFile = join(home, 'config.json');

  // (a) config valid, and the owners and modes of config.json, AGENT_HOME and socket_dir
  if (!cfg) checks.push(fail('a', 'config valid, owners and modes', one(aFail), aFix));
  else await safe('a', 'config valid, owners and modes', async () => {
    const probs = [
      ...homeProblems(probes.stat(home), home, gw, { deniedOk: true }),
      ...configFileProblems(probes.stat(cfgFile), cfgFile, gw, { deniedOk: true }),
      ...socketDirProblems(probes.stat(cfg.socket_dir), cfg.socket_dir, gw, gid),
    ];
    if (probs.length) return fail('a', 'config valid, owners and modes', one(probs[0].why) + (probs.length > 1 ? ` (+${probs.length - 1} more)` : ''), probs[0].fix);
    return pass('a', 'config valid, owners and modes', described ? 'config.json is unreadable here (expected); the running gateway validated it, and AGENT_HOME and socket_dir are owned and moded as required' : 'config valid; AGENT_HOME 700, config.json not group/other writable, socket_dir 750, all owned correctly');
  }, 'check ownership and modes of AGENT_HOME, config.json and socket_dir by hand (ls -ld)');

  // Trust anchor (only when config.json is unreadable): everything is checked against the human-supplied gateway user, never against the environment.
  let trustMemo = null;
  const trust = (c) => {
    if (trustMemo) return trustMemo;
    const why = [];
    const hint = resolve(socketPath);
    const owner = (st, what) => { if (!st.ok) why.push(`${what} cannot be inspected (${st.code})`); else if (st.uid !== anchorUid) why.push(`${what} is owned by uid ${st.uid}, not ${one(gatewayUser).slice(0, 40)} (uid ${anchorUid})`); };
    const me = probes.uid();
    if (me === 0 || me === anchorUid) why.push(`doctor runs as uid ${me}, which cannot prove the boundary`);
    if (c.socket_path !== hint) why.push('the gateway describes a socket path that is not the one asked for');
    if (c.socket_dir !== dirname(hint)) why.push('the described socket_dir is not the directory of the socket asked for');
    owner(probes.stat(c.socket_dir), 'socket_dir'); owner(probes.stat(c.socket_path), 'the socket');
    const dFile = join(c.socket_dir, 'gateway.json');
    owner(probes.stat(dFile), 'the discovery file (gateway.json)');
    const v = probes.tryCreate(c.socket_dir);
    if (v !== 'denied') why.push(`socket_dir is writable by this identity (${v === 'allowed' ? 'ALLOWED' : `not proven denied: ${v}`}), so anyone here could plant a socket`);
    let d = null; try { d = probes.readDiscovery(dFile); } catch { d = null; }
    if (!d) why.push('the discovery file is missing, unreadable or malformed');
    else {
      if (d.gateway_uid !== anchorUid) why.push(`the discovery file names uid ${d.gateway_uid}, not the gateway uid ${anchorUid}`);
      if (d.socket_path !== hint) why.push('the discovery file names a different socket path');
      const pi = pinged?.ok ? pinged.reply.instance_id : null;
      if (typeof pi !== 'string' || pi !== d.instance_id) why.push('the instance_id from ping does not match the discovery file (the answering process is not the one that wrote it)');
    }
    if (!pinged?.ok) why.push('the gateway did not answer a ping');
    else if (pinged.reply.layout?.gateway_uid !== anchorUid) why.push(`the gateway describes its own uid as ${pinged.reply.layout?.gateway_uid}, not ${anchorUid}`);
    trustMemo = why;
    return why;
  };
  const trustFix = 'do not trust this socket: as the real gateway user find what created it (ls -l the socket_dir), stop any impostor, restart the gateway, then re-run agent doctor --gateway-user <name>';
  const needCfg = (id, name) => fail(id, name, 'skipped: config is not valid', 'fix check (a) first');
  // b, c, d and f rest on the gateway being who it says it is; without a human-supplied anchor they cannot pass, so each is refused if the anchor does not hold.
  const anchored = (id, fn) => async (c) => {
    if (anchorUid !== null && !(id === 'b' && !pinged?.ok)) { const why = trust(c); if (why.length) return fail(id, CHECK_NAMES[id], one(`trust anchor failed: ${why.join('; ')}`), trustFix); }
    return fn(c);
  };
  const withCfg = (id, name, fn, fixOnError) => (cfg ? safe(id, name, () => anchored(id, fn)(cfg), fixOnError) : checks.push(needCfg(id, name)));

  // (b) a real handshake, not just an open socket
  await withCfg('b', 'gateway answers ping', async (c) => {
    const p = await ping(c.socket_path);
    if (!p.ok) return fail('b', 'gateway answers ping', one(p.why), `start the gateway as the gateway user (agent gateway), and make sure this user is in the runner group; socket: ${c.socket_path}`);
    return pass('b', 'gateway answers ping', `gateway ${p.reply.version}, up ${p.reply.uptime_ms} ms, access: ${one(p.reply.access ?? 'unreported')}`);
  }, 'start the gateway: agent gateway');

  // (c) the socket itself
  await withCfg('c', 'socket owner, group and mode', async (c) => {
    const probs = socketProblems(probes.stat(c.socket_path), c.socket_path, gw, gid);
    if (probs.length) return fail('c', 'socket owner, group and mode', one(probs[0].why), probs[0].fix);
    return pass('c', 'socket owner, group and mode', 'socket is 660, owned by the gateway user, group is the runner group');
  }, 'check the socket by hand: ls -l on the socket path');

  // (d) boundary probes, run as the identity running doctor
  await withCfg('d', 'boundary probes denied', async (c) => {
    const me = probes.uid();
    if (me === gw || me === 0) return fail('d', 'boundary probes denied', `doctor is running as uid ${me} (${me === 0 ? 'root, which ignores file permissions' : 'the gateway identity'}); these probes proved nothing`, 'run doctor as the runner user');
    const attempts = [
      ['read the credential file', () => probes.tryRead(c.credentials_file)],
      ['list the ledger directory', () => probes.tryList(c.ledger_dir)],
      ['read config.json', () => probes.tryRead(cfgFile)],
      ['create a file in AGENT_HOME', () => probes.tryCreate(home)],
      ['create a file in socket_dir', () => probes.tryCreate(c.socket_dir)],
    ];
    const bad = [];
    for (const [what, run] of attempts) { const v = run(); if (v !== 'denied') bad.push(`${what} was ${v === 'allowed' ? 'ALLOWED' : `not proven denied (${v})`}`); }
    if (bad.length) return fail('d', 'boundary probes denied', one(bad.join('; ')), 'as the gateway user fix modes and owners so this user is refused: chmod 700 AGENT_HOME, chmod 600 credentials.json, chmod 750 socket_dir (group read and traverse only); remove this user from the gateway group');
    return pass('d', 'boundary probes denied', `as uid ${me}: credential file, ledger, config.json and both directories refused every attempt`);
  }, 'run the probes by hand as the runner user (cat the credential file, ls the ledger, touch a file in AGENT_HOME)');

  // (e) peer-uid probe if one is in use, otherwise kernel permissions only
  await withCfg('e', 'peer-uid probe or kernel permissions only', async () => {
    const reported = pinged?.ok ? String(pinged.reply.access ?? '') : '';
    const probeInUse = reported.includes('peer-uid-probe') || typeof probes.peerDecision === 'function';
    if (probeInUse) {
      if (typeof probes.peerDecision !== 'function') return fail('e', 'peer-uid probe or kernel permissions only', 'the gateway uses a peer-uid probe that doctor cannot exercise', 'provide the probe to doctor, or run the gateway without one (kernel permissions only)');
      const d = await probes.peerDecision();
      if (d?.runnerAdmitted === true && d?.otherAdmitted === false) return pass('e', 'peer-uid probe or kernel permissions only', 'the real probe admits the runner uid and refuses another uid');
      return fail('e', 'peer-uid probe or kernel permissions only', one(`the probe admitted ${JSON.stringify(d)?.slice(0, 80)}; it must admit the runner and refuse others`), 'fix the probe or allowed_peer_uids; unknown answers must refuse');
    }
    const earlier = checks.filter((k) => ['a', 'b', 'c', 'd'].includes(k.id));
    if (earlier.length === 4 && earlier.every((k) => k.ok)) return pass('e', 'peer-uid probe or kernel permissions only', 'kernel permissions only (no peer-uid probe); access rests on checks a, b, c and d, which passed');
    return fail('e', 'peer-uid probe or kernel permissions only', 'kernel permissions only, and checks a to d did not all pass', 'fix the failing checks among a, b, c and d first');
  }, 'check the access mode by hand');

  // (f) no TCP listener, without trusting the pid file
  await withCfg('f', 'no TCP listener', async (c) => {
    const answering = pinged?.ok ? pinged.reply.pid : null;
    const filePid = probes.readPid(c.pid_file);
    const pid = answering ?? filePid;
    if (!pid) return fail('f', 'no TCP listener', 'gateway pid is unknown (the gateway did not answer and the pid file is unreadable)', 'start the gateway; if doctor runs as the runner it learns the pid from ping');
    if (answering && filePid && answering !== filePid) return fail('f', 'no TCP listener', `pid file says ${filePid} but the gateway answering on the socket is ${answering}`, 'stop every gateway, remove the stale pid file and start one gateway');
    const info = probes.processInfo(pid);
    if (!info) return fail('f', 'no TCP listener', `pid ${pid} is not running or cannot be inspected`, 'start the gateway as the gateway user');
    if (!isGatewayCmdline(info.cmdline)) return fail('f', 'no TCP listener', `pid ${pid} is not the gateway (its command line is not "agent gateway")`, 'stop whatever holds that pid and start the gateway with: agent gateway');
    if (Number.isSafeInteger(info.uid) && info.uid !== gw) return fail('f', 'no TCP listener', `pid ${pid} runs as uid ${info.uid}, not the gateway uid ${gw}`, 'start the gateway under the gateway user');
    const l = await probes.tcpListeners(info, { gatewayUid: gw });
    if (l === null || l === undefined) return fail('f', 'no TCP listener', 'cannot inspect the gateway process\'s sockets as this user', 'on Linux read /proc needs no help; on macOS run only this check as root: sudo agent doctor --only f');
    if (l.length) return fail('f', 'no TCP listener', `gateway listens on TCP: ${l.join(', ').slice(0, 100)}`, 'stop the gateway; it must listen only on its Unix socket');
    return pass('f', 'no TCP listener', `verified pid ${pid} is the gateway; it has no TCP listening socket`);
  }, 'check listeners by hand (lsof -nP -iTCP -sTCP:LISTEN, or ss -ltnp)');

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

  const shown = only ? checks.filter((c) => only.includes(c.id)) : checks;
  return { ok: shown.length > 0 && shown.every((c) => c.ok), checks: shown, partial: shown.length < checks.length ? { run: shown.length, of: checks.length } : null, notes };
}

export function formatDoctor({ ok, checks, partial = null, notes = [] }) {
  const lines = checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} (${c.id}) ${c.name}: ${c.why}${c.ok ? '' : `\n       fix: ${c.fix}`}`);
  for (const n of notes) lines.push('', `NOTE: ${n}`);
  const failedN = checks.filter((c) => !c.ok).length;
  lines.push('', partial ? `doctor: PARTIAL: ${partial.run} of ${partial.of} checks run${failedN ? `; ${failedN} FAILED` : '; the ones run passed, which is NOT a full pass'}` : ok ? 'doctor: all checks passed' : `doctor: ${failedN} check(s) FAILED`);
  return lines.join('\n');
}
