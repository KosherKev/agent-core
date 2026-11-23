import { createHash } from 'node:crypto';

/** Why the ledger refused. kind: budget | tool_calls | ledger. Messages never contain secrets (only ids and integers). */
export class LedgerError extends Error {
  constructor(kind, message) { super(message); this.name = 'LedgerError'; this.kind = kind; }
}

export const GENESIS = '0'.repeat(64);
export const ENTRY_TYPES = Object.freeze(['open', 'reserve', 'settle', 'release', 'run_end']);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted at every level, so equal grants hash equally whatever their key order. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const isMicro = (n) => Number.isSafeInteger(n) && n >= 0;
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9._:#-]{1,160}$/.test(s);
const bad = (why) => { throw new LedgerError('ledger', `ledger refused: ${why}`); };

/** File name of a grant key's ledger. The key itself is stored inside, in the `open` entry. */
export const fileNameFor = (key) => `${sha256(`grant-key:${key}`)}.jsonl`;

/**
 * Replay a ledger file's text, verifying the hash chain and every entry. Any problem throws LedgerError (fail closed).
 * Returns the derived state. Tail truncation (whole lines cut off the end) cannot be detected here: no external anchor.
 */
export function replay(text) {
  const st = { key: null, fingerprint: null, budget_micro: 0, max_tool_calls: 0, runs: new Map(), reservations: new Map(), settled_micro: 0, open_micro: 0, calls_used: 0, last_hash: GENESIS, seq: 0, entries: 0 };
  if (text === '') return st;
  if (!text.endsWith('\n')) bad('last line is not newline-terminated (torn or truncated write)');
  const lines = text.slice(0, -1).split('\n');
  for (const raw of lines) {
    let e;
    try { e = JSON.parse(raw); } catch { bad(`unparseable line at seq ${st.seq + 1}`); }
    if (!e || typeof e !== 'object' || Array.isArray(e)) bad(`line at seq ${st.seq + 1} is not an object`);
    if (e.prev !== st.last_hash) bad(`hash chain broken at seq ${st.seq + 1}`);
    if (e.seq !== st.seq + 1) bad(`sequence number out of order at seq ${st.seq + 1}`);
    if (!ENTRY_TYPES.includes(e.type)) bad(`unknown entry type at seq ${e.seq}`);
    if (typeof e.at !== 'string') bad(`missing timestamp at seq ${e.seq}`);
    apply(st, e);
    st.last_hash = sha256(raw); st.seq = e.seq; st.entries += 1;
  }
  return st;
}

function apply(st, e) {
  switch (e.type) {
    case 'open': {
      if (!isId(e.run_id) || typeof e.key !== 'string' || !e.key || !/^[0-9a-f]{64}$/.test(e.fingerprint ?? '') || !isMicro(e.budget_micro) || !Number.isSafeInteger(e.max_tool_calls) || e.max_tool_calls < 1) bad(`malformed open entry at seq ${e.seq}`);
      if (st.key === null) { st.key = e.key; st.fingerprint = e.fingerprint; st.budget_micro = e.budget_micro; st.max_tool_calls = e.max_tool_calls; } else if (st.key !== e.key || st.fingerprint !== e.fingerprint || st.budget_micro !== e.budget_micro || st.max_tool_calls !== e.max_tool_calls) bad(`grant fingerprint or limits changed at seq ${e.seq}`);
      if (st.runs.has(e.run_id)) bad(`run id opened twice at seq ${e.seq}`);
      st.runs.set(e.run_id, { ended: false, status: null, reservations: 0 });
      return;
    }
    case 'reserve': {
      const run = st.runs.get(e.run_id);
      if (!run) bad(`reserve for a run that was never opened at seq ${e.seq}`);
      if (run.ended) bad(`reserve after run_end at seq ${e.seq}`);
      if (!isId(e.rid) || (e.kind !== 'model' && e.kind !== 'tool') || !isMicro(e.micro) || !isMicro(e.calls)) bad(`malformed reserve entry at seq ${e.seq}`);
      if (st.reservations.has(e.rid)) bad(`duplicate reservation id at seq ${e.seq}`);
      const closed = e.kind === 'tool';
      st.reservations.set(e.rid, { run_id: e.run_id, kind: e.kind, micro: e.micro, state: closed ? 'settled' : 'open', settled_micro: closed ? 0 : null });
      run.reservations += 1;
      st.calls_used += e.calls;
      if (!closed) st.open_micro += e.micro;
      if (!Number.isSafeInteger(st.open_micro + st.settled_micro) || !Number.isSafeInteger(st.calls_used)) bad('integer overflow');
      return;
    }
    case 'settle': {
      const r = st.reservations.get(e.rid);
      if (!r || r.state !== 'open') bad(`settle of an unknown or closed reservation at seq ${e.seq}`);
      if (!isMicro(e.micro)) bad(`malformed settle entry at seq ${e.seq}`);
      r.state = 'settled'; r.settled_micro = e.micro;
      st.open_micro -= r.micro; st.settled_micro += e.micro;
      if (!Number.isSafeInteger(st.settled_micro)) bad('integer overflow');
      return;
    }
    case 'release': {
      const r = st.reservations.get(e.rid);
      if (!r || r.state !== 'open') bad(`release of an unknown or closed reservation at seq ${e.seq}`);
      r.state = 'released'; r.settled_micro = 0;
      st.open_micro -= r.micro;
      return;
    }
    case 'run_end': {
      const run = st.runs.get(e.run_id);
      if (!run || run.ended) bad(`run_end for an unknown or already ended run at seq ${e.seq}`);
      if (typeof e.status !== 'string' || !/^[a-z][a-z-]{0,30}$/.test(e.status)) bad(`malformed run_end entry at seq ${e.seq}`);
      run.ended = true; run.status = e.status;
      return;
    }
    default: bad('unknown entry type');
  }
}

/** Derived numbers. remaining = limit - settled - open reservations; a crashed run's reservation stays open and keeps counting. */
export function summarize(st) {
  const remaining_micro = st.budget_micro - st.settled_micro - st.open_micro;
  return Object.freeze({
    key: st.key, fingerprint: st.fingerprint, budget_micro: st.budget_micro, settled_micro: st.settled_micro, open_micro: st.open_micro,
    open_reservations: [...st.reservations.values()].filter((r) => r.state === 'open').length,
    remaining_micro, calls_used: st.calls_used, max_tool_calls: st.max_tool_calls, calls_remaining: st.max_tool_calls - st.calls_used,
    unended_runs: [...st.runs.entries()].filter(([, r]) => !r.ended).map(([id]) => id),
    entries: st.entries,
  });
}
