import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname, sep } from 'node:path';
import { readFileSync } from 'node:fs';

/** The only config version this code understands. Anything else is refused. */
export const CONFIG_VERSION = 1;

/** `AGENT_HOME`, else `~/.agent`. Everything the gateway owns lives under it (or at an explicit path in config.json). */
export function agentHome(env = process.env) {
  const h = env.AGENT_HOME;
  return resolve(typeof h === 'string' && h.trim() ? h : join(homedir(), '.agent'));
}

export const configPath = (home) => join(home, 'config.json');

const TOP_KEYS = ['config_version', 'socket_dir', 'socket_path', 'runner_group', 'ledger_dir', 'credentials_file', 'runs_dir', 'pid_file', 'identities', 'allowed_peer_uids', 'providers',
  'provider_timeout_ms', 'idle_timeout_ms', 'max_response_bytes', 'max_request_bytes', 'max_connections', 'shutdown_grace_ms', 'request_read_timeout_ms', 'request_cache_max'];
/** Limits: [default, min, max]. All integers. */
export const LIMITS = Object.freeze({
  provider_timeout_ms: [120_000, 1, 600_000],
  idle_timeout_ms: [30_000, 1, 3_600_000],
  max_response_bytes: [8 * 1024 * 1024, 1024, 64 * 1024 * 1024],
  max_request_bytes: [1024 * 1024, 1024, 16 * 1024 * 1024],
  max_connections: [8, 1, 256],
  shutdown_grace_ms: [10_000, 0, 600_000],
  request_read_timeout_ms: [10_000, 1, 3_600_000],
  request_cache_max: [1024, 1, 1_000_000],
});
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const ID_KEYS = ['gateway_uid', 'runner_uid'];
const PROVIDER_KEYS = ['base_url'];
const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

const isUid = (n) => Number.isSafeInteger(n) && n >= 0;
const isPath = (s) => typeof s === 'string' && s.length > 0 && s.length < 1024 && !s.includes('\0');

/** https always; plain http only for loopback (so the test mock works and nothing can leave the machine in cleartext). */
export function checkBaseUrl(u) {
  let url;
  try { url = new URL(u); } catch { return 'base_url is not a valid URL'; }
  if (url.username || url.password || url.search || url.hash) return 'base_url must not carry credentials, a query or a fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return 'base_url must be https (plain http only for loopback)';
}

/**
 * Validate a parsed config. Unknown keys and unknown versions are refused (fail closed).
 * Returns { valid, errors, config } where config has every path resolved against `home`.
 */
export function validateConfig(raw, home) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, errors: ['config must be a JSON object'], config: null };
  if (raw.config_version !== CONFIG_VERSION) errors.push(`config_version must be ${CONFIG_VERSION} (got ${JSON.stringify(raw.config_version)?.slice(0, 30)}); unknown versions are refused`);
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(`unknown key "${k.slice(0, 40)}"`);
  for (const k of ['socket_dir', 'ledger_dir', 'credentials_file', 'runs_dir', 'pid_file']) if (!isPath(raw[k])) errors.push(`${k} must be a non-empty path string`);
  if (raw.socket_path !== undefined && !isPath(raw.socket_path)) errors.push('socket_path must be a non-empty path string');
  if (isPath(raw.socket_dir) && !isAbsolute(raw.socket_dir)) errors.push('socket_dir must be an absolute path (it lives outside AGENT_HOME)');
  const grp = raw.runner_group;
  if (!(typeof grp === 'string' && GROUP_NAME.test(grp)) && !isUid(grp)) errors.push('runner_group must be a group name or a non-negative integer gid');
  for (const [k, [, lo, hi]] of Object.entries(LIMITS)) if (raw[k] !== undefined && !(Number.isSafeInteger(raw[k]) && raw[k] >= lo && raw[k] <= hi)) errors.push(`${k} must be an integer from ${lo} to ${hi}`);
  const ids = raw.identities;
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) errors.push('identities must be an object');
  else {
    for (const k of Object.keys(ids)) if (!ID_KEYS.includes(k)) errors.push(`unknown key "identities.${k.slice(0, 40)}"`);
    for (const k of ID_KEYS) if (!isUid(ids[k])) errors.push(`identities.${k} must be a non-negative integer uid`);
  }
  if (raw.allowed_peer_uids !== undefined && (!Array.isArray(raw.allowed_peer_uids) || !raw.allowed_peer_uids.every(isUid))) errors.push('allowed_peer_uids must be an array of non-negative integer uids (optional: only used with a peer-uid probe)');
  const prov = raw.providers;
  if (!prov || typeof prov !== 'object' || Array.isArray(prov)) errors.push('providers must be an object');
  else {
    for (const [name, p] of Object.entries(prov)) {
      if (!PROVIDER_NAME.test(name)) { errors.push(`provider name "${name.slice(0, 40)}" is invalid`); continue; }
      if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(`providers.${name} must be an object`); continue; }
      for (const k of Object.keys(p)) if (!PROVIDER_KEYS.includes(k)) errors.push(`unknown key "providers.${name}.${k.slice(0, 40)}"`);
      const why = typeof p.base_url === 'string' ? checkBaseUrl(p.base_url) : 'base_url must be a string';
      if (why) errors.push(`providers.${name}: ${why}`);
    }
  }
  if (errors.length) return { valid: false, errors, config: null };
  const at = (p) => (isAbsolute(p) ? resolve(p) : resolve(home, p));
  const socketDir = resolve(raw.socket_dir);
  const socketPath = raw.socket_path === undefined ? join(socketDir, 'gateway.sock') : resolve(socketDir, raw.socket_path);
  if (dirname(socketPath) !== socketDir) errors.push('socket_path must be directly inside socket_dir');
  if (inside(socketDir, home) || inside(home, socketDir)) errors.push('socket_dir and AGENT_HOME must be separate directories (the runner reaches the socket but never the state)');
  for (const k of ['ledger_dir', 'credentials_file', 'runs_dir', 'pid_file']) if (!inside(at(raw[k]), home) || at(raw[k]) === home) errors.push(`${k} must be inside AGENT_HOME`);
  if (errors.length) return { valid: false, errors, config: null };
  const config = Object.freeze({
    config_version: CONFIG_VERSION, home,
    socket_dir: socketDir, socket_path: socketPath, runner_group: raw.runner_group, ledger_dir: at(raw.ledger_dir), credentials_file: at(raw.credentials_file), runs_dir: at(raw.runs_dir), pid_file: at(raw.pid_file),
    identities: Object.freeze({ gateway_uid: ids.gateway_uid, runner_uid: ids.runner_uid }),
    allowed_peer_uids: Object.freeze([...(raw.allowed_peer_uids ?? [])]),
    ...Object.fromEntries(Object.entries(LIMITS).map(([k, [d]]) => [k, raw[k] ?? d])),
    providers: Object.freeze(Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, Object.freeze({ base_url: v.base_url.replace(/\/+$/, '') })]))),
  });
  return { valid: true, errors: [], config };
}

/** Read and validate `<home>/config.json`. Never throws: { valid:false, errors } on any problem. */
export function loadConfig(home = agentHome(), readFile = (p) => readFileSync(p, 'utf8')) {
  let raw;
  try { raw = JSON.parse(readFile(configPath(home))); } catch (e) { return { valid: false, errors: [`cannot read ${configPath(home)} as JSON (${e?.code ?? 'parse error'})`], config: null, denied: e?.code === 'EACCES' || e?.code === 'EPERM' }; }
  return validateConfig(raw, home);
}

/** The default config.json content for a fresh home (paths relative to home). */
export function defaultConfig({ gatewayUid, runnerUid, socketDir = '/var/run/agent-gateway', runnerGroup = 'agent-runner' }) {
  return {
    config_version: CONFIG_VERSION,
    socket_dir: socketDir, runner_group: runnerGroup,
    ledger_dir: 'ledger', credentials_file: 'credentials.json', runs_dir: 'runs', pid_file: 'gateway.pid',
    identities: { gateway_uid: gatewayUid, runner_uid: runnerUid },
    providers: {},
  };
}
