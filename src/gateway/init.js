import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { agentHome, configPath, defaultConfig, validateConfig } from './config.js';

/**
 * agent init: create AGENT_HOME (0700), its directories (0700) and a default config.json (0600). Never overwrites anything that exists.
 * Creates no OS users and changes no system permissions. gateway_uid defaults to the current uid, which doctor will then flag
 * (the runner could read the gateway files) until the gateway user is set up by hand.
 */
export function runInit({ home = agentHome(), uid = typeof process.getuid === 'function' ? process.getuid() : 0, gatewayUid, socketDir, runnerGroup } = {}) {
  const made = []; const kept = [];
  const dir = (p) => { if (existsSync(p)) { kept.push(p); return; } mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); made.push(p); };
  dir(home);
  const raw = defaultConfig({ gatewayUid: gatewayUid ?? uid, runnerUid: uid, ...(socketDir ? { socketDir } : {}), ...(runnerGroup !== undefined ? { runnerGroup } : {}) });
  const v = validateConfig(raw, home);
  if (!v.valid) throw new Error(`default config is invalid: ${v.errors[0]}`);
  dir(v.config.ledger_dir); dir(v.config.runs_dir); // socket_dir is created by the gateway at startup (or by hand, see docs/gateway.md): init changes nothing outside AGENT_HOME
  const file = configPath(home);
  if (existsSync(file)) kept.push(file); else { writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); made.push(file); }
  return { made, kept };
}
