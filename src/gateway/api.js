import { createMeter, GrantError, priceFor } from '../grant/index.js';
import { LedgerError } from '../ledger/index.js';
import { validateGrant } from '../validators.js';
import { priceKey } from './prices.js';
import { callProvider, ProxyError } from './proxy.js';
import { makeRedactor, redactDeep } from './credentials.js';
import { OUTCOMES, DurabilityError } from './runs.js';
import { createHash, randomBytes } from 'node:crypto';

export const GATEWAY_VERSION = 'm1a.1';
export const NOT_IMPLEMENTED = 'not implemented in M1a';
export const METHODS = Object.freeze(['ping', 'openRun', 'endRun', 'reserve', 'settle', 'release', 'modelCall', 'journalAppend', 'journalRead', 'pushBranch', 'requestMerge']);

class RequestError extends Error { constructor(code, message) { super(message); this.name = 'RequestError'; this.code = code; } }
const bad = (m) => new RequestError('invalid_request', m);
const RUN_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const REQUEST_ID = RUN_ID;
const MAX_MESSAGES = 512;

function pick(o, keys) { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; }

/**
 * The gateway's request handler. It owns the meter per open run, the ledger store, the run records and the credentials.
 * deps: { config, store, runs, credentials, priceTable, now, transport, log, makeSink(runId), access, layoutInfo }
 * `transport` is the injectable provider HTTP function (tests only; the default is the real client inside proxy.js).
 * handle(request) -> response; it never throws. Every response (ok or error) for a known run carries `budget`.
 */
export function createGatewayApi({ config, store, runs, credentials, priceTable, now = Date.now, transport, log = () => {}, makeSink, access = 'kernel-permissions', layoutInfo = () => ({}), instanceId = randomBytes(16).toString('hex'), requestCacheMax = config.request_cache_max ?? 1024 }) {
  const redact = makeRedactor(credentials.secrets());
  const open = new Map(); // run_id -> { meter, reservations: Map, inflight }
  // Bounded LRU of modelCall records, keyed run_id + request_id: { fp, done, settled }. In-flight entries are never evicted; a settled entry is evicted
  // only once its outcome is persisted, and a miss falls back to that persisted record, so eviction can never cause a second reservation or settlement.
  const cache = new Map();
  const ckey = (runId, requestId) => `${runId}\0${requestId}`;
  const evict = () => {
    if (cache.size <= requestCacheMax) return;
    for (const [k, e] of cache) { if (cache.size <= requestCacheMax) break; if (e.settled) cache.delete(k); }
  };
  const startedAt = now();

  const run = (id) => {
    if (typeof id !== 'string' || !RUN_ID.test(id)) throw bad('run_id is missing or malformed');
    const r = open.get(id);
    if (!r) throw new RequestError('run_not_open', 'run is not open on this gateway; refusing');
    return r;
  };
  const budgetOf = (r) => {
    const s = r.meter.snapshot();
    let remaining = s.remaining_micro;
    try { remaining = Math.min(remaining, store.read(r.meter.grant).remaining_micro); } catch { remaining = 0; } // fail closed: unreadable ledger means nothing left
    return { budget_micro: s.budget_micro, settled_micro: s.settled_micro, reserved_micro: s.reserved_micro, remaining_micro: Math.max(0, remaining), tool_calls: s.tool_calls, max_tool_calls: s.max_tool_calls };
  };
  const checkProvider = (provider) => { if (typeof provider !== 'string' || !config.providers[provider]) throw new RequestError('provider', 'unknown provider; refusing'); };
  const keyFor = (provider, model) => { checkProvider(provider); try { return priceKey(provider, model); } catch { throw bad('model id is invalid'); } };

  const doReserve = (r, p) => {
    const key = keyFor(p.provider, p.model);
    if (priceFor(priceTable, key) === null) throw new GrantError('price', 'no trusted price for this provider and model; paid models are refused');
    if (p.max_tokens !== undefined && (!Number.isSafeInteger(p.max_tokens) || p.max_tokens < 1)) throw bad('max_tokens must be a positive integer');
    const res = r.meter.reserve({ model: key, input: p.input, ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}) });
    r.reservations.set(res.id, { res, provider: p.provider, model: p.model });
    return res;
  };

  // What a persisted record means for a retry. A finished call is answered from it; a started-but-unfinished one has an unknown outcome and is never re-run.
  const outcomeOf = (rec, fp) => {
    if (rec.fp !== fp) throw new RequestError('request_id_conflict', 'request_id was already used on this run with different parameters; refusing');
    if (rec.pending) {
      // Say only what the run file shows: a reservation line, or none. Never claim a reservation that is not recorded.
      const what = rec.reserved === true ? 'its reservation is kept' : 'the run file shows no reservation for it, so none is claimed here';
      return { err: new RequestError('request_outcome_unknown', `this request_id was started but its outcome was not recorded (the gateway stopped mid-call); ${what}; the call is not repeated; use a new request_id to try again`) };
    }
    if (rec.ok) return rec.result !== undefined ? { result: rec.result } : { err: new RequestError('request_result_unavailable', 'this request_id was already served but its result was not kept; refusing to pay twice') };
    return { err: new RequestError(typeof rec.code === 'string' ? rec.code : 'internal', typeof rec.message === 'string' ? rec.message : 'the recorded call failed') };
  };
  const paramsOk = (p) => typeof p.run_id === 'string' && RUN_ID.test(p.run_id) && typeof p.request_id === 'string' && REQUEST_ID.test(p.request_id) && Array.isArray(p.messages) && p.messages.length >= 1 && p.messages.length <= MAX_MESSAGES && p.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.role === 'string') && typeof p.provider === 'string';
  const fpOf = (p) => createHash('sha256').update(JSON.stringify([p.provider, p.model, p.messages, p.max_tokens ?? null])).digest('hex');
  const pending = new Set(); // promises of detached modelCall work (the call and the persisting of its outcome)

  const callModel = async (r, p) => {
    const res = doReserve(r, { provider: p.provider, model: p.model, input: p.messages, max_tokens: p.max_tokens });
    try { runs.recordRequestReserved(p.run_id, p.request_id, res.id); } catch { /* best effort: without the line a retry says no reservation is recorded, which is what the file then shows */ }
    let out;
    try { out = await callProvider({ config, credentials, provider: p.provider, model: p.model, messages: p.messages, maxTokens: res.max_tokens, send: transport, timeoutMs: config.provider_timeout_ms, maxBytes: config.max_response_bytes }); } catch (e) { r.reservations.delete(res.id); r.meter.release(res, 'proxy'); throw e; }
    r.reservations.delete(res.id);
    runs.setModel(p.run_id, p.provider, p.model);
    if (out.networkError) { r.meter.settle(res, null); throw new RequestError('provider_error', 'provider request failed; the reservation was settled at worst case'); }
    if (!out.ok) { r.meter.release(res, `http ${out.status}`); throw new RequestError('provider_rejected', `provider rejected the request (HTTP ${out.status})`); }
    const cost = r.meter.settle(res, out.json?.usage);
    const choice = out.json?.choices?.[0];
    if (!choice || typeof choice !== 'object') throw new RequestError('bad_response', 'provider response has no choices (the call was settled)');
    const u = out.json.usage ?? {};
    return { message: choice.message ?? null, finish_reason: choice.finish_reason ?? null, usage: pick(u, ['prompt_tokens', 'completion_tokens']), cost_micro: cost };
  };

  const methods = {
    async ping() {
      return { result: { version: GATEWAY_VERSION, uptime_ms: Math.max(0, now() - startedAt), pid: process.pid, instance_id: instanceId, access, layout: layoutInfo() } };
    },
    async openRun(p) {
      if (typeof p.run_id !== 'string' || !RUN_ID.test(p.run_id)) throw bad('run_id is missing or malformed');
      if (open.has(p.run_id) || runs.exists(p.run_id)) throw new RequestError('run_exists', 'run id already used; refusing');
      const g = validateGrant(p.grant);
      if (!g.valid) throw new RequestError('invalid_grant', `grant is invalid: ${g.errors.join('; ').slice(0, 200)}`);
      let model;
      if (p.provider !== undefined || p.model !== undefined) model = keyFor(p.provider, p.model);
      const meter = createMeter(p.grant, { now, priceTable, model, ledger: store.meterLedger(), runId: p.run_id, ...(makeSink ? { sink: makeSink(p.run_id) } : {}) });
      const r = { meter, reservations: new Map(), inflight: 0 };
      open.set(p.run_id, r);
      try { runs.start(p.run_id, { provider: p.provider, model: p.model }); } catch (e) { open.delete(p.run_id); try { meter.end('failed'); } catch { /* conservative: reservations stay counted */ } throw e; }
      return { result: { run_id: p.run_id }, run: r };
    },
    async endRun(p) {
      const r = run(p.run_id);
      if (r.inflight > 0) throw new RequestError('busy', 'a model call is still in flight on this run; end the run after it settles');
      if (!OUTCOMES.includes(p.outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
      r.meter.end(p.outcome); // ledger run_end; open reservations stay counted against the grant (conservative)
      runs.end(p.run_id, p.outcome);
      const budget = budgetOf(r);
      open.delete(p.run_id);
      for (const k of [...cache.keys()]) if (k.startsWith(`${p.run_id}\0`)) cache.delete(k);
      return { result: { run_id: p.run_id, record: runs.read(p.run_id).record }, run: r, budget };
    },
    async reserve(p) {
      const r = run(p.run_id);
      const res = doReserve(r, p);
      return { result: { reservation_id: res.id, max_tokens: res.max_tokens, reserved_micro: res.reserved_micro }, run: r };
    },
    async settle(p) {
      // The runner's own usage numbers are never trusted: a paid reservation settles at its full worst case and a free one at 0.
      // Measured cost only comes from modelCall, where the gateway reads the provider's response itself.
      const r = run(p.run_id);
      if (!r.reservations.has(p.reservation_id)) throw new RequestError('reservation', 'unknown reservation; refusing');
      const cost = r.meter.settle({ id: p.reservation_id }, null);
      r.reservations.delete(p.reservation_id);
      return { result: { cost_micro: cost }, run: r };
    },
    async release(p) {
      const r = run(p.run_id);
      if (!r.reservations.has(p.reservation_id)) throw new RequestError('reservation', 'unknown reservation; refusing');
      r.meter.release({ id: p.reservation_id }, typeof p.reason === 'string' ? p.reason : 'released');
      r.reservations.delete(p.reservation_id);
      return { result: { cost_micro: 0 }, run: r };
    },
    async modelCall(p) {
      // A run that is not open here (it was ended, or the gateway restarted) can still have recorded requests. The persisted record is
      // consulted BEFORE the run-state check, so a retry gets its recorded answer and nothing can reserve a second time for a known request_id.
      if (!open.has(p.run_id) && paramsOk(p) && runs.exists(p.run_id)) {
        let rec; try { rec = runs.findRequest(p.run_id, p.request_id); } catch { throw new RequestError('internal', 'cannot read the run record; refusing (fail closed)'); }
        if (rec) { const o = outcomeOf(rec, fpOf(p)); if (o.err) throw o.err; return { result: o.result }; }
      }
      const r = run(p.run_id);
      if (typeof p.request_id !== 'string' || !REQUEST_ID.test(p.request_id)) throw bad('request_id is required (1 to 100 of A-Z a-z 0-9 . _ : -)');
      if (!Array.isArray(p.messages) || p.messages.length < 1 || p.messages.length > MAX_MESSAGES || !p.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.role === 'string')) throw bad('messages must be a non-empty array of { role, content }');
      checkProvider(p.provider);
      if (!credentials.get(p.provider)) throw new RequestError('credential', 'no credential for this provider; refusing');
      // One logical call per request_id on a run: a repeat never reserves or settles again. It gets the recorded outcome (or waits for the in-flight one).
      const fp = fpOf(p);
      const key = ckey(p.run_id, p.request_id);
      let seen = cache.get(key);
      if (!seen) {
        // Not in memory (never seen, or evicted): the run's persisted record decides. A record means the call already happened and must not be paid again.
        let rec; try { rec = runs.findRequest(p.run_id, p.request_id); } catch { throw new RequestError('internal', 'cannot read the run record; refusing (fail closed)'); }
        if (rec) {
          const out = outcomeOf(rec, fp);
          if (rec.pending) throw out.err; // not cached: nothing here will ever finish it
          seen = { fp, done: Promise.resolve(out), settled: true };
          cache.set(key, seen); evict();
        }
      }
      if (seen) {
        cache.delete(key); cache.set(key, seen); // most recently used
        if (seen.fp !== fp) throw new RequestError('request_id_conflict', 'request_id was already used on this run with different parameters; refusing');
        const o = await seen.done;
        if (o.err) throw o.err;
        return { result: o.result, run: r };
      }
      const entry = { fp, done: null, settled: false };
      cache.set(key, entry);
      r.inflight += 1;
      // The call runs to completion and settles even if the client has gone away; its outcome is persisted under the request_id before it counts as settled.
      entry.done = (async () => {
        let o;
        // The start line goes down, flushed to disk, BEFORE anything is reserved or the provider is called, so a call cut off by a stop or a power loss is recognisable after a restart.
        // If it cannot be written or flushed, nothing is reserved and the provider is never called (fail closed, with its own error code).
        try {
          try { await runs.recordRequestStart(p.run_id, p.request_id, fp); } catch (e) { throw new RequestError('request_start_not_durable', e instanceof DurabilityError ? 'the start of this request could not be made durable on disk; the provider was not called (fail closed); use a new request_id to try again' : 'the start of this request could not be recorded; the provider was not called (fail closed); use a new request_id to try again'); }
          o = { result: await callModel(r, p) };
        } catch (err) { o = { err }; }
        try {
          const e = o.err ? errorOf(o.err) : null;
          runs.recordRequest(p.run_id, p.request_id, { ok: !e, fp, ...(e ? { code: e.code, message: redact(e.message) } : { cost_micro: o.result.cost_micro, result: redactDeep(o.result, redact) }) });
          entry.settled = true;
        } catch { log('request outcome could not be persisted; the entry stays pinned in memory'); }
        r.inflight -= 1;
        evict();
        return o;
      })();
      pending.add(entry.done); entry.done.finally(() => pending.delete(entry.done)).catch(() => {});
      const o = await entry.done;
      if (o.err) throw o.err;
      return { result: o.result, run: r };
    },
    async journalAppend(p) {
      const r = run(p.run_id);
      const hasEntry = p.entry !== undefined; const hasCap = p.capability_added !== undefined;
      if (hasEntry === hasCap) throw bad('give exactly one of entry or capability_added');
      if (hasEntry) runs.journal(p.run_id, p.entry); else runs.capabilityAdded(p.run_id, p.capability_added);
      return { result: { appended: true }, run: r };
    },
    async journalRead(p) {
      if (typeof p.run_id !== 'string' || !RUN_ID.test(p.run_id)) throw bad('run_id is missing or malformed');
      const v = runs.read(p.run_id, { kind: p.kind });
      if (!v) throw new RequestError('run_unknown', 'no such run');
      return { result: v, run: open.get(p.run_id) };
    },
    async pushBranch() { throw new RequestError('not_implemented', NOT_IMPLEMENTED); },
    async requestMerge() { throw new RequestError('not_implemented', NOT_IMPLEMENTED); },
  };

  const errorOf = (err) => {
    if (err instanceof RequestError || err instanceof ProxyError) return { code: err.code, message: err.message };
    if (err instanceof GrantError) return { code: err.limit, message: err.message };
    if (err instanceof LedgerError) return { code: err.kind === 'budget' || err.kind === 'tool_calls' ? err.kind : 'ledger', message: err.message };
    if (err instanceof RangeError) return { code: 'invalid_request', message: String(err.message).slice(0, 300) };
    return { code: 'internal', message: 'internal error; refusing (fail closed)' };
  };

  async function handle(req) {
    let id = null; let run0 = null;
    try {
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw bad('request must be a JSON object');
      id = req.id ?? null;
      if (typeof req.method !== 'string' || !METHODS.includes(req.method)) throw bad('unknown method');
      const params = req.params ?? {};
      if (typeof params !== 'object' || Array.isArray(params) || params === null) throw bad('params must be an object');
      run0 = open.get(params.run_id) ?? null;
      const out = await methods[req.method](params);
      const budget = out.budget ?? (out.run ? budgetOf(out.run) : undefined);
      return redactDeep({ id, ok: true, result: out.result, ...(budget ? { budget } : {}) }, redact);
    } catch (err) {
      const e = errorOf(err);
      log(`request refused: ${e.code}`);
      let budget;
      try { if (run0) budget = budgetOf(run0); } catch { /* none */ }
      return redactDeep({ id, ok: false, error: e, ...(budget ? { budget } : {}) }, redact);
    }
  }

  return Object.freeze({ handle, openRuns: () => [...open.keys()], instanceId, cacheSize: () => cache.size, /** Resolves once every detached modelCall has finished and persisted its outcome (used by shutdown). */ async drain() { while (pending.size) await Promise.allSettled([...pending]); } });
}
