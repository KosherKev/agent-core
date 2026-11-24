import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Small OS lookups with no network: group name to gid, and what is running under a pid.
 * Both return null when they cannot answer, and callers treat null as a failure (fail closed).
 */

/** A group name or an integer gid to a gid. Reads /etc/group first (Linux), then asks the directory service on macOS. */
export function resolveGroup(group) {
  if (Number.isSafeInteger(group) && group >= 0) return group;
  if (typeof group !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(group)) return null;
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const c = line.split(':');
      if (c[0] === group && /^\d+$/.test(c[2] ?? '')) return Number(c[2]);
    }
  } catch { /* no /etc/group: try the directory service */ }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('dscl', ['.', '-read', `/Groups/${group}`, 'PrimaryGroupID'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /PrimaryGroupID:\s*(\d+)/.exec(out);
      if (m) return Number(m[1]);
    } catch { /* unknown group */ }
  }
  return null;
}

/** A user name to a uid, from /etc/passwd, then `id -u`. null when unknown (callers fail closed). */
export function resolveUser(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(name)) return null;
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const c = line.split(':');
      if (c[0] === name && /^\d+$/.test(c[2] ?? '')) return Number(c[2]);
    }
  } catch { /* no /etc/passwd: ask `id` */ }
  try { // the system's own answer (covers directory-service users); `id -u` prints only the number
    const out = execFileSync('id', ['-u', name], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^\d+$/.test(out)) return Number(out);
  } catch { /* unknown user */ }
  return null;
}

/** { pid, uid, cmdline } of a live process, or null (not running, or cannot be read). cmdline arguments are joined with single spaces. */
export function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); } catch (e) { if (e?.code !== 'EPERM') return null; }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const u = /^Uid:\s+(\d+)/m.exec(status);
    return { pid, uid: u ? Number(u[1]) : null, cmdline: raw.split('\0').filter(Boolean).join(' ') };
  } catch { /* not Linux, or /proc hidden: fall back to ps */ }
  try {
    const out = execFileSync('ps', ['-o', 'uid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /^(\d+)\s+(.*)$/.exec(out);
    return m ? { pid, uid: Number(m[1]), cmdline: m[2] } : null;
  } catch { return null; }
}

/** Does this command line look like `.../agent gateway` (the gateway process started by bin/agent)? */
export function isGatewayCmdline(cmdline) {
  if (typeof cmdline !== 'string') return false;
  const t = cmdline.split(/\s+/);
  const i = t.findIndex((x) => /(^|\/)agent$/.test(x));
  return i >= 0 && t[i + 1] === 'gateway';
}
