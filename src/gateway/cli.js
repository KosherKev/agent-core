import { join } from 'node:path';
import { agentHome, loadConfig } from './config.js';
import { runInit } from './init.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { realProbes } from './probes.js';
import { createFileLedgerStore } from './store.js';
import { createRunStore } from './runs.js';
import { loadCredentials } from './credentials.js';
import { createGatewayApi, NOT_IMPLEMENTED } from './api.js';
import { createGatewayServer, unknownPeerUid } from './server.js';
import { loadGatewayPrices } from './prices.js';
import { createSpendSink } from '../grant/index.js';
import { buildReport } from '../ledger/index.js';
import { canConnect } from './client.js';
import { DEFAULT_PRICE_FILE } from '../grant/index.js';
import { makeRedactor } from './credentials.js';

export const USAGE = `usage: agent <command>
  init           create AGENT_HOME, config.json and directories (never overwrites)
  doctor         run the boundary checks (exit 1 if any fails)
  status         show config, gateway reachability and ledger totals
  ledger:report  print the per-grant ledger report
  gateway        run the gateway (as the gateway user)
  run, upgrade   not implemented in M1a (run is gated by doctor)`;

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, NOT_IMPLEMENTED: 2, USAGE: 64 });

/**
 * Start the gateway process from config. deps are injectable for tests: { getPeerUid, fetchFn, priceFile, now }.
 * Fails closed: a bad config, credential file or ledger directory throws before anything listens.
 */
export async function startGateway({ home = agentHome(), getPeerUid = unknownPeerUid, fetchFn, priceFile = DEFAULT_PRICE_FILE, now = Date.now, log = () => {} } = {}) {
  const loaded = loadConfig(home);
  if (!loaded.valid) throw new Error(`config invalid: ${loaded.errors[0]}`);
  const config = loaded.config;
  const credentials = loadCredentials(config.credentials_file);
  const redact = makeRedactor(credentials.secrets());
  const { table, error } = loadGatewayPrices(priceFile);
  if (!table) throw new Error(`price table unusable: ${error}`);
  const store = createFileLedgerStore(config.ledger_dir, { now });
  const runs = createRunStore(config.runs_dir, { now });
  const api = createGatewayApi({ config, store, runs, credentials, priceTable: table, now, fetchFn, log: (l) => log(redact(l)), makeSink: (runId) => createSpendSink(join(config.runs_dir, `${runId.replace(/:/g, '_')}.spend.jsonl`), redact) });
  const gw = createGatewayServer({ api, config, getPeerUid, log: (l) => log(redact(l)) });
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
  const doctor = deps.doctor ?? (() => runDoctor({ home, probes: deps.probes ?? realProbes() }));
  try {
    switch (cmd) {
      case 'init': {
        const r = runInit({ home, ...(deps.init ?? {}) });
        r.made.forEach((p) => io.out(`created ${p}`)); r.kept.forEach((p) => io.out(`kept    ${p} (exists, not changed)`));
        return EXIT.OK;
      }
      case 'doctor': { const r = await doctor(); io.out(formatDoctor(r)); return r.ok ? EXIT.OK : EXIT.FAILED; }
      case 'status': {
        const loaded = loadConfig(home);
        if (!loaded.valid) { io.out(`config: INVALID (${loaded.errors[0]})`); return EXIT.FAILED; }
        const c = loaded.config;
        const up = await (deps.connect ?? canConnect)(c.socket_path);
        io.out(`home:    ${home}\nconfig:  valid (version ${c.config_version})\ngateway: ${up ? 'reachable' : 'NOT reachable'} (${c.socket_path})`);
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
        if (!r.ok) { io.err(formatDoctor(r)); io.err('agent run: refused because doctor failed'); return EXIT.FAILED; }
        io.err(`agent run: ${NOT_IMPLEMENTED}`);
        return EXIT.NOT_IMPLEMENTED;
      }
      case 'upgrade': io.err(`agent upgrade: ${NOT_IMPLEMENTED}`); return EXIT.NOT_IMPLEMENTED;
      case 'gateway': {
        const { config } = await (deps.startGateway ?? startGateway)({ home, log: (l) => io.err(l) });
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
