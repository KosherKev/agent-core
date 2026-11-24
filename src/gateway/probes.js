import { statSync, readFileSync, readdirSync, readlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { REPO_ROOT } from '../self-model.js';
import { canConnect } from './client.js';
import { peerAllowed } from './server.js';

/**
 * Would `uid` be able to read this file by its owner/mode bits? Group membership of the runner is unknown here, so any group or
 * other read bit counts as readable (restrictive). root (uid 0) can always read. A missing file is "not readable" (nothing to leak).
 */
export function modeAllowsRead(st, uid) {
  if (uid === 0) return true;
  if (st.uid === uid) return (st.mode & 0o400) !== 0;
  return (st.mode & 0o044) !== 0;
}

/** Real probes. Doctor takes the same shape, so tests inject fakes for each. */
export function realProbes() {
  return {
    stat(path) { try { const s = statSync(path); return { mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, isSocket: s.isSocket(), isDir: s.isDirectory() }; } catch { return null; } },
    canRead(path, uid) { try { return modeAllowsRead(statSync(path), uid); } catch { return false; } },
    connect: (socketPath) => canConnect(socketPath),
    peerAllowed,
    readPid(path) { try { const n = Number(readFileSync(path, 'utf8').trim()); return Number.isSafeInteger(n) && n > 0 ? n : null; } catch { return null; } },
    /** TCP listening sockets owned by the pid: an array, or null when it cannot be determined (doctor then fails closed). */
    tcpListeners(pid) { return tcpListeners(pid); },
    lockedChecksum: () => lockedChecksum(REPO_ROOT),
  };
}

function tcpListeners(pid) {
  if (existsSync('/proc/net/tcp') && existsSync(`/proc/${pid}/fd`)) {
    try {
      const inodes = new Set();
      for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { const l = readlinkSync(`/proc/${pid}/fd/${fd}`); const m = /^socket:\[(\d+)\]$/.exec(l); if (m) inodes.add(m[1]); } catch { /* fd closed */ } }
      const found = [];
      for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
          const c = line.trim().split(/\s+/);
          if (c.length > 9 && c[3] === '0A' && inodes.has(c[9])) found.push(c[1]);
        }
      }
      return found;
    } catch { return null; }
  }
  return new Promise((res) => {
    execFile('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 5000 }, (err, out) => {
      if (err && err.code !== 1) return res(null); // lsof exits 1 when nothing matches
      res(String(out).split('\n').filter((l) => l.startsWith('n')));
    });
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
