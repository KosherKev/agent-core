import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { agentHome, loadConfig } from './config.js';
import { runInit } from './init.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { realProbes } from './probes.js';
import { createFileLedgerStore } from './store.js';
import { createRunStore } from './runs.js';
import { loadCredentials } from './credentials.js';
import { createGatewayApi, NOT_IMPLEMENTED } from './api.js';
import { createGatewayServer } from './server.js';
import { resolveGroup } from './sys.js';
import { checkRealLayout } from './layout.js';
import { loadGatewayPrices } from './prices.js';
import { createSpendSink } from '../grant/index.js';
import { buildReport } from '../ledger/index.js';
import { request } from './client.js';
import { DEFAULT_PRICE_FILE } from '../grant/index.js';
import { makeRedactor } from './credentials.js';

export const USAGE = `usage: agent <command>
  init           create AGENT_HOME, config.json and directories (never overwrites)
  doctor         run the boundary checks as the runner user (exit 1 if any fails)
                 --gateway-user <name>  who the gateway is; REQUIRED when config.json is unreadable by you (the normal runner case)
                 AGENT_GATEWAY_SOCKET=<socket_dir>/gateway.sock is only a location hint, never trusted
                 --only a,b,f  runs part of the checks: prints PARTIAL and is never a full pass
  status         show config, gateway reachability and ledger totals
  ledger:report  print the per-grant ledger report
  gateway        run the gateway (as the gateway user)
  run, upgrade   not implemented in M1a (run is gated by doctor)`;

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, NOT_IMPLEMENTED: 2, USAGE: 64 });

/**
 * Start the gateway process from config. deps are injectable for tests: { getPeerUid, transport, priceFile, now }.
 * Fails closed: a bad config, credential file or ledger directory throws before anything listens.
 */
export async function startGateway({ home = agentHome(), getPeerUid, serverOpts = {}, transport, priceFile = DEFAULT_PRICE_FILE, now = Date.now, log = () => {} } = {}) {
  const loaded = loadConfig(home);
  if (!loaded.valid) throw new Error(`config invalid: ${loaded.errors[0]}`);
  const config = loaded.config;
  const early = await (serverOpts.checkLayout ?? checkRealLayout)(config, { gid: (serverOpts.group ?? resolveGroup)(config.runner_group) });
  if (early.length) throw new Error(`layout refused, not starting: ${early.join('; ').slice(0, 400)}`); // before anything is created under AGENT_HOME
  const credentials = loadCredentials(config.credentials_file);
  const redact = makeRedactor(credentials.secrets());
  const { table, error } = loadGatewayPrices(priceFile);
  if (!table) throw new Error(`price table unusable: ${error}`);
  const store = createFileLedgerStore(config.ledger_dir, { now });
  const runs = createRunStore(config.runs_dir, { now });
  const runnerGid = resolveGroup(config.runner_group);
  const access = getPeerUid ? 'kernel-permissions+peer-uid-probe' : 'kernel-permissions-only (no peer-uid probe configured)';
  const layoutInfo = () => ({ config_version: config.config_version, home: config.home, socket_dir: config.socket_dir, socket_path: config.socket_path, credentials_file: config.credentials_file, ledger_dir: config.ledger_dir, runs_dir: config.runs_dir, pid_file: config.pid_file, gateway_uid: config.identities.gateway_uid, runner_group: config.runner_group, runner_gid: runnerGid });
  const instanceId = randomBytes(16).toString('hex');
  const api = createGatewayApi({ config, store, runs, credentials, priceTable: table, now, transport, access, layoutInfo, instanceId, log: (l) => log(redact(l)), makeSink: (runId) => createSpendSink(join(config.runs_dir, `${runId.replace(/:/g, '_')}.spend.jsonl`), redact) });
  const gw = createGatewayServer({ api, config, getPeerUid, log: (l) => log(redact(l)), ...serverOpts });
  await gw.start();
  return { gw, api, config };
}

/**
 * The CLI. `io` is { out(line), err(line) }; `deps` carries injectable probes and the doctor runner so tests never touch the system.
 * Returns the process exit code.
 */
export async function main(argv, { env = process.env, io = { out: console.log, err: console.error }, deps = {} } = {}) {
  const [cmd] = argv;
  const home = agentHome(env);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : String(argv[i + 1] ?? ''); };
  const gwUserArg = flag('--gateway-user');
  const doctorFor = (only) => (deps.doctor ?? (() => runDoctor({ home, probes: deps.probes ?? realProbes(), socketPath: env.AGENT_GATEWAY_SOCKET, only, gatewayUser: gwUserArg })))({ only, gatewayUser: gwUserArg });
  const doctor = () => doctorFor(undefined);
  try {
    switch (cmd) {
      case 'init': {
        const r = runInit({ home, ...(deps.init ?? {}) });
        r.made.forEach((p) => io.out(`created ${p}`)); r.kept.forEach((p) => io.out(`kept    ${p} (exists, not changed)`));
        return EXIT.OK;
      }
      case 'doctor': {
        if (gwUserArg !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(gwUserArg)) { io.err('agent doctor: --gateway-user takes a user name'); return EXIT.USAGE; }
        const i = argv.indexOf('--only');
        const only = i >= 0 ? String(argv[i + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : undefined;
        if (i >= 0 && (!only.length || only.some((x) => !/^[a-h]$/.test(x)))) { io.err('agent doctor: --only takes a comma list of check ids a to h'); return EXIT.USAGE; }
        const r = await doctorFor(only); io.out(formatDoctor(r)); return r.ok ? EXIT.OK : EXIT.FAILED;
      }
      case 'status': {
        const loaded = loadConfig(home);
        if (!loaded.valid) { io.out(`config: INVALID (${loaded.errors[0]})`); return EXIT.FAILED; }
        const c = loaded.config;
        let pong = null;
        try { const r = await (deps.ping ?? ((sp) => request(sp, 'ping', {}, { timeoutMs: 3000 })))(c.socket_path); pong = r?.ok === true ? r.result : null; } catch { pong = null; }
        const up = pong !== null;
        io.out(`home:    ${home}\nconfig:  valid (version ${c.config_version})\ngateway: ${up ? `reachable, ${pong.version}, up ${pong.uptime_ms} ms` : 'NOT reachable'} (${c.socket_path})\naccess:  ${up ? pong.access : 'unknown (gateway not reachable)'}`);
        io.out(buildReport(c.ledger_dir).lines.join('\n'));
        return up ? EXIT.OK : EXIT.FAILED;
      }
      case 'ledger:report': {
        const loaded = loadConfig(home);
        if (!loaded.valid) { io.err(`ledger:report: config invalid: ${loaded.errors[0]}`); return EXIT.FAILED; }
        const { lines, failed } = buildReport(loaded.config.ledger_dir);
        io.out(lines.join('\n'));
        if (failed) { io.err('ledger:report: one or more ledgers failed verification'); return EXIT.FAILED; }
        return EXIT.OK;
      }
      case 'run': {
        // No flag, argument or environment variable skips this. A failing doctor blocks every run.
        const r = await doctor();
        if (!r.ok || r.partial) { io.err(formatDoctor(r)); io.err('agent run: refused because doctor failed'); return EXIT.FAILED; }
        io.err(`agent run: ${NOT_IMPLEMENTED}`);
        return EXIT.NOT_IMPLEMENTED;
      }
      case 'upgrade': io.err(`agent upgrade: ${NOT_IMPLEMENTED}`); return EXIT.NOT_IMPLEMENTED;
      case 'gateway': {
        const { gw, config } = await (deps.startGateway ?? startGateway)({ home, log: (l) => io.err(l) });
        const proc = deps.proc ?? process;
        // First signal: graceful (finish in-flight calls for up to shutdown_grace_ms, then destroy what is left). Second signal: destroy everything and exit now.
        // Both remove the pid file, the socket and the discovery file; the 'exit' hook does the same for any other exit that can run code.
        let signals = 0;
        const down = () => {
          signals += 1;
          if (signals === 1) { log0('gateway stopping (send the signal again to stop at once)'); gw.stop().catch(() => {}).finally(() => proc.exit(0)); return; }
          try { gw.stop({ force: true }); } catch { /* exiting anyway */ }
          proc.exit(0);
        };
        const log0 = (l) => io.err(l);
        for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) proc.on(sig, down);
        proc.on('exit', () => { try { gw.cleanupSync?.(); } catch { /* best effort */ } });
        io.out(`gateway running on ${config.socket_path} (uid ${typeof process.getuid === 'function' ? process.getuid() : '?'}); Ctrl-C to stop`);
        return null; // keeps running; the server holds the process open
      }
      default: io.err(USAGE); return EXIT.USAGE;
    }
  } catch (err) {
    io.err(`agent ${cmd ?? ''}: ${String(err?.message ?? 'failed').slice(0, 300)}`);
    return EXIT.FAILED;
  }
}
