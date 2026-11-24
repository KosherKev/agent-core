import { mkdirSync, appendFileSync, readFileSync, existsSync, lstatSync, readdirSync, openSync, closeSync, writeSync, fsyncSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { validateJournalEntry } from '../validators.js';

const RUN_ID = /^[A-Za-z0-9._:-]{1,100}$/;
export const OUTCOMES = Object.freeze(['ok', 'failed', 'blocked', 'refused', 'truncated']);
const CAP_EVENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Gateway-owned run records, one append-only JSONL file per run under runs_dir (dir 0700, files 0600).
 * A run record carries start, end, duration, model, provider, outcome and zero or more capability_added events.
 * Those fields cannot live in the locked run-journal-entry schema (unevaluatedProperties:false, three kinds only), so they are
 * gateway lines of their own; ordinary journal entries are validated against that schema unchanged and stored as lines too.
 */
/** A run file is larger than the configured re-read bound: it is refused, not read. Carries a readable message and the code `run_file_too_large`. */
export class RunFileTooLarge extends Error { constructor(bytes, max) { super(`the run record is ${bytes} bytes, over run_file_max_bytes (${max}); refusing to read it (fail closed)`); this.name = 'RunFileTooLarge'; this.code = 'run_file_too_large'; } }
export const DEFAULT_RUN_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** What the durable write of a request start does when the disk will not confirm it. The gateway turns it into `request_start_not_durable`. */
export class DurabilityError extends Error { constructor(message) { super(message); this.name = 'DurabilityError'; } }

/** Default flush functions: fsync an open file descriptor, and fsync a directory (so a newly created file's name survives power loss). Injectable; may return a promise. */
export const realFileSync = Object.freeze({
  file: (fd) => fsyncSync(fd),
  dir: (path) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } },
});

export function createRunStore(dir, { now = Date.now, fileSync = realFileSync, maxBytes = DEFAULT_RUN_FILE_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('run_file_max_bytes must be a positive integer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('runs directory is not a plain directory; refusing');
  const fileOf = (runId) => { if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new RangeError('run id is missing or malformed'); return join(dir, `${runId.replace(/:/g, '_')}.jsonl`); };
  // Run files this store created whose directory entry has not been flushed yet. The next durable write for such a file flushes the directory once.
  const dirPending = new Set();
  const write = (runId, line) => {
    const f = fileOf(runId);
    if (!existsSync(f)) dirPending.add(f);
    appendFileSync(f, JSON.stringify({ at: new Date(now()).toISOString(), ...line }) + '\n', { flag: 'a', mode: 0o600 });
  };
  /**
   * Append one line, then make it durable BEFORE returning: fsync the file (everything in it so far), and the directory too the first time, i.e. when this
   * write created the file or the file was created by an earlier non-durable write of this store. Rejects with DurabilityError if any flush fails.
   */
  const writeDurable = async (runId, line) => {
    const f = fileOf(runId);
    if (!existsSync(f)) dirPending.add(f);
    const fd = openSync(f, 'a', 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: new Date(now()).toISOString(), ...line }) + '\n');
      try { await fileSync.file(fd); if (dirPending.has(f)) { await fileSync.dir(dir); dirPending.delete(f); } } catch { throw new DurabilityError('the run record could not be flushed to disk'); }
    } finally { closeSync(fd); }
  };
  // Every re-read of a run file (a retry lookup, a duplicate-id check, the assembled view) goes through here. The size is checked on the open file BEFORE anything is read.
  const lines = (runId) => {
    const f = fileOf(runId);
    if (!existsSync(f)) return [];
    const fd = openSync(f, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > maxBytes) throw new RunFileTooLarge(size, maxBytes);
      return readFileSync(fd, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } finally { closeSync(fd); }
  };

  const api = {
    exists: (runId) => existsSync(fileOf(runId)),
    /** Creates the run file. Async and durable: resolves only after the file's contents and its directory entry are flushed. Rejects with DurabilityError otherwise. */
    start(runId, { provider, model } = {}) { return writeDurable(runId, { type: 'run_start', start_ms: now(), ...(provider ? { provider } : {}), ...(model ? { model } : {}) }); },
    setModel(runId, provider, model) { write(runId, { type: 'model', provider, model }); },
    /** One line per finished modelCall: the request_id, its parameter fingerprint and how it ended, with the (already redacted) result so a retry can be answered after the memory cache forgot it. */
    recordRequest(runId, requestId, { ok, code, cost_micro, fp, result, message } = {}) {
      write(runId, { type: 'request', request_id: requestId, ok: ok === true, ...(code ? { code: String(code).slice(0, 40) } : {}), ...(Number.isSafeInteger(cost_micro) ? { cost_micro } : {}), ...(typeof fp === 'string' ? { fp } : {}), ...(result !== undefined ? { result } : {}), ...(typeof message === 'string' ? { message: message.slice(0, 300) } : {}) });
    },
    /**
     * Written BEFORE a modelCall reserves anything or calls the provider: proof that this request_id was started, so a cut-off call is recognisable after a restart
     * and nothing is paid twice. Async and durable: it resolves only after the line is flushed (file, and directory if this write created the file). Rejects with DurabilityError otherwise.
     */
    recordRequestStart(runId, requestId, fp) { return writeDurable(runId, { type: 'request_start', request_id: requestId, fp }); },
    /** Async and durable (flushed before it resolves): a reservation now exists for this request_id. Lets a retry say truthfully whether a reservation was recorded. Rejects with DurabilityError if the flush fails. */
    recordRequestReserved(runId, requestId, reservationId) { return writeDurable(runId, { type: 'request_reserved', request_id: requestId, ...(typeof reservationId === 'string' ? { reservation_id: reservationId.slice(0, 100) } : {}) }); },
    /**
     * The last recorded outcome for a request_id on this run (the durable fallback behind the gateway's bounded memory cache), or null. Throws if the file is unreadable.
     * A finished call is its 'request' line. A call that was started but never finished comes back as its start line with `pending: true` (the outcome is unknown) and `reserved: true` only if the file also holds a reservation line for it.
     */
    findRequest(runId, requestId) {
      const ls = lines(runId);
      let reserved = false; // a reservation line newer than the start line that is found next
      for (let i = ls.length - 1; i >= 0; i -= 1) {
        if (ls[i].request_id !== requestId) continue;
        if (ls[i].type === 'request') return ls[i];
        if (ls[i].type === 'request_reserved') reserved = true;
        if (ls[i].type === 'request_start') return { ...ls[i], pending: true, reserved };
      }
      return null;
    },
    end(runId, outcome) {
      if (!OUTCOMES.includes(outcome)) throw new RangeError('outcome must be one of ' + OUTCOMES.join(', '));
      write(runId, { type: 'run_end', end_ms: now(), outcome });
    },
    /** Validate a journal entry against the locked schema (unchanged) and store it. Duplicate ids refused. */
    journal(runId, entry) {
      const r = validateJournalEntry(entry);
      if (!r.valid) throw new RangeError(`invalid journal entry: ${r.errors.join('; ').slice(0, 300)}`);
      if (entry.run_id !== runId) throw new RangeError('journal entry run_id does not match the run');
      if (lines(runId).some((l) => l.type === 'journal' && l.entry.id === entry.id)) throw new RangeError('duplicate journal entry id');
      write(runId, { type: 'journal', entry });
    },
    capabilityAdded(runId, event) {
      if (!event || typeof event !== 'object' || typeof event.name !== 'string' || !CAP_EVENT.test(event.name) || event.name.length > 64) throw new RangeError('capability_added needs a kebab-case name');
      const version = event.version === undefined ? undefined : String(event.version).slice(0, 40);
      write(runId, { type: 'capability_added', name: event.name, ...(version ? { version } : {}) });
    },
    /** Read-only assembled view: { record, entries }. */
    read(runId, { kind } = {}) {
      const ls = lines(runId);
      if (!ls.length) return null;
      const start = ls.find((l) => l.type === 'run_start'); const end = [...ls].reverse().find((l) => l.type === 'run_end');
      const model = [...ls].reverse().find((l) => l.type === 'model') ?? start;
      const record = {
        run_id: runId, started_at: start ? new Date(start.start_ms).toISOString() : null, ended_at: end ? new Date(end.end_ms).toISOString() : null,
        duration_ms: start && end ? Math.max(0, end.end_ms - start.start_ms) : null,
        model: model?.model ?? null, provider: model?.provider ?? null, outcome: end?.outcome ?? null,
        capability_added: ls.filter((l) => l.type === 'capability_added').map((l) => ({ at: l.at, name: l.name, ...(l.version ? { version: l.version } : {}) })),
      };
      const entries = ls.filter((l) => l.type === 'journal' && (kind === undefined || l.entry.kind === kind)).map((l) => l.entry);
      return { record, entries };
    },
    list: () => readdirSync(dir).filter((n) => n.endsWith('.jsonl')),
  };
  return Object.freeze(api);
}
