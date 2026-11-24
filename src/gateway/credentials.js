import { readFileSync, statSync } from 'node:fs';

/**
 * Load the gateway's credential store: a JSON file { "providers": { "<name>": "<key>" } }, mode 0600, owned by the gateway uid.
 * Fails closed (throws) on a loose mode, a foreign owner, or a malformed file. Error messages never contain a key.
 * Returns { get(provider) -> string|null, secrets() -> string[] } ; the secrets list exists only so the redactor can scrub them.
 */
export function loadCredentials(path, { uid = typeof process.getuid === 'function' ? process.getuid() : undefined, io = { statSync, readFileSync } } = {}) {
  let st;
  try { st = io.statSync(path); } catch { throw new Error('credential file is missing or unreadable; refusing'); }
  if (!st.isFile()) throw new Error('credential path is not a regular file; refusing');
  if ((st.mode & 0o077) !== 0) throw new Error('credential file must be mode 0600 (chmod 600 it); refusing');
  if (uid !== undefined && st.uid !== uid) throw new Error('credential file is not owned by the gateway user; refusing');
  let data;
  try { data = JSON.parse(io.readFileSync(path, 'utf8')); } catch { throw new Error('credential file is not valid JSON; refusing'); }
  const p = data?.providers;
  if (!data || typeof data !== 'object' || Object.keys(data).some((k) => k !== 'providers') || !p || typeof p !== 'object' || Array.isArray(p)) throw new Error('credential file must be { "providers": { name: key } }; refusing');
  const keys = new Map();
  for (const [name, key] of Object.entries(p)) {
    if (typeof key !== 'string' || key.length < 8 || /\s/.test(key)) throw new Error('credential file has a malformed key; refusing');
    keys.set(name, key);
  }
  return Object.freeze({ get: (name) => keys.get(name) ?? null, secrets: () => [...keys.values()] });
}

/** Redactor that removes every known key verbatim plus common key and bearer shapes. */
export function makeRedactor(secrets = []) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return (text) => {
    let s = String(text);
    for (const k of known) s = s.split(k).join('[REDACTED]');
    return s.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  };
}

/** Deep-redact every string in a JSON-able value. */
export function redactDeep(v, redact) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, redact));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, redact)]));
  return v;
}
