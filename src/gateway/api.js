import { createMeter, GrantError, priceFor } from '../grant/index.js';
import { LedgerError } from '../ledger/index.js';
import { validateGrant } from '../validators.js';
import { priceKey } from './prices.js';
import { callProvider, ProxyError } from './proxy.js';
import { makeRedactor, redactDeep } from './credentials.js';
import { OUTCOMES } from './runs.js';

export const NOT_IMPLEMENTED = 'not implemented in M1a';
export const METHODS = Object.freeze(['openRun', 'endRun', 'reserve', 'settle', 'release', 'modelCall', 'journalAppend', 'journalRead', 'pushBranch', 'requestMerge']);

class RequestError extends Error { constructor(code, message) { super(message); this.name = 'RequestError'; this.code = code; } }
const bad = (m) => new RequestError('invalid_request', m);
const RUN_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_MESSAGES = 512;

function pick(o, keys) { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out; }

/**
 * The gateway's request handler. It owns the meter per open run, the ledger store, the run records and the credentials.
 * deps: { config, store, runs, credentials, priceTable, now, fetchFn, log, sink(runId) }
 * handle(request) -> response; it never throws. Every response (ok or error) for a known run carries `budget`.
 */
export function createGatewayApi({ config, store, runs, credentials, priceTable, now = Date.now, fetchFn, log = () => {}, makeSink }) {
  const redact = makeRedactor(credentials.secrets());
  const open = new Map(); // run_id -> { meter, provider, model, reservations: Map }

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

  const methods = {
    async openRun(p) {
      if (typeof p.run_id !== 'string' || !RUN_ID.test(p.run_id)) throw bad('run_id is missing or malformed');
      if (open.has(p.run_id) || runs.exists(p.run_id)) throw new RequestError('run_exists', 'run id already used; refusing');
      const g = validateGrant(p.grant);
      if (!g.valid) throw new RequestError('invalid_grant', `grant is invalid: ${g.errors.join('; ').slice(0, 200)}`);
      let model;
      if (p.provider !== undefined || p.model !== undefined) model = keyFor(p.provider, p.model);
      const meter = createMeter(p.grant, { now, priceTable, model, ledger: store.meterLedger(), runId: p.run_id, ...(makeSink ? { sink: makeSink(p.run_id) } : {}) });
      const r = { meter, reservations: new Map() };
      open.set(p.run_id, r);
      try { runs.start(p.run_id, { provider: p.provider, model: p.model }); } catch (e) { open.delete(p.run_id); try { meter.end('failed'); } catch { /* conservative: reservations stay counted */ } throw e; }
      return { result: { run_id: p.run_id }, run: r };
    },
    async endRun(p) {
      const r = run(p.run_id);
      if (!OUTCOMES.includes(p.outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
      r.meter.end(p.outcome); // ledger run_end; open reservations stay counted against the grant (conservative)
      runs.end(p.run_id, p.outcome);
      const budget = budgetOf(r);
      open.delete(p.run_id);
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
      const r = run(p.run_id);
      if (!Array.isArray(p.messages) || p.messages.length < 1 || p.messages.length > MAX_MESSAGES || !p.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m) && typeof m.role === 'string')) throw bad('messages must be a non-empty array of { role, content }');
      checkProvider(p.provider);
      if (!credentials.get(p.provider)) throw new RequestError('credential', 'no credential for this provider; refusing');
      const res = doReserve(r, { provider: p.provider, model: p.model, input: p.messages, max_tokens: p.max_tokens });
      let out;
      try { out = await callProvider({ config, credentials, provider: p.provider, model: p.model, messages: p.messages, maxTokens: res.max_tokens, fetchFn }); } catch (e) { r.reservations.delete(res.id); r.meter.release(res, 'proxy'); throw e; }
      r.reservations.delete(res.id);
      runs.setModel(p.run_id, p.provider, p.model);
      if (out.networkError) { r.meter.settle(res, null); throw new RequestError('provider_error', 'provider request failed; the reservation was settled at worst case'); }
      if (!out.ok) { r.meter.release(res, `http ${out.status}`); throw new RequestError('provider_rejected', `provider rejected the request (HTTP ${out.status})`); }
      const cost = r.meter.settle(res, out.json?.usage);
      const choice = out.json?.choices?.[0];
      if (!choice || typeof choice !== 'object') throw new RequestError('bad_response', 'provider response has no choices (the call was settled)');
      const u = out.json.usage ?? {};
      return { result: { message: choice.message ?? null, finish_reason: choice.finish_reason ?? null, usage: pick(u, ['prompt_tokens', 'completion_tokens']), cost_micro: cost }, run: r };
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

  return Object.freeze({ handle, openRuns: () => [...open.keys()] });
}
