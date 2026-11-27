/**
 * Capability contract v2 (ADR-0007): pure checks over manifests, grants and the trust registry.
 *
 * Pure: no network, no clock (the caller passes `now`), no writes. The only I/O is loadScopeVocabulary, which reads one
 * JSON file. Fail closed: every function except canonicalJson, definitionHash and loadScopeVocabulary returns a
 * result for any input and never throws; those three throw, as documented on each.
 *
 * Grant hash rule (checkCapabilityAllowed): the grant entry for a capability must carry the manifest's
 * `definition_hash`. A builtin manifest may have no `definition_hash`; for it the grant entry's hash must equal
 * definitionHash() of the manifest object itself with any `definition_hash` field removed.
 *
 * Nothing here is enforced by the gateway yet. `effect`, annotations and descriptions are the tool author's claims.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifestV2Schema, validateGrantV2Schema, validateTrustRegistryV2Schema, validateScopesV2Schema } from './validators.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_VOCABULARY_PATH = join(ROOT, 'config', 'capability-scopes.json');

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sortedKeys = (o) => Object.keys(o).sort(); // default sort compares UTF-16 code units

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order at every depth, arrays keep order, no whitespace.
 * THROWS TypeError on undefined, functions, symbols, NaN, Infinity, -0, BigInt, a cycle, or a non-plain object.
 */
export function canonicalJson(value) {
  const stack = [];
  const walk = (v) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string': case 'boolean': return JSON.stringify(v);
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: ${v} is not allowed`);
        if (Object.is(v, -0)) throw new TypeError('canonicalJson: -0 is not allowed');
        return JSON.stringify(v);
      case 'undefined': case 'function': case 'symbol': case 'bigint':
        throw new TypeError(`canonicalJson: ${typeof v} is not allowed`);
      default: break;
    }
    if (stack.includes(v)) throw new TypeError('canonicalJson: cycle');
    const isArr = Array.isArray(v);
    if (!isArr) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays are allowed');
    }
    stack.push(v);
    let out;
    if (isArr) {
      const parts = [];
      for (let i = 0; i < v.length; i += 1) parts.push(walk(v[i]));
      out = `[${parts.join(',')}]`;
    } else {
      out = `{${sortedKeys(v).map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
    }
    stack.pop();
    return out;
  };
  return walk(value);
}

/** Lowercase hex sha256 of the UTF-8 bytes of canonicalJson(toolDefinition). Throws what canonicalJson throws. */
export function definitionHash(toolDefinition) {
  return createHash('sha256').update(Buffer.from(canonicalJson(toolDefinition), 'utf8')).digest('hex');
}

const TIER = { read: 'low', write_reversible: 'medium', write_irreversible: 'high', money: 'payments' };
const LEVEL = { read: 0, write_reversible: 1, write_irreversible: 2, money: 2 };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The risk tier an effect implies, or null for an unknown effect. */
export function tierForEffect(effect) {
  return typeof effect === 'string' && own(TIER, effect) ? TIER[effect] : null;
}

/**
 * Lowest trust level that may run this manifest: by effect read=0, write_reversible=1, write_irreversible=2, money=2;
 * a non-empty `credentials` list raises 0 to 1. Unknown or malformed input gives Infinity (nothing is high enough).
 */
export function minTrustLevel(manifest) {
  if (!isPlain(manifest) || typeof manifest.effect !== 'string' || !own(LEVEL, manifest.effect)) return Infinity;
  const base = LEVEL[manifest.effect];
  return base === 0 && Array.isArray(manifest.credentials) && manifest.credentials.length > 0 ? 1 : base;
}

/**
 * Load the scope vocabulary (an array of scope strings). THROWS an Error naming the path when the file is missing,
 * unreadable, not JSON or not valid against capability-scopes-v2 (fail closed).
 */
export function loadScopeVocabulary(path = DEFAULT_VOCABULARY_PATH) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`scope vocabulary unavailable at ${path}: ${e && e.code ? e.code : 'unreadable or not JSON'}`);
  }
  const r = validateScopesV2Schema(doc);
  if (!r.valid) throw new Error(`scope vocabulary invalid at ${path}: ${r.errors.join('; ')}`);
  return [...doc.scopes];
}

const fail = (...errors) => ({ valid: false, errors });
const asSet = (v) => (v instanceof Set ? v : Array.isArray(v) ? new Set(v) : null);

// Manifest checks that need no vocabulary: schema, plus the mcp hash and name rules.
function checkManifestCore(manifest) {
  const s = validateManifestV2Schema(manifest);
  if (!s.valid) return s;
  const errors = [];
  if (manifest.origin.kind === 'mcp') {
    const td = manifest.tool_definition;
    if (typeof td.name !== 'string' || td.name === '') errors.push('/tool_definition/name must not be empty');
    else if (manifest.name !== `${manifest.origin.server_id}.${td.name}`) errors.push(`/name must equal <server_id>.<tool_definition.name>, expected "${manifest.origin.server_id}.${td.name}"`);
    let h;
    try { h = definitionHash(td); } catch (e) { errors.push(`/tool_definition cannot be hashed: ${e.message}`); }
    if (h !== undefined && manifest.definition_hash !== h) errors.push('/definition_hash does not equal the hash of /tool_definition');
  }
  return errors.length ? fail(...errors) : { valid: true, errors: [] };
}

/**
 * Schema check plus: for mcp origin the definition_hash equals definitionHash(tool_definition) and name equals
 * `<server_id>.<tool_definition.name>`; every scope is in `vocabulary` (array or Set). When `vocabulary` is omitted
 * the default file is loaded; if that fails the result is { valid: false } with the reason. Never throws.
 */
export function validateManifestV2(manifest, { vocabulary } = {}) {
  try {
    const core = checkManifestCore(manifest);
    if (!core.valid) return core;
    let vocab;
    if (vocabulary === undefined) {
      try { vocab = new Set(loadScopeVocabulary()); } catch (e) { return fail(`scope vocabulary unavailable: ${e.message}`); }
    } else {
      vocab = asSet(vocabulary);
      if (!vocab) return fail('vocabulary must be an array or a Set');
    }
    const outside = manifest.scopes.filter((sc) => !vocab.has(sc));
    return outside.length ? fail(...outside.map((sc) => `/scopes scope "${sc}" is not in the vocabulary`)) : { valid: true, errors: [] };
  } catch (e) {
    return fail(`unexpected error: ${e && e.message ? e.message : String(e)}`);
  }
}

/** Schema check plus capability names unique. Never throws. */
export function validateGrantV2(grant) {
  try {
    const s = validateGrantV2Schema(grant);
    if (!s.valid) return s;
    const seen = new Set();
    const errors = [];
    for (const c of grant.capabilities) {
      if (seen.has(c.name)) errors.push(`/capabilities capability "${c.name}" is listed twice`);
      seen.add(c.name);
    }
    return errors.length ? fail(...errors) : s;
  } catch (e) {
    return fail(`unexpected error: ${e && e.message ? e.message : String(e)}`);
  }
}

/** Schema check plus no two entries share (server_id, pinned_commit, definition_hash). Never throws. */
export function validateRegistryV2(registry) {
  try {
    const s = validateTrustRegistryV2Schema(registry);
    if (!s.valid) return s;
    const seen = new Set();
    const errors = [];
    registry.entries.forEach((e, i) => {
      const key = `${e.server_id}\n${e.pinned_commit}\n${e.definition_hash}`;
      if (seen.has(key)) errors.push(`/entries/${i} duplicates an earlier entry for (server_id, pinned_commit, definition_hash)`);
      seen.add(key);
    });
    return errors.length ? fail(...errors) : s;
  } catch (e) {
    return fail(`unexpected error: ${e && e.message ? e.message : String(e)}`);
  }
}

/**
 * Compare a pinned hash with a live tool definition. Never throws: a live definition that cannot be hashed counts as
 * drifted with liveHash null.
 */
export function detectDrift(pinnedHash, liveToolDefinition) {
  try {
    const liveHash = definitionHash(liveToolDefinition);
    return { drifted: typeof pinnedHash !== 'string' || pinnedHash !== liveHash, liveHash };
  } catch {
    return { drifted: true, liveHash: null };
  }
}

const deny = (reason) => ({ allowed: false, reason });

/**
 * May this task call this capability? Checks in order and stops at the first failure:
 * 0 `vocabulary` (an array or Set of scope strings, REQUIRED) is present, else `vocabulary_missing`;
 * 1 grant and manifest valid (the manifest's scopes must all be in `vocabulary`, whatever the registry says);
 * 2 `now` (a Date, required) before grant.expires_at; 3 the grant lists the manifest's name
 * with the matching definition hash; 4 risk_tier in grant.allowed_risk_tiers; then, for mcp origin only:
 * 5 a registry entry for exactly (server_id, pinned_commit, definition_hash);
 * 6 entry.trust_level >= minTrustLevel(manifest); 7 every manifest scope in entry.approved_scopes;
 * 8 every manifest credential in entry.credential_refs.
 * There is no way to skip the vocabulary check. Never throws.
 */
export function checkCapabilityAllowed(args) {
  try {
    if (args === null || typeof args !== 'object') return deny('input_invalid: expected an object { grant, manifest, registry, now, vocabulary }');
    const { grant, manifest, registry, now, vocabulary } = args;
    if (!(Array.isArray(vocabulary) || vocabulary instanceof Set)) return deny('vocabulary_missing: vocabulary must be an array or a Set of scope strings');
    const g = validateGrantV2(grant);
    if (!g.valid) return deny(`grant_invalid: ${g.errors.join('; ')}`);
    const m = validateManifestV2(manifest, { vocabulary });
    if (!m.valid) return deny(`manifest_invalid: ${m.errors.join('; ')}`);

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('now_invalid: now must be a valid Date');
    const expires = Date.parse(grant.expires_at);
    if (Number.isNaN(expires)) return deny('grant_expired: expires_at cannot be parsed');
    if (!(now.getTime() < expires)) return deny('grant_expired: the grant has expired');

    const listed = grant.capabilities.find((c) => c.name === manifest.name);
    if (!listed) return deny(`capability_not_granted: the grant does not list "${manifest.name}"`);
    let expected = manifest.definition_hash;
    if (expected === undefined) {
      const { definition_hash: _omit, ...rest } = manifest; // builtin manifest with no hash
      expected = definitionHash(rest);
    }
    if (listed.definition_hash !== expected) return deny('hash_mismatch: the grant pins a different definition hash than the manifest');

    if (!grant.allowed_risk_tiers.includes(manifest.risk_tier)) return deny(`tier_not_allowed: risk tier "${manifest.risk_tier}" is not in the grant`);

    if (manifest.origin.kind === 'builtin') return { allowed: true, reason: 'ok: builtin capability, grant checks passed' };

    const r = validateRegistryV2(registry);
    if (!r.valid) return deny(`registry_absent: no valid trust registry (${r.errors.join('; ')})`);
    const { server_id, pinned_commit } = manifest.origin;
    const entry = registry.entries.find((e) => e.server_id === server_id && e.pinned_commit === pinned_commit && e.definition_hash === manifest.definition_hash);
    if (!entry) return deny('registry_absent: no registry entry for this (server_id, pinned_commit, definition_hash)');
    const need = minTrustLevel(manifest);
    if (!(entry.trust_level >= need)) return deny(`trust_level_too_low: entry level ${entry.trust_level}, capability needs ${need}`);
    const badScope = manifest.scopes.filter((sc) => !entry.approved_scopes.includes(sc));
    if (badScope.length) return deny(`scope_not_approved: ${badScope.join(', ')}`);
    const badCred = manifest.credentials.filter((c) => !entry.credential_refs.includes(c));
    if (badCred.length) return deny(`credential_not_approved: ${badCred.join(', ')}`);
    return { allowed: true, reason: 'ok: all checks passed' };
  } catch (e) {
    return deny(`unexpected_error: ${e && e.message ? e.message : String(e)}`);
  }
}
