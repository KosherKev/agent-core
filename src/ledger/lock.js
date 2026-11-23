import { mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { LedgerError } from './format.js';
import { writeAll, fsyncDir, realIo } from './durable.js';

// Atomics.wait on a private buffer nobody notifies: a real sleep (no CPU spin). It blocks this thread, which is deliberate: the
// ledger API is synchronous (the meter calls it synchronously), so the wait cannot yield; it is bounded by timeoutMs.
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(WAIT_CELL, 0, 0, ms); };

export function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Look at a lock's owner file. Never throws. kind: ok | missing | unreadable | corrupt. */
function inspectOwner(lockPath) {
  let raw;
  try { raw = readFileSync(join(lockPath, 'owner.json'), 'utf8'); } catch (e) { return { kind: e?.code === 'ENOENT' ? 'missing' : 'unreadable', detail: e?.code ?? 'error' }; }
  let o;
  try { o = JSON.parse(raw); } catch { return { kind: 'corrupt' }; }
  if (!o || typeof o !== 'object' || !Number.isSafeInteger(o.pid) || o.pid < 1 || !Number.isFinite(o.at_ms)) return { kind: 'corrupt' };
  return { kind: 'ok', owner: o };
}
const identity = (lockPath) => { try { const st = lstatSync(lockPath); return `${st.dev}:${st.ino}:${st.birthtimeMs}`; } catch { return null; } };

/**
 * Examine the existing lock. Returns { kind: 'gone' } if it vanished or was replaced while looking (caller just retries), or the
 * owner inspection. A missing/corrupt owner is only reported if the SAME lock directory (same identity before and after the read)
 * shows it three times in a row, so the instant a lock is being released and re-taken by others is never mistaken for a bad lock.
 */
function examine(lockPath, pollMs) {
  for (let bad = 0; ; bad += 1) {
    const before = identity(lockPath);
    if (before === null) return { kind: 'gone' };
    const seen = inspectOwner(lockPath);
    if (identity(lockPath) !== before) return { kind: 'gone' };
    if (seen.kind === 'ok' || bad >= 2) return seen;
    sleepSync(Math.max(pollMs, 5));
  }
}

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
 * A lock with a missing, unreadable or corrupt owner file, or held by a live pid for longer than maxAgeMs, is refused the same way
 * (message names the lock path and the exact command to clear it by hand).
 * Waits a bounded time for a live holder. Any timeout or error throws (refuse).
 */
export function acquireLock(lockPath, { now = Date.now, timeoutMs = 5000, pollMs = 10, maxAgeMs = 300_000, pidAlive = defaultPidAlive, io = realIo } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tmp;
    const token = randomBytes(8).toString('hex');
    try {
      tmp = mkdtempSync(`${lockPath}.t-`);
      const fd = openSync(join(tmp, 'owner.json'), 'wx', 0o600);
      try { writeAll(fd, JSON.stringify({ pid: process.pid, at_ms: now(), token }), io); io.fsyncSync(fd); } finally { closeSync(fd); }
      fsyncDir(tmp, io); // the owner file's entry is durable before the lock can appear
      renameSync(tmp, lockPath);
      tmp = undefined; // it is the lock now; the cleanup below must not touch it
      // Release: check the owner token is still ours, rename the lock directory away (atomic), then delete the renamed copy.
      // PROTECTED: the delete can never hit a directory a successor creates at lockPath afterwards (it works on the renamed copy),
      // and a lock that is no longer ours (cleared by hand and re-taken) is left alone because the token no longer matches.
      // NOT PROTECTED: between the token check and the rename there is a window of microseconds in which a hand-cleared lock
      // re-taken by someone else would be moved aside by mistake; and a crash before release leaves the lock in place (the next
      // caller then refuses with instructions, it is never broken). Neither can happen without a manual clear or a crash.
      const release = () => {
        const mine = inspectOwner(lockPath);
        if (mine.kind !== 'ok' || mine.owner.token !== token) return;
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
    // A lock exists. Never break it; only decide between waiting and refusing with instructions.
    const seen = examine(lockPath, pollMs);
    if (seen.kind === 'gone') continue; // released or replaced while looking: try to take it
    if (seen.kind !== 'ok') {
      const why = { missing: 'has no owner.json', unreadable: `has an unreadable owner.json (${seen.detail})`, corrupt: 'has a corrupt owner.json' }[seen.kind];
      throw new LedgerError('ledger', `ledger lock ${lockPath} ${why}, so its holder cannot be identified. It is NOT broken automatically. If no agent run is using this ledger, clear it by hand with: ${clearCommand(lockPath)}; refusing`);
    }
    const { owner } = seen;
    if (!pidAlive(owner.pid)) {
      throw new LedgerError('ledger', `ledger lock ${lockPath} is held by pid ${owner.pid}, which is no longer running (a crashed run). It is NOT broken automatically. If no agent run is using this ledger, clear it by hand with: ${clearCommand(lockPath)}; refusing`);
    }
    const heldMs = now() - owner.at_ms;
    if (heldMs > maxAgeMs) {
      throw new LedgerError('ledger', `ledger lock ${lockPath} has been held by live pid ${owner.pid} for ${Math.round(heldMs / 1000)}s, longer than the ${Math.round(maxAgeMs / 1000)}s maximum (a hung run, or the pid was reused by another program). It is NOT broken automatically. Check that pid ${owner.pid} is really an agent run (ps -p ${owner.pid}); if it is hung, stop it, then clear the lock by hand with: ${clearCommand(lockPath)}; refusing`);
    }
    if (Date.now() >= deadline) throw new LedgerError('ledger', `ledger lock timeout on ${lockPath}; refusing`);
    sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now()))); // never sleep past the deadline
  }
}
