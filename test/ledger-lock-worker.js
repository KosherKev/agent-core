// Child process for the lock race tests. Per iteration: wait for the parent's go file, then race for the lock.
//   mode "cs":     acquireLock directly, with a critical section that detects any concurrent entry (mkdir of a marker dir).
//   mode "ledger": a real ledger append (openRun) under the ledger's own lock.
// argv: syncDir ledgerDir mode workerId iterations lockTimeoutMs grantJson
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from '../src/ledger/lock.js';
import { openLedger } from '../src/ledger/index.js';

const [syncDir, ledgerDir, mode, id, iterations, lockTimeoutMs, grantJson] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const out = { entered: 0, refused: 0, overlaps: 0, errors: 0, messages: [] };
const ledger = mode === 'ledger' ? openLedger(ledgerDir, { lockTimeoutMs: Number(lockTimeoutMs), lockPollMs: 2 }) : null;

for (let i = 0; i < Number(iterations); i += 1) {
  for (let waited = 0; !existsSync(join(syncDir, `go-${i}`)); waited += 1) { if (waited > 60_000) process.exit(3); sleep(1); } // never outlive an aborted parent
  try {
    if (mode === 'cs') {
      const release = acquireLock(join(syncDir, 'cs.lock'), { timeoutMs: Number(lockTimeoutMs), pollMs: 2 });
      try {
        try { mkdirSync(join(syncDir, 'in-cs')); } catch { out.overlaps += 1; }
        sleep(2);
        try { rmdirSync(join(syncDir, 'in-cs')); } catch { out.overlaps += 1; }
        out.entered += 1;
      } finally { release(); }
    } else {
      ledger.openRun(JSON.parse(grantJson), `w${id}-i${i}`);
      out.entered += 1;
    }
  } catch (e) {
    if (/lock/.test(String(e?.message))) { out.refused += 1; if (out.messages.length < 1) out.messages.push(String(e.message)); } else { out.errors += 1; out.messages.push(String(e?.message)); }
  }
  writeFileSync(join(syncDir, `done-${i}-${id}`), '');
}
console.log(JSON.stringify(out));
