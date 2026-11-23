import { usdToMicro, callCost } from './money.js';
import { priceFor, parsePriceTable } from './prices.js';
import { parseExpiry } from './expiry.js';

/** Why a meter refused. `limit` is one of: budget, tool_calls, expiry, clock, grant, price, internal. */
export class GrantError extends Error {
  constructor(limit, message, numbers = {}) {
    super(message);
    this.name = 'GrantError';
    this.limit = limit;
    this.numbers = Object.freeze({ ...numbers });
  }
}

/** Limits that mean "the grant ran out" (exit code grant-exceeded). The others are refusals of an unusable grant/price/clock. */
export const EXCEEDED_LIMITS = Object.freeze(['budget', 'tool_calls', 'expiry', 'clock']);

export const CLOCK_TOLERANCE_MS = 1000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

const BRAND = new WeakSet();
/** True only for meters made by createMeter. The adapter's model-call and tool-dispatch functions refuse anything else. */
export const isMeter = (m) => typeof m === 'object' && m !== null && BRAND.has(m);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** Upper bound on input tokens: one token per UTF-8 byte of the serialised request (a token is never shorter than a byte). */
function estimateInputTokens(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return Buffer.byteLength(text, 'utf8');
}

/**
 * The grant meter: the only thing that decides whether a model call or a tool call may happen (R3/R4).
 *
 * createMeter(grant, { now, priceTable, model, sink })
 *  - grant: the schemas/v1 grant. It is deep-copied and deep-frozen; the meter has no setter for any field.
 *  - now: injectable clock, () => epoch milliseconds (default Date.now).
 *  - priceTable: result of parsePriceTable (tracked config/prices.json). Unknown paid model => createMeter throws.
 *  - model: the model id this run will use; priced up front so an unpriced model is refused before any network call.
 *  - sink: optional (record) => void for the append-only spend record. If it throws, the meter refuses (fail closed).
 *
 * Every public method fails closed: any internal error becomes a GrantError and means "refuse".
 */
export function createMeter(grant, { now = Date.now, priceTable, model, sink } = {}) {
  const guard = (fn) => (...args) => {
    try { return fn(...args); } catch (err) {
      if (err instanceof GrantError) throw err;
      throw new GrantError('internal', 'meter error; refusing (fail closed)');
    }
  };

  const make = () => {
    if (typeof now !== 'function') throw new GrantError('grant', 'meter needs a clock');
    if (!grant || typeof grant !== 'object') throw new GrantError('grant', 'no grant: refusing');
    const g = deepFreeze(structuredClone(grant));
    const maxUsd = g.budget?.max_usd;
    const maxCalls = g.budget?.max_tool_calls;
    if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd <= 0) throw new GrantError('grant', 'grant budget.max_usd is missing or invalid');
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new GrantError('grant', 'grant budget.max_tool_calls is missing or invalid');
    const expiresAt = parseExpiry(g.expires_at);
    if (Number.isNaN(expiresAt)) throw new GrantError('grant', 'grant expires_at is missing or invalid');
    const budgetMicro = usdToMicro(maxUsd, 'floor'); // round the budget down: restrictive
    if (budgetMicro < 1) throw new GrantError('grant', 'grant budget.max_usd is below one micro-USD');

    let table = priceTable;
    if (table && !table.models?.get) table = parsePriceTable(table); // accept a plain parsed object too
    const price = priceFor(table, model);
    if (model !== undefined && price === null) throw new GrantError('price', `no trusted price for model "${String(model).slice(0, 80)}" and the grant has a nonzero budget; refusing`);

    const state = { settled: 0, toolCalls: 0, seq: 0, lastNow: null, open: new Map() };
    const reservedTotal = () => { let t = 0; for (const r of state.open.values()) t += r.reserved; return t; };
    const remaining = () => budgetMicro - state.settled - reservedTotal();
    const spendLog = [];
    const record = (r) => {
      const line = Object.freeze({ v: 1, seq: spendLog.length + 1, at: new Date(state.lastNow).toISOString(), ...r, settled_total_micro: state.settled, remaining_micro: budgetMicro - state.settled - reservedTotal() });
      spendLog.push(line);
      if (sink) sink(line);
    };

    const tick = () => {
      const t = now();
      if (!Number.isFinite(t)) throw new GrantError('clock', 'clock returned a non-finite time', {});
      if (state.lastNow !== null && t < state.lastNow - CLOCK_TOLERANCE_MS) throw new GrantError('clock', 'clock moved backwards; refusing', { now_ms: t, previous_ms: state.lastNow });
      state.lastNow = Math.max(t, state.lastNow ?? t);
      return t;
    };
    const checkExpiry = () => {
      const t = tick();
      if (t >= expiresAt) throw new GrantError('expiry', 'grant has expired', { now_ms: t, expires_at_ms: expiresAt });
    };
    const priceOf = (m) => { const p = m === undefined ? price : priceFor(table, m); if (p === null || p === undefined) throw new GrantError('price', 'no trusted price for this model; refusing'); return p; };

    const api = {
      /** Check expiry and the tool-call limit, then count one tool call. */
      checkTool: guard(() => {
        checkExpiry();
        if (state.toolCalls >= maxCalls) throw new GrantError('tool_calls', 'grant tool-call limit reached', { used: state.toolCalls, max: maxCalls });
        state.toolCalls += 1;
        return state.toolCalls;
      }),
      checkExpiry: guard(checkExpiry),

      /**
       * Reserve the worst-case cost of one model call before it is made.
       * call: { model?, input, max_tokens? }. Returns { id, max_tokens, reserved_micro }; max_tokens is clamped so the
       * worst case fits the remaining budget. Refuses (GrantError budget) if even one output token does not fit.
       */
      reserve: guard((call = {}) => {
        checkExpiry();
        const p = priceOf(call.model);
        const wanted = call.max_tokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : call.max_tokens;
        if (!Number.isSafeInteger(wanted) || wanted < 1) throw new GrantError('grant', 'call max_tokens must be a positive integer');
        const inTokens = estimateInputTokens(call.input);
        const left = remaining();
        let maxTokens = wanted;
        if (callCost(inTokens, wanted, p) > left) {
          // Largest output that still fits: binary search over exact integer costs (no float division).
          let lo = 0; let hi = wanted - 1;
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (callCost(inTokens, mid, p) <= left) lo = mid; else hi = mid - 1; }
          if (lo < 1 || callCost(inTokens, lo, p) > left) throw new GrantError('budget', 'worst-case cost of this call exceeds the remaining budget', { worst_case_micro: callCost(inTokens, wanted, p), remaining_micro: Math.max(left, 0), budget_micro: budgetMicro });
          maxTokens = lo;
        }
        const reserved = callCost(inTokens, maxTokens, p);
        const id = `r${++state.seq}`;
        state.open.set(id, { reserved, inTokens, maxTokens, price: p });
        record({ event: 'reserve', call_id: id, model: call.model ?? model ?? null, input_tokens_est: inTokens, max_tokens: maxTokens, clamped: maxTokens !== wanted, reserved_micro: reserved });
        return Object.freeze({ id, max_tokens: maxTokens, reserved_micro: reserved });
      }),

      /**
       * Replace a reservation with the actual cost. usage: { prompt_tokens, completion_tokens, cost? } or null/undefined.
       * Paid model: the higher of provider-reported usage.cost and the cost computed from token counts and the
       * price table (a reported 0, negative, non-finite or non-number cost is never trusted below computed); with no usable
       * usage, the full reservation. Free model: reported cost if valid, else 0. Never zero for a paid model without evidence.
       */
      settle: guard((reservation, usage) => {
        const open = state.open.get(reservation?.id);
        if (!open) throw new GrantError('internal', 'settle without an open reservation');
        let cost; let source;
        let provider = null;
        if (usage && usage.cost !== undefined && usage.cost !== null) { try { provider = usdToMicro(usage.cost, 'ceil'); } catch { provider = null; } }
        const free = open.price.input_micro_per_mtok === 0 && open.price.output_micro_per_mtok === 0;
        const computed = usage && isCount(usage.prompt_tokens) && isCount(usage.completion_tokens) ? callCost(usage.prompt_tokens, usage.completion_tokens, open.price) : null;
        if (free) {
          if (provider !== null) { cost = provider; source = 'provider'; } else { cost = 0; source = 'free'; }
        } else if (computed !== null) {
          // A reported cost is never trusted below the computed cost; higher wins. Malformed reported costs were dropped above.
          if (provider !== null && provider >= computed) { cost = provider; source = 'provider'; } else { cost = computed; source = 'computed'; }
        } else { cost = open.reserved; source = 'worst_case'; }
        state.open.delete(reservation.id);
        state.settled += cost;
        record({ event: 'settle', call_id: reservation.id, source, cost_micro: cost, reserved_micro: open.reserved });
        return cost;
      }),

      /** The provider rejected the request before generating anything (HTTP error with an error body): release the reservation at zero. */
      release: guard((reservation, reason) => {
        const open = state.open.get(reservation?.id);
        if (!open) throw new GrantError('internal', 'release without an open reservation');
        state.open.delete(reservation.id);
        record({ event: 'release', call_id: reservation.id, source: 'rejected', cost_micro: 0, reserved_micro: open.reserved, reason: String(reason ?? '').slice(0, 60) });
        return 0;
      }),

      /** Read-only snapshot (integers). */
      snapshot: () => Object.freeze({ budget_micro: budgetMicro, settled_micro: state.settled, reserved_micro: reservedTotal(), remaining_micro: remaining(), tool_calls: state.toolCalls, max_tool_calls: maxCalls, expires_at_ms: expiresAt }),
      spendLog: () => [...spendLog],
      get grant() { return g; },
    };
    BRAND.add(api);
    return Object.freeze(api);
  };

  try { return make(); } catch (err) {
    if (err instanceof GrantError) throw err;
    throw new GrantError('grant', 'could not build a meter from this grant; refusing (fail closed)');
  }
}
