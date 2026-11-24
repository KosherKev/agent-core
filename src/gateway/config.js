import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';

/** The only config version this code understands. Anything else is refused. */
export const CONFIG_VERSION = 1;

/** `AGENT_HOME`, else `~/.agent`. Everything the gateway owns lives under it (or at an explicit path in config.json). */
export function agentHome(env = process.env) {
  const h = env.AGENT_HOME;
  return resolve(typeof h === 'string' && h.trim() ? h : join(homedir(), '.agent'));
}

export const configPath = (home) => join(home, 'config.json');

const TOP_KEYS = ['config_version', 'socket_path', 'ledger_dir', 'credentials_file', 'runs_dir', 'pid_file', 'identities', 'allowed_peer_uids', 'providers'];
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
  for (const k of ['socket_path', 'ledger_dir', 'credentials_file', 'runs_dir', 'pid_file']) if (!isPath(raw[k])) errors.push(`${k} must be a non-empty path string`);
  const ids = raw.identities;
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) errors.push('identities must be an object');
  else {
    for (const k of Object.keys(ids)) if (!ID_KEYS.includes(k)) errors.push(`unknown key "identities.${k.slice(0, 40)}"`);
    for (const k of ID_KEYS) if (!isUid(ids[k])) errors.push(`identities.${k} must be a non-negative integer uid`);
  }
  if (!Array.isArray(raw.allowed_peer_uids) || !raw.allowed_peer_uids.every(isUid)) errors.push('allowed_peer_uids must be an array of non-negative integer uids');
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
  const config = Object.freeze({
    config_version: CONFIG_VERSION, home,
    socket_path: at(raw.socket_path), ledger_dir: at(raw.ledger_dir), credentials_file: at(raw.credentials_file), runs_dir: at(raw.runs_dir), pid_file: at(raw.pid_file),
    identities: Object.freeze({ gateway_uid: ids.gateway_uid, runner_uid: ids.runner_uid }),
    allowed_peer_uids: Object.freeze([...raw.allowed_peer_uids]),
    providers: Object.freeze(Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, Object.freeze({ base_url: v.base_url.replace(/\/+$/, '') })]))),
  });
  return { valid: true, errors: [], config };
}

/** Read and validate `<home>/config.json`. Never throws: { valid:false, errors } on any problem. */
export function loadConfig(home = agentHome(), readFile = (p) => readFileSync(p, 'utf8')) {
  let raw;
  try { raw = JSON.parse(readFile(configPath(home))); } catch (e) { return { valid: false, errors: [`cannot read ${configPath(home)} as JSON (${e?.code ?? 'parse error'})`], config: null }; }
  return validateConfig(raw, home);
}

/** The default config.json content for a fresh home (paths relative to home). */
export function defaultConfig({ gatewayUid, runnerUid }) {
  return {
    config_version: CONFIG_VERSION,
    socket_path: 'gateway.sock', ledger_dir: 'ledger', credentials_file: 'credentials.json', runs_dir: 'runs', pid_file: 'gateway.pid',
    identities: { gateway_uid: gatewayUid, runner_uid: runnerUid },
    allowed_peer_uids: [runnerUid],
    providers: {},
  };
}
