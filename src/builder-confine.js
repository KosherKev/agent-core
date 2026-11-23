import { lstatSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve, sep, dirname, isAbsolute, relative } from 'node:path';

/**
 * Paths the builder may never write, regardless of grant: R4 (acceptance/, .github/ which holds the guard
 * script and CODEOWNERS), the locked validators, any CODEOWNERS file, the git directory and adapter-owned
 * state. package.json is deliberately NOT locked yet.
 */
export const ALWAYS_LOCKED = ['acceptance/', '.github/', 'CODEOWNERS', 'src/validators.js', '.git/', '.agent-runs/', '.agent-builder.local.json'];

export class ConfineError extends Error {
  constructor(message, blocked = false) { super(message); this.name = 'ConfineError'; this.blocked = blocked; }
}

// Zero-width and bidi characters that some filesystems (HFS+) ignore when comparing names.
const IGNORABLE = /[​-‏‪-‮⁠-⁯﻿­]/g;

/** One path segment, folded the way a case-insensitive, normalisation-insensitive filesystem would compare it. */
export function foldSegment(s) {
  return s.normalize('NFD').replace(IGNORABLE, '').normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}
/** Segment with trailing dots/spaces removed (Windows and some network filesystems treat `.git ` as `.git`). */
const stripTrail = (s) => s.replace(/[. ]+$/, '');

/** True for `.git` and any spelling a filesystem could resolve to it (case, trailing dot/space, 8.3 short names). */
export function isGitLikeSegment(seg) {
  const f = stripTrail(foldSegment(seg));
  return f === '.git' || f === '.gitmodules' || f === '.gitattributes' || /^\.git~\d*/.test(f) || /^git~\d+$/.test(f);
}

const foldPath = (p) => p.split('/').filter((s) => s && s !== '.').map((s) => stripTrail(foldSegment(s)));

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

/** Folded-segment prefix test: `segs` is at or under `entry`. */
function underFolded(segs, entry) {
  const e = foldPath(entry);
  return e.length > 0 && e.length <= segs.length && e.every((s, i) => s === segs[i]);
}

/** Is this repo-relative path locked? Case, unicode normalisation, `.git` spellings and CODEOWNERS anywhere are all folded. */
export function isLockedPath(rel, lockedEntries = ALWAYS_LOCKED) {
  const segs = foldPath(rel);
  if (segs.some(isGitLikeSegment)) return true;
  if (segs.length && segs[segs.length - 1] === 'codeowners') return true;
  return lockedEntries.some((l) => underFolded(segs, l));
}

function isUnder(rel, entry) {
  const e = entry.replace(/\/+$/, '');
  return rel === e || rel.startsWith(`${e}/`);
}

function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

// ---------------------------------------------------------------- read denylist
const DENY_EXT = /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|asc|gpg|ppk)$/;
const DENY_NAME = /(token|credential|secret|passw(or)?d|apikey|api[-_]key|private[-_]?key|auth[-_]?key)/;
const DENY_EXACT = new Set(['.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials', '.agent-builder.local.json', '.dockercfg']);

/** Does a (folded) segment name something that must never be read? */
function deniedSegment(f) {
  return f.startsWith('.env') || f === '.ssh' || f === '.aws' || f === '.gnupg' || f === '.kube' || f === '.docker' || f === '.agent-runs'
    || DENY_EXACT.has(f) || DENY_EXT.test(f) || f.startsWith('id_') || DENY_NAME.test(f);
}

/** True if a repo-relative path is on the read denylist (secrets, credentials, keys, `.git`). */
export function isReadDenied(rel) {
  return foldPath(rel).some((f) => isGitLikeSegment(f) || deniedSegment(f));
}

/**
 * Resolve a model-supplied relative path to an absolute path inside `root`. Fails closed: any unexpected
 * error refuses. Checked on BOTH the lexical path and the real path (symlinks followed, canonical case):
 *  - rejects absolute paths, `..`, NUL, backslash, a leading `~`, symlink escapes, dangling links;
 *  - rejects every `.git`-like segment (any case, trailing dot/space, `.git~1`, unicode-ignorable chars);
 *  - reads: also rejects the read denylist (secrets, keys, .env*, ...), non-regular files are left to the caller;
 *  - writes: also rejects locked paths (case-insensitive, NFC/NFD folded, via realpath too) and paths outside
 *    the grant's allowed prefixes; the target itself must not be a symlink;
 *  - `allowRoot` (listing only, never with `write`) lets `.`, `./` or an empty path name the worktree root itself.
 */
export function confine(root, userPath, { write = false, allowedPaths = ['.'], allowRoot = false } = {}) {
  try {
    return confineInner(root, userPath, { write, allowedPaths, allowRoot });
  } catch (err) {
    if (err instanceof ConfineError) throw err;
    throw new ConfineError('path check failed; refusing (fail closed)', true);
  }
}

function confineInner(root, userPath, { write, allowedPaths, allowRoot }) {
  if (typeof userPath !== 'string' || (!userPath && !(allowRoot && !write))) throw new ConfineError('path must be a non-empty string');
  if (userPath.includes('\0') || userPath.includes('\\')) throw new ConfineError('path contains forbidden characters');
  if (isAbsolute(userPath) || /^[A-Za-z]:/.test(userPath)) throw new ConfineError('absolute paths are not allowed');
  if (userPath.split('/').includes('..')) throw new ConfineError('".." segments are not allowed');
  if (userPath.split('/')[0] === '~' || userPath.startsWith('~')) throw new ConfineError('home-relative paths are not allowed');
  const rel = norm(userPath);
  if (!rel && allowRoot && !write) return { abs: realpathSync.native(root), rel: '', real_rel: '' };
  if (!rel) throw new ConfineError('path must name a file or directory inside the worktree');
  if (foldPath(rel).some(isGitLikeSegment)) throw new ConfineError(`path "${rel}" touches git internals`, write);

  const realRoot = realpathSync.native(root);
  const abs = resolve(realRoot, rel);
  // Walk to the deepest existing ancestor; it must resolve inside the real root.
  let probe = abs;
  while (!existsSync(probe) && !isLink(probe)) probe = dirname(probe);
  let realProbe;
  try { realProbe = realpathSync.native(probe); } catch { throw new ConfineError('unresolvable path or dangling symlink'); }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new ConfineError('path escapes the worktree (symlink)');
  if (isLink(abs)) {
    const real = existsSync(abs) ? realpathSync.native(abs) : null;
    if (write || real === null || (real !== realRoot && !real.startsWith(realRoot + sep))) throw new ConfineError('symlinks are not allowed');
  }
  if (relative(realRoot, abs).startsWith('..')) throw new ConfineError('path escapes the worktree');

  // Real path relative to root: the deepest existing ancestor with symlinks and case canonicalised, plus the not-yet-existing tail.
  const realRel = norm(relative(realRoot, resolve(realProbe, relative(probe, abs))).split(sep).join('/'));
  if (realRel.startsWith('..')) throw new ConfineError('path escapes the worktree');
  const forms = [rel, realRel].filter(Boolean);
  if (forms.some((f) => foldPath(f).some(isGitLikeSegment))) throw new ConfineError(`path "${rel}" touches git internals`, write);

  if (!write) {
    if (forms.some(isReadDenied)) throw new ConfineError(`path "${rel}" is on the read denylist (secrets, credentials, keys)`);
  } else {
    const locked = lockedList(realRoot);
    if (forms.some((f) => isLockedPath(f, locked))) throw new ConfineError(`path "${rel}" is locked`, true);
    const ok = forms.every((f) => allowedPaths.some((p) => { const n = norm(p).normalize('NFC'); return n === '' || n === '*' || n === '**' || isUnder(f.normalize('NFC'), n); }));
    if (!ok) throw new ConfineError(`path "${rel}" is outside the grant's allowed paths`, true);
  }
  return { abs, rel, real_rel: realRel };
}

/** A rename or move writes two places: both ends must pass the full write check. Fail closed. */
export function confineMove(root, from, to, opts = {}) {
  const a = confine(root, from, { ...opts, write: true });
  const b = confine(root, to, { ...opts, write: true });
  return { from: a, to: b };
}
