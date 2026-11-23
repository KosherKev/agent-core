import { openSync, closeSync, readFileSync, existsSync, lstatSync, mkdirSync, realpathSync, readdirSync, constants as fsc } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usdToMicro } from '../grant/money.js';
import { LedgerError, GENESIS, canonicalJson, sha256, fileNameFor, replay, summarize } from './format.js';
import { acquireLock } from './lock.js';
import { writeAll, fsyncDir, realIo } from './durable.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fail = (msg, kind = 'ledger') => { throw new LedgerError(kind, msg); };

/** `AGENT_LEDGER_DIR`, else `~/.agent-ledger`. Never inside the repo. */
export function defaultLedgerDir(env = process.env) {
  const d = env.AGENT_LEDGER_DIR;
  return resolve(typeof d === 'string' && d.trim() ? d : join(homedir(), '.agent-ledger'));
}

function realOfDeepestExisting(p) {
  let probe = p; const tail = [];
  while (!existsSync(probe)) { const up = dirname(probe); if (up === probe) break; tail.unshift(probe.slice(up.length + 1)); probe = up; }
  return join(realpathSync.native(probe), ...tail);
}

/** Refuse a ledger directory inside this repository (or its worktree): the ledger must be a rules-layer object outside it. */
export function assertOutsideRepo(dir) {
  const real = realOfDeepestExisting(resolve(dir));
  const root = realpathSync.native(REPO_ROOT);
  if (real === root || real.startsWith(root + sep)) fail('ledger directory must be outside the repository; refusing');
  return real;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('ledger path is not a plain directory; refusing');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) fail('ledger directory is not owned by this user; refusing');
  if ((st.mode & 0o077) !== 0) fail('ledger directory must be mode 0700 (chmod 700 it by hand); refusing');
}

/**
 * Sync append of one line, file mode 0600. Every byte must be written (short writes are retried, no progress refuses), the file is
 * fsynced, and when this call created the file its directory entry is fsynced too, so a power cut cannot silently un-create a ledger.
 */
function appendLine(file, line, io) {
  const isNew = !existsSync(file);
  const fd = openSync(file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT, 0o600);
  try { writeAll(fd, line + '\n', io); io.fsyncSync(fd); } finally { closeSync(fd); }
  if (isNew) fsyncDir(dirname(file), io);
}

const RUN_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Open (creating if needed) the local append-only grant ledger.
 * opts: { now, lockTimeoutMs, lockPollMs, pidAlive, io: { writeSync, fsyncSync } (injectable file operations), testHooks: { betweenCheckAndAppend() } }.
 * Every operation that writes holds an exclusive per-grant lock across read, check and append, and re-verifies the hash chain first.
 */
export function openLedger(dir = defaultLedgerDir(), opts = {}) {
  try {
    const abs = resolve(dir);
    assertOutsideRepo(abs);
    ensureDir(abs);
    return build(realpathSync.native(abs), opts);
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    throw new LedgerError('ledger', `ledger unavailable (${err?.code ?? 'error'}); refusing`);
  }
}

function build(dir, { now = Date.now, lockTimeoutMs = 5000, lockPollMs = 10, pidAlive, io = realIo, testHooks = {} } = {}) {
  const fileOf = (key) => join(dir, fileNameFor(key));
  const readState = (file) => replay(existsSync(file) ? readFileSync(file, 'utf8') : '');
  const stamp = () => new Date(now()).toISOString();

  const keyOf = (grant) => {
    if (!grant || typeof grant !== 'object' || typeof grant.task_id !== 'string' || !grant.task_id) fail('grant has no task_id to key the ledger on; refusing');
    return grant.task_id;
  };
  const limitsOf = (grant) => {
    const budget = usdToMicro(grant.budget?.max_usd, 'floor');
    const calls = grant.budget?.max_tool_calls;
    if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(calls) || calls < 1) fail('grant budget is unusable for the ledger; refusing');
    return { budget_micro: budget, max_tool_calls: calls };
  };

  /** Run fn(state) under the grant's exclusive lock. `fn` returns [entryFields | null, result]. */
  const locked = (file, fn) => {
    const release = acquireLock(`${file}.lock`, { now, timeoutMs: lockTimeoutMs, pollMs: lockPollMs, io, ...(pidAlive ? { pidAlive } : {}) });
    try {
      const st = readState(file);
      const [entries, result] = fn(st);
      let prev = st.last_hash; let seq = st.seq;
      if (testHooks.betweenCheckAndAppend) testHooks.betweenCheckAndAppend();
      for (const body of entries ?? []) {
        seq += 1;
        const line = JSON.stringify({ v: 1, seq, at: stamp(), prev, ...body });
        appendLine(file, line, io);
        prev = sha256(line);
      }
      return result;
    } catch (err) {
      if (err instanceof LedgerError) throw err;
      throw new LedgerError('ledger', `ledger i/o failure (${err?.code ?? 'error'}); refusing`);
    } finally { release(); }
  };

  const view = (st) => summarize(st);

  const ledger = {
    dir,
    /** Read-only, lock-free remaining numbers for a grant (full limits if it was never used). Fails closed on a bad ledger. */
    remaining(grant) {
      const key = keyOf(grant); const lim = limitsOf(grant);
      const st = readState(fileOf(key));
      if (st.key === null) return Object.freeze({ key, ...lim, settled_micro: 0, open_micro: 0, remaining_micro: lim.budget_micro, calls_used: 0, calls_remaining: lim.max_tool_calls });
      if (st.fingerprint !== sha256(canonicalJson(grant))) fail('grant differs from the one first recorded under this key; refusing');
      return view(st);
    },
    /**
     * Register a run on a grant. Refuses a mutated grant under an existing key, a reused run id, and an already exhausted grant.
     * Returns the run handle used for every reserve, settle, release and run_end.
     */
    openRun(grant, runId) {
      if (typeof runId !== 'string' || !RUN_ID.test(runId)) fail('run id is missing or malformed; refusing');
      const key = keyOf(grant); const lim = limitsOf(grant);
      const fingerprint = sha256(canonicalJson(grant));
      const file = fileOf(key);
      locked(file, (st) => {
        if (st.key !== null && (st.fingerprint !== fingerprint || st.key !== key)) fail('grant differs from the one first recorded under this key (mutated grant); refusing');
        if (st.runs.has(runId)) fail('run id already used on this grant; refusing');
        if (st.key !== null) {
          const s = view(st);
          if (s.remaining_micro < 1) fail('grant budget already exhausted across earlier runs', 'budget');
          if (s.calls_remaining < 1) fail('grant tool-call limit already reached across earlier runs', 'tool_calls');
        }
        return [[{ type: 'open', key, run_id: runId, fingerprint, ...lim }], null];
      });
      return makeRun(file, runId);
    },
    /** Read-only listing of a state for the report (never creates anything). */
    stateOf(key) { return view(readState(fileOf(key))); },
  };

  const makeRun = (file, runId) => {
    const own = (st, rid) => { const r = st.reservations.get(rid); if (!r || r.run_id !== runId || r.state !== 'open') fail('reservation is unknown, closed or not this run\'s; refusing'); return r; };
    const live = (st) => { const r = st.runs.get(runId); if (!r || r.ended) fail('run is not open; refusing'); };
    const reserve = ({ micro, calls = 0, kind = 'model' }) => locked(file, (st) => {
      live(st);
      if (!Number.isSafeInteger(micro) || micro < 0 || !Number.isSafeInteger(calls) || calls < 0 || (kind !== 'model' && kind !== 'tool')) fail('malformed reservation; refusing');
      const s = view(st);
      if (micro > s.remaining_micro) fail('worst-case cost exceeds the budget remaining across all runs of this grant', 'budget');
      if (calls > s.calls_remaining) fail('grant tool-call limit reached across all runs', 'tool_calls');
      const rid = `${runId}#${st.runs.get(runId).reservations + 1}`;
      return [[{ type: 'reserve', run_id: runId, rid, kind, micro, calls }], rid];
    });
    return Object.freeze({
      runId,
      reserve,
      /** Count one tool call against max_tool_calls across all runs. */
      reserveTool: () => reserve({ kind: 'tool', micro: 0, calls: 1 }),
      settle: (rid, micro) => locked(file, (st) => { live(st); own(st, rid); if (!Number.isSafeInteger(micro) || micro < 0) fail('malformed settle amount; refusing'); return [[{ type: 'settle', rid, micro }], micro]; }),
      release: (rid) => locked(file, (st) => { live(st); own(st, rid); return [[{ type: 'release', rid }], 0]; }),
      endRun: (status) => locked(file, (st) => { live(st); if (typeof status !== 'string' || !/^[a-z][a-z-]{0,30}$/.test(status)) fail('malformed run status; refusing'); return [[{ type: 'run_end', run_id: runId, status }], null]; }),
      remaining: () => locked(file, (st) => [null, view(st)]),
    });
  };

  return Object.freeze(ledger);
}

/** Read-only scan of a ledger directory for the report. Never creates, locks or writes. One result per grant file. */
export function scanLedgerDir(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    try {
      const st = replay(readFileSync(join(dir, name), 'utf8'));
      if (st.key !== null && fileNameFor(st.key) !== name) fail('file name does not match the grant key inside it');
      out.push({ file: name, ok: true, summary: summarize(st) });
    } catch (err) {
      out.push({ file: name, ok: false, error: err instanceof LedgerError ? err.message : 'unreadable ledger file' });
    }
  }
  return out;
}
export { GENESIS };
