import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

export const DEFAULTS = Object.freeze({
  model: 'particle-ai/particle-1:free',
  base_url: 'https://openrouter.ai/api/v1',
  role: 'builder',
  free_model_repo_allowlist: Object.freeze(['agent-core']),
  rate_limit: Object.freeze({ max_retries: 3, base_delay_ms: 1000, max_delay_ms: 30000 }),
  request_timeout_ms: 120000,
});

export const LOCAL_CONFIG_FILE = '.agent-builder.local.json';
const FILE_KEYS = new Set(['model', 'base_url', 'role', 'provider', 'free_model_repo_allowlist', 'rate_limit', 'request_timeout_ms']);
const SECRETISH = /^(api[_-]?key|openrouter[_-]?api[_-]?key|key|token|secret|authorization)$/i;

function parseList(v, what) {
  const items = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new ConfigError(`${what} must list at least one entry`);
  return items;
}
function parseBool(v, what) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`${what} must be true or false`);
}
function intIn(v, what, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${what} must be an integer between ${min} and ${max}`);
  return v;
}

function validateRole(role) {
  if (typeof role !== 'string' || !role.trim()) throw new ConfigError('role must be a non-empty string; only "builder" is accepted');
  if (role === 'builder') return role;
  if (role === 'overseer') throw new ConfigError('role "overseer" is rejected: this adapter is a builder only and never answers gates (rule R2)');
  throw new ConfigError(`unknown role "${role.slice(0, 40)}": only "builder" is accepted`);
}

/**
 * Load builder config. Precedence: env > optional untracked local file > defaults.
 * The API key is read from OPENROUTER_API_KEY only and is attached as a
 * non-enumerable property, so it never shows up in JSON/inspect/spread output.
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), file } = {}) {
  const path = file ?? join(cwd, LOCAL_CONFIG_FILE);
  let local = {};
  if (existsSync(path)) {
    try { local = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new ConfigError(`local config ${LOCAL_CONFIG_FILE} is not valid JSON`); }
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new ConfigError(`local config ${LOCAL_CONFIG_FILE} must be a JSON object`);
    for (const k of Object.keys(local)) {
      if (SECRETISH.test(k)) throw new ConfigError(`local config must not contain "${k}": the API key is read from the environment only (OPENROUTER_API_KEY)`);
      if (!FILE_KEYS.has(k)) throw new ConfigError(`unknown key "${k.slice(0, 40)}" in local config`);
    }
  }

  const model = env.AGENT_BUILDER_MODEL || local.model || DEFAULTS.model;
  if (typeof model !== 'string' || !model.trim() || /\s/.test(model)) throw new ConfigError('model must be a non-empty string without whitespace');

  const baseUrl = env.AGENT_BUILDER_BASE_URL || local.base_url || DEFAULTS.base_url;
  let u;
  try { u = new URL(baseUrl); } catch { throw new ConfigError('base_url must be a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError('base_url must be http(s)');
  if (u.username || u.password) throw new ConfigError('base_url must not embed credentials');

  const role = validateRole(env.AGENT_BUILDER_ROLE ?? local.role ?? DEFAULTS.role);

  const allowlist = env.FREE_MODEL_REPO_ALLOWLIST
    ? parseList(env.FREE_MODEL_REPO_ALLOWLIST, 'FREE_MODEL_REPO_ALLOWLIST')
    : local.free_model_repo_allowlist !== undefined
      ? (Array.isArray(local.free_model_repo_allowlist) && local.free_model_repo_allowlist.length && local.free_model_repo_allowlist.every((s) => typeof s === 'string' && s.trim())
        ? local.free_model_repo_allowlist.map((s) => s.trim())
        : (() => { throw new ConfigError('free_model_repo_allowlist must be a non-empty array of repo names'); })())
      : [...DEFAULTS.free_model_repo_allowlist];

  const lp = local.provider ?? {};
  if (typeof lp !== 'object' || Array.isArray(lp)) throw new ConfigError('provider must be an object');
  for (const k of Object.keys(lp)) if (!['order', 'allow_fallbacks', 'data_collection'].includes(k)) throw new ConfigError(`unknown provider key "${k.slice(0, 40)}"`);
  const provider = {};
  const order = env.AGENT_BUILDER_PROVIDER_ORDER ? parseList(env.AGENT_BUILDER_PROVIDER_ORDER, 'AGENT_BUILDER_PROVIDER_ORDER') : lp.order;
  if (order !== undefined) {
    if (!Array.isArray(order) || !order.length || !order.every((s) => typeof s === 'string' && s.trim())) throw new ConfigError('provider.order must be a non-empty array of provider names');
    provider.order = order;
  }
  const af = env.AGENT_BUILDER_ALLOW_FALLBACKS ?? lp.allow_fallbacks;
  if (af !== undefined) provider.allow_fallbacks = parseBool(af, 'allow_fallbacks');
  const dc = env.AGENT_BUILDER_DATA_COLLECTION ?? lp.data_collection;
  if (dc !== undefined) {
    if (dc !== 'deny' && dc !== 'allow') throw new ConfigError('data_collection must be "deny" or "allow"');
    provider.data_collection = dc;
  }

  const rl = { ...DEFAULTS.rate_limit, ...(local.rate_limit ?? {}) };
  for (const k of Object.keys(rl)) if (!(k in DEFAULTS.rate_limit)) throw new ConfigError(`unknown rate_limit key "${k.slice(0, 40)}"`);
  intIn(rl.max_retries, 'rate_limit.max_retries', 0, 5);
  intIn(rl.max_delay_ms, 'rate_limit.max_delay_ms', 0, 120000);
  intIn(rl.base_delay_ms, 'rate_limit.base_delay_ms', 0, rl.max_delay_ms);
  const timeout = intIn(local.request_timeout_ms ?? DEFAULTS.request_timeout_ms, 'request_timeout_ms', 1000, 600000);

  const config = {
    model, base_url: baseUrl.replace(/\/+$/, ''), role,
    free_model_repo_allowlist: allowlist, provider, rate_limit: rl, request_timeout_ms: timeout,
  };
  Object.defineProperty(config, 'apiKey', { value: env.OPENROUTER_API_KEY || '', enumerable: false });
  return Object.freeze(config);
}

export const isFreeModel = (model) => model.endsWith(':free');
