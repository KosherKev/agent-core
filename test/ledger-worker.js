// Child process for the concurrency test: reserve fixed-size amounts on one grant until refused, settling each in full.
import { openLedger } from '../src/ledger/index.js';

const [dir, grantJson, runId, micro, attempts, delayMs] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ledger = openLedger(dir, { lockTimeoutMs: 20000, testHooks: { betweenCheckAndAppend: () => sleep(Number(delayMs)) } });
let ok = 0; let refused = 0; let errors = 0;
try {
  const run = ledger.openRun(JSON.parse(grantJson), runId);
  for (let i = 0; i < Number(attempts); i += 1) {
    try { const rid = run.reserve({ micro: Number(micro) }); run.settle(rid, Number(micro)); ok += 1; } catch (e) { if (e.kind === 'budget') refused += 1; else { errors += 1; console.error(String(e?.message)); } }
  }
} catch (e) { if (e.kind === 'budget') refused += 1; else { errors += 1; console.error(String(e?.message)); } }
console.log(JSON.stringify({ ok, refused, errors }));
