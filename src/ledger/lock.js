import { mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerError } from './format.js';

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const readOwner = (lockPath) => { try { return JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')); } catch { return null; } };

/**
 * Exclusive lock = a directory that appears atomically with its owner file already inside (built in a temp dir, then renamed
 * into place; rename onto an existing non-empty directory fails). Waits a bounded time. Breaks a lock only if its owner pid is
 * dead AND the lock is older than staleMs; a live pid's lock is never broken. Any timeout or error throws (refuse).
 */
export function acquireLock(lockPath, { now = Date.now, timeoutMs = 5000, staleMs = 30000, pollMs = 10, pidAlive = defaultPidAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tmp;
    try {
      tmp = mkdtempSync(`${lockPath}.t-`);
      writeFileSync(join(tmp, 'owner.json'), JSON.stringify({ pid: process.pid, at_ms: now() }), { mode: 0o600 });
      renameSync(tmp, lockPath);
      // Release by renaming away first (atomic), then deleting: deleting in place could remove a successor's fresh lock.
      return () => {
        const gone = `${lockPath}.rel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try { renameSync(lockPath, gone); rmSync(gone, { recursive: true, force: true }); } catch { /* a stale lock would be recovered later or refused */ }
      };
    } catch (err) {
      if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
      if (!['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw new LedgerError('ledger', `ledger lock error (${err.code ?? 'unknown'}); refusing`);
    }
    const owner = readOwner(lockPath);
    if (owner && Number.isSafeInteger(owner.pid) && Number.isFinite(owner.at_ms) && !pidAlive(owner.pid) && now() - owner.at_ms > staleMs) {
      // Break it atomically (rename away), then confirm we moved the very lock we examined.
      const aside = `${lockPath}.broken-${process.pid}-${Date.now()}`;
      try {
        renameSync(lockPath, aside);
        const moved = readOwner(aside);
        if (moved && moved.pid === owner.pid && moved.at_ms === owner.at_ms) { rmSync(aside, { recursive: true, force: true }); continue; }
        // We moved someone else's fresh lock: put it back if we can, then refuse rather than guess.
        try { renameSync(aside, lockPath); } catch { /* lost the race; the lock holder will fail closed on its own */ }
        throw new LedgerError('ledger', 'ledger lock changed while recovering a stale lock; refusing');
      } catch (err) {
        if (err instanceof LedgerError) throw err;
        // ENOENT etc: another process broke or released it first; just retry.
      }
    }
    if (Date.now() >= deadline) throw new LedgerError('ledger', 'ledger lock timeout; refusing');
    sleepSync(pollMs);
  }
}
