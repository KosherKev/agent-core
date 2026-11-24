import { readFileSync, readdirSync, readlinkSync, existsSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { REPO_ROOT } from '../self-model.js';
import { request } from './client.js';
import { loadConfig } from './config.js';
import { realStat } from './layout.js';
import { resolveGroup, resolveUser, processInfo } from './sys.js';
import { readDiscovery } from './discovery.js';
import { runToolAsync } from './tools.js';

/** What one attempt at touching a protected path came to: 'denied' (the kernel said no), 'missing', 'allowed', or 'error:<code>'. */
const verdictOf = (e) => (e?.code === 'EACCES' || e?.code === 'EPERM' ? 'denied' : e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : `error:${e?.code ?? 'unknown'}`);

/** Real probes. Doctor takes this same shape, so tests inject a fake for each. Each does the real thing as the identity running doctor. */
export function realProbes({ pingTimeoutMs = 5000 } = {}) {
  return {
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    readConfig: (home) => loadConfig(home),
    stat: realStat,
    resolveGroup,
    resolveUser,
    /** The gateway's discovery file as a validated object, or null (missing, unreadable or malformed). */
    readDiscovery,
    /** The real handshake over the socket (through client.js). Rejects when the server refuses, closes or stays silent. */
    ping: (socketPath) => request(socketPath, 'ping', {}, { timeoutMs: pingTimeoutMs }),
    tryRead(path) { try { closeSync(openSync(path, 'r')); return 'allowed'; } catch (e) { return verdictOf(e); } },
    tryList(path) { try { readdirSync(path); return 'allowed'; } catch (e) { return verdictOf(e); } },
    tryCreate(dir) {
      const f = join(dir, `.doctor-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
      try { closeSync(openSync(f, 'wx', 0o600)); try { unlinkSync(f); } catch { /* best effort */ } return 'allowed'; } catch (e) { return verdictOf(e); }
    },
    readPid(path) { try { const n = Number(readFileSync(path, 'utf8').trim()); return Number.isSafeInteger(n) && n > 0 ? n : null; } catch { return null; } },
    processInfo,
    /** TCP listening sockets of the gateway: an array, or null when they cannot be determined (doctor then fails closed). */
    tcpListeners: (info, opts) => tcpListeners(info, opts),
    peerDecision: null, // no real peer-uid probe exists (Node has no SO_PEERCRED); a fake-driven test supplies one
    lockedChecksum: () => lockedChecksum(REPO_ROOT),
  };
}

const parseTcpTable = (text) => text.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 9 && c[3] === '0A');

/**
 * Linux: read the pid's socket inodes from /proc/<pid>/fd and match them against /proc/net/tcp*. When the fds are not readable
 * (doctor runs as another user) fall back to every listening socket owned by the gateway uid, which is stricter, never looser.
 * Elsewhere: lsof, which only sees processes of the same user (or root); otherwise null.
 */
function tcpListeners(info, { gatewayUid } = {}) {
  if (!info) return null;
  if (existsSync('/proc/net/tcp')) {
    const tables = ['/proc/net/tcp', '/proc/net/tcp6'].filter((f) => existsSync(f)).map((f) => parseTcpTable(readFileSync(f, 'utf8')));
    try {
      const inodes = new Set();
      for (const fd of readdirSync(`/proc/${info.pid}/fd`)) { try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${info.pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch { /* fd closed */ } }
      return tables.flat().filter((c) => inodes.has(c[9])).map((c) => c[1]);
    } catch { /* cannot read another user's fds */ }
    if (!Number.isSafeInteger(gatewayUid)) return null;
    return tables.flat().filter((c) => Number(c[7]) === gatewayUid).map((c) => c[1]);
  }
  const me = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (me !== 0 && info.uid !== me) return null; // lsof would show nothing for another user's process; that is not "no listeners"
  return runToolAsync('lsof', ['-nP', '-a', '-p', String(info.pid), '-iTCP', '-sTCP:LISTEN', '-Fn']).then(({ err, out }) => {
    if (err && err.code !== 1) return null; // lsof exits 1 when nothing matches; a refused tool or any other failure is "cannot tell" (doctor fails closed)
    return String(out).split('\n').filter((l) => l.startsWith('n'));
  });
}

/** sha256 over the listed locked paths: path names and file bytes in sorted order. Throws if the list is missing. */
export function lockedChecksum(root) {
  const list = readFileSync(join(root, '.github', 'locked-paths.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const files = [];
  const walk = (rel) => {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) walk(`${rel.replace(/\/$/, '')}/${n}`); } else files.push(rel);
  };
  for (const p of list) walk(p);
  const h = createHash('sha256');
  for (const f of [...new Set(files)].sort()) { h.update(f + '\0'); h.update(readFileSync(join(root, f))); h.update('\0'); }
  return { sha256: h.digest('hex'), files: new Set(files).size };
}
