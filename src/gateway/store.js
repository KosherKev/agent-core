import { openLedger, buildReport, acquireLock } from '../ledger/index.js';

/**
 * Ledger store interface (callers use ONLY this, so a different store can replace the file ledger later):
 *   append(grant, runId) -> run handle   register a run on a grant; the handle appends reserve/settle/release/run_end
 *   read(grant)          -> summary      read-only remaining numbers for the grant (integers, micro-USD)
 *   lock(name, fn)       -> fn's result  run fn while holding an exclusive named lock (fail closed on timeout)
 *   report()             -> { lines, failed }
 *   meterLedger()        -> { openRun }  the shape src/grant's meter expects (same as append)
 * One implementation: the existing hash-chained file ledger, wrapped unchanged.
 */
export function createFileLedgerStore(dir, opts = {}) {
  const ledger = openLedger(dir, opts);
  const lockOpts = { now: opts.now, timeoutMs: opts.lockTimeoutMs, maxAgeMs: opts.lockMaxAgeMs, pollMs: opts.lockPollMs, pidAlive: opts.pidAlive };
  for (const k of Object.keys(lockOpts)) if (lockOpts[k] === undefined) delete lockOpts[k];
  const store = {
    kind: 'file-ledger',
    dir: ledger.dir,
    append: (grant, runId) => ledger.openRun(grant, runId),
    read: (grant) => ledger.remaining(grant),
    lock(name, fn) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new RangeError('lock name is invalid');
      const release = acquireLock(`${ledger.dir}/.gateway-${name}.lock`, lockOpts);
      try { return fn(); } finally { release(); }
    },
    report: () => buildReport(ledger.dir),
    meterLedger: () => ({ openRun: (grant, runId) => ledger.openRun(grant, runId) }),
  };
  return Object.freeze(store);
}
