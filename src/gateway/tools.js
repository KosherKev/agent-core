import { statSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';

/**
 * External commands the doctor and the lookups need (id, ps, dscl, lsof), run WITHOUT the PATH: a planted `id` earlier on the PATH
 * must never decide who the gateway is. Each tool has a fixed per-platform list of absolute candidates. A candidate is used only if
 * it exists, is a regular file, is owned by root and is not writable by group or others; otherwise the tool is refused (fail closed)
 * with a reason that names the path. The child gets a minimal fixed environment: no PATH, locale C.
 * Candidates confirmed on macOS (this repo's rehearsal machine): id /usr/bin/id, ps /bin/ps, dscl /usr/bin/dscl, lsof /usr/sbin/lsof.
 * Linux candidates (usr-merged and split layouts) are the standard locations and are NOT confirmed on a Linux machine from here.
 */
export const TOOL_CANDIDATES = Object.freeze({
  darwin: Object.freeze({ id: ['/usr/bin/id'], ps: ['/bin/ps'], dscl: ['/usr/bin/dscl'], lsof: ['/usr/sbin/lsof'] }),
  linux: Object.freeze({ id: ['/usr/bin/id', '/bin/id'], ps: ['/usr/bin/ps', '/bin/ps'], lsof: ['/usr/bin/lsof', '/usr/sbin/lsof', '/bin/lsof'] }),
});
export const TOOL_ENV = Object.freeze({ LC_ALL: 'C', LANG: 'C' });

export class ToolError extends Error { constructor(message) { super(message); this.name = 'ToolError'; } }
let lastRefusal = null;
/** The most recent refusal reason (names the path), or null. For doctor to show why a lookup failed closed. */
export const lastToolRefusal = () => lastRefusal;

/** The absolute path of a trusted tool, or throws ToolError naming what was wrong with every candidate. */
export function resolveTool(name, { platform = process.platform, statFn = statSync } = {}) {
  const list = TOOL_CANDIDATES[platform]?.[name];
  if (!list) { lastRefusal = `no trusted location is known for ${name} on ${platform}`; throw new ToolError(lastRefusal); }
  const why = [];
  for (const path of list) {
    let st;
    try { st = statFn(path); } catch (e) { why.push(`${path}: ${e?.code ?? 'cannot be inspected'}`); continue; }
    if (!st.isFile()) { why.push(`${path}: not a regular file`); continue; }
    if (st.uid !== 0) { why.push(`${path}: not owned by root (uid ${st.uid})`); continue; }
    if ((st.mode & 0o022) !== 0) { why.push(`${path}: writable by group or others`); continue; }
    lastRefusal = null;
    return path;
  }
  lastRefusal = `${name} refused: ${why.join('; ')}`.slice(0, 300);
  throw new ToolError(lastRefusal);
}

const base = { env: TOOL_ENV, encoding: 'utf8', timeout: 5000 };
/** Run a trusted tool and return its stdout. Throws ToolError (refused) or the child's own error. */
export function runToolSync(name, args, { platform, statFn, exec = execFileSync } = {}) {
  const path = resolveTool(name, { platform, statFn });
  return exec(path, args, { ...base, stdio: ['ignore', 'pipe', 'ignore'] });
}
/** Async variant: resolves { err, out } like execFile's callback (err is a ToolError when refused). */
export function runToolAsync(name, args, { platform, statFn, exec = execFile } = {}) {
  return new Promise((res) => {
    let path; try { path = resolveTool(name, { platform, statFn }); } catch (err) { res({ err, out: '' }); return; }
    exec(path, args, base, (err, out) => res({ err, out }));
  });
}
