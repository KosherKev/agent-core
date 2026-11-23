import { lstatSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve, sep, dirname, isAbsolute, relative } from 'node:path';

/** Paths the builder may never write, regardless of grant (R4 plus adapter-owned state). */
export const ALWAYS_LOCKED = ['acceptance/', '.github/', '.git/', '.agent-runs/', '.agent-builder.local.json'];

export class ConfineError extends Error {
  constructor(message, blocked = false) { super(message); this.name = 'ConfineError'; this.blocked = blocked; }
}

const norm = (p) => p.split('/').filter((s) => s && s !== '.').join('/');

function lockedList(root) {
  const list = [...ALWAYS_LOCKED];
  const f = resolve(root, '.github/locked-paths.txt');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) list.push(t);
    }
  }
  return list;
}

function isUnder(rel, entry) {
  const e = entry.replace(/\/+$/, '');
  return rel === e || rel.startsWith(`${e}/`);
}

/**
 * Resolve a model-supplied relative path to an absolute path inside `root`.
 * Rejects absolute paths, `..` segments, NULs, backslashes, symlink escapes
 * (any existing ancestor or the target itself being a symlink out of root).
 * For writes also rejects locked paths and paths outside the grant's allowed prefixes.
 */
export function confine(root, userPath, { write = false, allowedPaths = ['.'] } = {}) {
  if (typeof userPath !== 'string' || !userPath) throw new ConfineError('path must be a non-empty string');
  if (userPath.includes('\0') || userPath.includes('\\')) throw new ConfineError('path contains forbidden characters');
  if (isAbsolute(userPath) || /^[A-Za-z]:/.test(userPath)) throw new ConfineError('absolute paths are not allowed');
  if (userPath.split('/').includes('..')) throw new ConfineError('".." segments are not allowed');
  const rel = norm(userPath);
  if (!rel) throw new ConfineError('path must name a file or directory inside the worktree');

  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, rel);
  // Walk to the deepest existing ancestor; it must resolve inside the real root.
  let probe = abs;
  while (!existsSync(probe) && !isLink(probe)) probe = dirname(probe);
  let realProbe;
  try { realProbe = realpathSync(probe); } catch { throw new ConfineError('unresolvable path or dangling symlink'); }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new ConfineError('path escapes the worktree (symlink)');
  if (isLink(abs)) {
    const real = existsSync(abs) ? realpathSync(abs) : null;
    if (write || real === null || (real !== realRoot && !real.startsWith(realRoot + sep))) throw new ConfineError('symlinks are not allowed');
  }
  if (relative(realRoot, abs).startsWith('..')) throw new ConfineError('path escapes the worktree');

  if (write) {
    if (lockedList(realRoot).some((l) => isUnder(rel, norm(l)))) throw new ConfineError(`path "${rel}" is locked`, true);
    const ok = allowedPaths.some((p) => { const n = norm(p); return n === '' || n === '*' || n === '**' || isUnder(rel, n); });
    if (!ok) throw new ConfineError(`path "${rel}" is outside the grant's allowed paths`, true);
  }
  return { abs, rel };
}

function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
