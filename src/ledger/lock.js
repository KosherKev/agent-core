import { mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { LedgerError } from './format.js';
import { writeAll, fsyncDir, realIo } from './durable.js';

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const readOwner = (lockPath) => { try { return JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')); } catch { return null; } };

const clearCommand = (lockPath) => `rm -r '${String(lockPath).replace(/'/g, `'\\''`)}'`;

/**
 * Exclusive lock = a directory that appears atomically with its owner file already inside (built in a temp dir, then renamed
 * into place; rename onto an existing non-empty directory fails, so at most one process can ever create it).
 *
 * This code NEVER breaks a lock that exists. A lock whose owner pid is dead is refused at once with the exact command an
 * operator runs to clear it. Why: any automatic takeover needs a check-then-act on the lock (read owner, decide, remove), and
 * with three or more racing processes a second process can remove the lock a first process has just taken over, leaving two
 * holders and a forked hash chain. With no takeover there is no such step to race. The price is that a crashed holder needs a
 * human; that is the restrictive choice.
 * Waits a bounded time for a live holder. Any timeout or error throws (refuse).
 */
export function acquireLock(lockPath, { now = Date.now, timeoutMs = 5000, pollMs = 10, pidAlive = defaultPidAlive, io = realIo } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tmp;
    try {
      tmp = mkdtempSync(`${lockPath}.t-`);
      const fd = openSync(join(tmp, 'owner.json'), 'wx', 0o600);
      try { writeAll(fd, JSON.stringify({ pid: process.pid, at_ms: now(), token: randomBytes(8).toString('hex') }), io); io.fsyncSync(fd); } finally { closeSync(fd); }
      fsyncDir(tmp, io); // the owner file's entry is durable before the lock can appear
      renameSync(tmp, lockPath);
      tmp = undefined; // it is the lock now; the cleanup below must not touch it
      // Release by renaming away first (atomic), then deleting: deleting in place could remove a successor's fresh lock.
      const release = () => {
        const gone = `${lockPath}.rel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try { renameSync(lockPath, gone); rmSync(gone, { recursive: true, force: true }); } catch { /* the lock stays; the next caller refuses with instructions */ }
      };
      try { fsyncDir(dirname(lockPath), io); } catch (e) { release(); throw e; } // the lock's own entry is durable too
      return release;
    } catch (err) {
      if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
      if (err instanceof LedgerError) throw err;
      if (!['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw new LedgerError('ledger', `ledger lock error (${err.code ?? 'unknown'}); refusing`);
    }
    const owner = readOwner(lockPath);
    if (owner && Number.isSafeInteger(owner.pid) && !pidAlive(owner.pid)) {
      throw new LedgerError('ledger', `ledger lock ${lockPath} is held by pid ${owner.pid}, which is no longer running (a crashed run). It is NOT broken automatically. If no agent run is using this ledger, clear it by hand with: ${clearCommand(lockPath)}; refusing`);
    }
    if (Date.now() >= deadline) throw new LedgerError('ledger', `ledger lock timeout on ${lockPath}; refusing`);
    sleepSync(pollMs);
  }
}
