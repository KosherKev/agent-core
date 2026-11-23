import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseLocked(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function isLocked(file, locked) {
  return locked.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** Returns the list of changed files that sit on locked paths. */
export function violations(changedFiles, locked) {
  return changedFiles.filter((f) => isLocked(f, locked));
}

/** Parse NUL-separated `git diff --name-only -z` output into a path list. */
export function parseNameZ(out) {
  return out.split('\0').filter(Boolean);
}

/**
 * Changed paths between base and head. --no-renames reports a rename as a delete of the
 * old path plus an add of the new one, so BOTH ends are checked. -z avoids path quoting.
 */
export function changedPaths(base, head) {
  const out = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`, '--'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return parseNameZ(out);
}

// CLI: node locked-paths.mjs <base-sha> <head-sha>
// Any change to a locked path fails, whoever authored it. The human exception is a manual merge by the owner.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) { console.error('usage: locked-paths.mjs <base> <head>'); process.exit(2); }
  const locked = parseLocked(readFileSync(new URL('../locked-paths.txt', import.meta.url), 'utf8'));
  const bad = violations(changedPaths(base, head), locked);
  if (bad.length) {
    console.error('Change touches locked paths (R4):\n' + bad.map((f) => `  ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('no locked paths touched');
}
