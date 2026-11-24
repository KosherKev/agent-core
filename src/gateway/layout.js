import { lstatSync, readlinkSync, mkdirSync, chownSync, chmodSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { resolveGroup } from './sys.js';

/** The ownership and modes that make the Unix socket the only way in. The kernel enforces them, not this code. */
export const MODES = Object.freeze({ home: 0o700, socketDir: 0o750, socket: 0o660 });
const oct = (m) => (m & 0o7777).toString(8).padStart(3, '0');

/** lstat as { ok, mode, uid, gid, type } or { ok:false, code } (ENOENT, EACCES, ...). Symlinks are reported as 'link', never followed. */
export function realStat(path) {
  try {
    const s = lstatSync(path);
    return { ok: true, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isSocket() ? 'socket' : s.isFile() ? 'file' : 'other' };
  } catch (e) { return { ok: false, code: e?.code ?? 'ERR' }; }
}

/**
 * The platform's well-known root-level system symlinks that are allowed on a trust path. ONLY these, ONLY at the top of the filesystem,
 * ONLY when the link is owned by root and points exactly at the listed target. macOS keeps /var (and /tmp, /etc) under /private; only /var is
 * needed (the default socket_dir is /var/run/agent-gateway and temp dirs live under /var/folders). Linux has none: any symlink fails.
 * Stricter alternative considered and rejected: requiring the configured path to equal its realpath would refuse every /var/... path on
 * macOS, including the documented setup, so the explicit list is the strictest option that still works.
 */
export const SYSTEM_SYMLINKS = Object.freeze({ darwin: Object.freeze({ '/var': 'private/var' }) });

/**
 * Walk every component of an absolute path from the filesystem root with lstat (never following) and report the first symbolic link
 * that is not an allowed system symlink. Returns { ok:true, link:null } when the whole path is plain, { ok:true, link, target } for the
 * first offending component, or { ok:false, code, at } when a component cannot be inspected (callers fail closed).
 */
export function findSymlinkComponent(path, { lstat = lstatSync, readlink = readlinkSync, platform = process.platform } = {}) {
  if (typeof path !== 'string' || !path.startsWith(sep)) return { ok: false, code: 'NOT_ABSOLUTE', at: String(path).slice(0, 100) };
  const parts = resolve(path).split(sep).filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += sep + part;
    let st;
    try { st = lstat(cur); } catch (e) { return { ok: false, code: e?.code ?? 'ERR', at: cur }; }
    if (!st.isSymbolicLink()) continue;
    let target = null; try { target = readlink(cur); } catch { target = null; }
    const allowed = SYSTEM_SYMLINKS[platform]?.[cur];
    if (allowed !== undefined && st.uid === 0 && target === allowed) continue;
    return { ok: true, link: cur, target };
  }
  return { ok: true, link: null };
}

const f = (v) => (v === undefined || v === null ? 'not reported' : v);
const miss = (what, st) => ({ why: `${what} cannot be inspected (${st?.code ?? 'no reason given'})`, fix: `check that ${what} exists and is reachable` });

/** Each function returns an array of { why, fix }: empty means the item is exactly as required. */
export function homeProblems(st, home, gatewayUid, { deniedOk = false } = {}) {
  if (!st.ok) return deniedOk && (st.code === 'EACCES' || st.code === 'EPERM') ? [] : [miss('AGENT_HOME', st)];
  const out = [];
  if (st.type !== 'dir') out.push({ why: 'AGENT_HOME is not a plain directory', fix: `remove ${home} and run agent init as the gateway user` });
  if (st.uid !== gatewayUid) out.push({ why: `AGENT_HOME is owned by uid ${f(st.uid)}, the gateway uid is ${gatewayUid}`, fix: `chown ${gatewayUid} ${home}  (run as root)` });
  if ((st.mode & 0o777) !== MODES.home) out.push({ why: `AGENT_HOME mode is ${oct(st.mode)}, it must be 700 (no group or other access at all)`, fix: `chmod 700 ${home}  (run as the gateway user)` });
  return out;
}

export function configFileProblems(st, file, gatewayUid, { deniedOk = false } = {}) {
  if (!st.ok) return deniedOk && (st.code === 'EACCES' || st.code === 'EPERM') ? [] : [miss('config.json', st)];
  const out = [];
  if (st.type !== 'file') out.push({ why: 'config.json is not a regular file', fix: `replace ${file} with a regular file owned by the gateway user` });
  if (st.uid !== gatewayUid) out.push({ why: `config.json is owned by uid ${f(st.uid)}, the gateway uid is ${gatewayUid}`, fix: `chown ${gatewayUid} ${file}  (run as root)` });
  if ((st.mode & 0o022) !== 0) out.push({ why: `config.json mode is ${oct(st.mode)}: group or other can write it`, fix: `chmod 600 ${file}  (run as the gateway user)` });
  return out;
}

export function socketDirProblems(st, dir, gatewayUid, runnerGid) {
  if (!st.ok) return [miss('socket_dir', st)];
  const out = [];
  if (st.type !== 'dir') out.push({ why: 'socket_dir is not a plain directory', fix: `remove ${dir} and create it as a directory (see docs/gateway.md)` });
  if (st.uid !== gatewayUid) out.push({ why: `socket_dir is owned by uid ${f(st.uid)}, the gateway uid is ${gatewayUid}`, fix: `chown ${gatewayUid}:<runner_group> ${dir}  (run as root)` });
  if (runnerGid === null || runnerGid === undefined) out.push({ why: 'runner_group does not resolve to a gid', fix: 'create the runner group or fix runner_group in config.json' });
  else if (st.gid !== runnerGid) out.push({ why: `socket_dir group is gid ${f(st.gid)}, runner_group is gid ${runnerGid}`, fix: `chgrp <runner_group> ${dir}  (run as root)` });
  if ((st.mode & 0o777) !== MODES.socketDir) out.push({ why: `socket_dir mode is ${oct(st.mode)}, it must be 750 (runner group can traverse, not create or delete)`, fix: `chmod 750 ${dir}  (run as the gateway user)` });
  return out;
}

export function socketProblems(st, path, gatewayUid, runnerGid) {
  if (!st.ok) return [miss('the socket', st)];
  const out = [];
  if (st.type !== 'socket') out.push({ why: 'socket path is not a socket', fix: `remove ${path} and restart the gateway` });
  if (st.uid !== gatewayUid) out.push({ why: `socket owner is uid ${f(st.uid)}, the gateway uid is ${gatewayUid}`, fix: 'start the gateway under the gateway user' });
  if (runnerGid === null || runnerGid === undefined) out.push({ why: 'runner_group does not resolve to a gid', fix: 'create the runner group or fix runner_group in config.json' });
  else if (st.gid !== runnerGid) out.push({ why: `socket group is gid ${f(st.gid)}, runner_group is gid ${runnerGid}`, fix: `chgrp <runner_group> ${path}  (run as the gateway user, who must be in that group)` });
  if ((st.mode & 0o777) !== MODES.socket) out.push({ why: `socket mode is ${oct(st.mode)}, it must be 660`, fix: `chmod 660 ${path}  (run as the gateway user)` });
  return out;
}

/**
 * The gateway's startup layout check: everything the gateway creates or relies on, verified before it listens.
 * deps are injectable for tests: { stat, getuid, mkdir, chown, chmod }. Creates socket_dir (750, group runner_group) only when it is missing.
 * Returns an array of reason strings; empty means the layout is exactly right.
 */
export function createLayoutChecker({ stat = realStat, getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1), mkdir = (p, m) => mkdirSync(p, { mode: m }), chown = chownSync, chmod = chmodSync } = {}) {
  return (config, { gid } = {}) => {
    const gw = config.identities.gateway_uid;
    const out = [];
    if (getuid() !== gw) return [`the gateway must run as uid ${gw} (it runs as uid ${getuid()}); refusing to listen`];
    if (gid === null || gid === undefined) return ['runner_group does not resolve to a gid; refusing to listen'];
    let sd = stat(config.socket_dir);
    if (!sd.ok && sd.code === 'ENOENT') {
      try { mkdir(config.socket_dir, MODES.socketDir); chown(config.socket_dir, gw, gid); chmod(config.socket_dir, MODES.socketDir); } catch (e) { return [`cannot create socket_dir (${e?.code ?? 'error'}); create it by hand as in docs/gateway.md`]; }
      sd = stat(config.socket_dir);
    }
    const all = [
      ...homeProblems(stat(config.home), config.home, gw),
      ...configFileProblems(stat(`${config.home}/config.json`), `${config.home}/config.json`, gw),
      ...socketDirProblems(sd, config.socket_dir, gw, gid),
    ];
    for (const p of all) out.push(p.why);
    return out;
  };
}

export const checkRealLayout = createLayoutChecker();
export { resolveGroup };
