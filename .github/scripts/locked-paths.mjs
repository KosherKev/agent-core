import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseLocked(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// ---- Matching: compare paths the way the machines that check them out do. ----------------------------
// Git records paths byte for byte, but macOS (APFS, HFS+) and Windows (NTFS) compare names without regard to
// case, ignore some invisible characters, drop trailing dots and spaces, and treat a backslash as a separator.
// On those disks `ACCEPTANCE/x` IS `acceptance/x`: a path that is "different" to git lands on the locked file
// once checked out. So every comparison here is made on folded segments. Over-matching is the safe direction.

// Zero-width, bidi and soft-hyphen characters that some filesystems ignore when comparing names.
const IGNORABLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** One path segment, folded the way a case-insensitive, normalisation-insensitive filesystem compares it. */
export function foldSegment(s) {
  // Case goes through upper case and back, so the long s, the sharp s and the Kelvin sign fold as they do on disk.
  return s.normalize('NFD').replace(IGNORABLE, '').normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}
// Trailing dots and spaces are dropped (Windows). A ":" starts an NTFS alternate data stream (`.github::$INDEX_ALLOCATION`).
const fold = (seg) => foldSegment(seg.split(':')[0]).replace(/[. ]+$/, '');

/** A path as folded segments. A backslash separates segments, as it does on Windows. */
export function foldPath(p) {
  return p.split(/[\\/]/).filter((s) => s && s !== '.').map(fold);
}

/** `.git` and every spelling a filesystem could resolve to it, plus `.gitmodules` and `.gitattributes`. */
export function isGitLikeSegment(seg) {
  const f = fold(seg);
  return f === '.git' || f === '.gitmodules' || f === '.gitattributes' || /^\.git~\d*/.test(f) || /^git~\d+$/.test(f);
}

function underFolded(segs, entry) {
  const e = foldPath(entry);
  return e.length > 0 && e.length <= segs.length && e.every((s, i) => s === segs[i]);
}

/**
 * Is this repo-relative path locked? True for anything at or under a locked entry (case, unicode, invisible
 * characters, trailing dots and spaces, backslashes all folded), for every `.git`-like segment anywhere, and for
 * a file named CODEOWNERS anywhere. An entry ending in "/" locks that directory; an entry without it locks
 * that path and anything under it.
 */
export function isLocked(file, locked) {
  const segs = foldPath(file);
  if (segs.some(isGitLikeSegment)) return true;
  if (segs.length && segs[segs.length - 1] === 'codeowners') return true;
  return locked.some((p) => underFolded(segs, p));
}

/** Returns the list of changed files that sit on locked paths. */
export function violations(changedFiles, locked) {
  return changedFiles.filter((f) => isLocked(f, locked));
}

/** Parse NUL-separated `git diff --name-only -z` output into a path list. */
export function parseNameZ(out) {
  return out.split('\0').filter(Boolean);
}

const SYMLINK = '120000';
const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])$/;

/**
 * Parse `git diff --raw -z --no-renames` output into entries. Throws on anything unexpected
 * (the guard must fail closed rather than guess).
 */
export function parseRawZ(out) {
  const tok = out.split('\0');
  if (tok.length && tok[tok.length - 1] === '') tok.pop();
  if (tok.length % 2 !== 0) throw new Error('unexpected git output: odd token count');
  const entries = [];
  for (let i = 0; i < tok.length; i += 2) {
    const m = RAW.exec(tok[i]);
    if (!m) throw new Error(`unexpected git output: ${JSON.stringify(tok[i].slice(0, 80))}`);
    if (!tok[i + 1]) throw new Error('unexpected git output: empty path');
    entries.push({ oldMode: m[1], newMode: m[2], oldSha: m[3], newSha: m[4], status: m[5], path: tok[i + 1] });
  }
  return entries;
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/** Raw entries between base and head. --no-renames reports a rename as delete + add, so BOTH ends appear. */
export function rawChanges(base, head) {
  return parseRawZ(git(['diff', '--raw', '--no-abbrev', '-z', '--no-renames', `${base}...${head}`, '--']));
}

/** Changed paths between base and head (kept for callers that only need names). */
export function changedPaths(base, head) {
  return rawChanges(base, head).map((e) => e.path);
}

/**
 * Resolve `path` inside `tree` following every symlink (parent components and the final one),
 * lexically within the repo. Throws if a link is absolute, escapes the repo, loops, or cannot be read.
 */
export function realPathInTree(tree, path, readEntry = lsTreeEntry) {
  let pending = path.split('/');
  let resolved = [];
  let hops = 0;
  while (pending.length) {
    const part = pending.shift();
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) throw new Error(`cannot resolve ${path}: escapes the repository`);
      resolved.pop();
      continue;
    }
    const cand = [...resolved, part].join('/');
    const ent = readEntry(tree, cand);
    if (ent && ent.mode === SYMLINK) {
      if (++hops > 40) throw new Error(`cannot resolve ${path}: too many symlinks`);
      const target = ent.target;
      if (!target || target.startsWith('/')) throw new Error(`cannot resolve ${path}: absolute or empty symlink target`);
      pending = [...target.split('/'), ...pending];
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

function lsTreeEntry(tree, path) {
  const out = git(['ls-tree', '-z', tree, '--', path]);
  if (!out) return null;
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)\0$/s.exec(out);
  if (!m) throw new Error(`unexpected git output from ls-tree for ${path}`);
  if (m[4] !== path) return null;
  const mode = m[1];
  return { mode, target: mode === SYMLINK ? git(['cat-file', 'blob', m[3]]) : undefined };
}

/**
 * Every changed locked path, including: any path at or under a locked path (a symlink there, in any
 * direction: add, change, type change or removal, is just a change at that path), and any changed
 * path or symlink target whose REAL path lands inside a locked path.
 */
export function lockedViolations(entries, locked, headTree, baseTree, readEntry) {
  const bad = new Set();
  for (const e of entries) {
    if (isLocked(e.path, locked)) { bad.add(e.path); continue; }
    const tree = e.newMode === '000000' ? baseTree : headTree;
    // The changed path itself, with any symlinked parent directories resolved.
    const real = realPathInTree(tree, e.path, readEntry);
    if (isLocked(real, locked)) { bad.add(`${e.path} (resolves to ${real})`); continue; }
    // A symlink entry: its own target must not land in a locked path.
    const symSha = e.newMode === SYMLINK ? e.newSha : e.oldMode === SYMLINK ? e.oldSha : null;
    if (symSha) {
      const target = git(['cat-file', 'blob', symSha]);
      if (!target || target.startsWith('/')) throw new Error(`cannot resolve symlink ${e.path}: absolute or empty target`);
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
      const realTarget = realPathInTree(tree, `${dir}/${target}`, readEntry);
      if (isLocked(realTarget, locked) || isLocked(realTarget + '/', locked)) bad.add(`${e.path} (symlink into ${realTarget})`);
    }
  }
  return [...bad];
}

// CLI: node locked-paths.mjs <base-sha> <head-sha>
// Any change to a locked path fails, whoever authored it. The human exception is a manual merge by the owner.
// Fail closed: any error, unexpected git output or unresolvable path exits non-zero, never 0.
function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) { console.error('usage: locked-paths.mjs <base> <head>'); return 2; }
  for (const ref of [base, head]) {
    if (!/^[0-9a-fA-F]{7,64}$/.test(ref)) { console.error(`locked-paths guard FAILED CLOSED: not a commit SHA: ${JSON.stringify(ref)}`); return 2; }
  }
  try {
    const locked = parseLocked(readFileSync(new URL('../locked-paths.txt', import.meta.url), 'utf8'));
    if (!locked.length) throw new Error('locked-paths.txt lists no paths');
    const bad = lockedViolations(rawChanges(base, head), locked, head, base);
    if (bad.length) {
      console.error('Change touches locked paths (R4):\n' + bad.map((f) => `  ${f}`).join('\n'));
      return 1;
    }
    console.log('no locked paths touched');
    return 0;
  } catch (err) {
    console.error(`locked-paths guard FAILED CLOSED: ${err.message}`);
    return 2;
  }
}
// Compare real paths: argv[1] may be a symlink (or sit under one), import.meta.url never is. A plain string
// compare silently skipped main() and exited 0. If the check itself errors, run main() anyway (fail closed).
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return true; }
}
if (isEntryPoint()) process.exit(main());
