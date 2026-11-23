/**
 * Money is integer micro-USD (1 USD = 1_000_000). Never a float after conversion.
 * Conversions go through decimal text, never through multiplication of a float.
 */
export const MICRO_PER_USD = 1_000_000;
const MAX_MICRO = 1_000_000_000_000_000; // 1e9 USD, far below 2^53

/**
 * Convert a USD decimal (string, or a finite number) to integer micro-USD.
 * mode "ceil" (default, used for costs) rounds any sub-micro remainder up; "floor" (used for budgets) rounds down.
 * Anything that is not a plain non-negative decimal, or that is too large, throws.
 */
export function usdToMicro(value, mode = 'ceil') {
  let s;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('USD amount must be a finite non-negative number');
    s = value.toFixed(12); // fixed notation, no exponent; 12 digits absorbs binary noise such as 0.1+0.2
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    throw new TypeError('USD amount must be a string or number');
  }
  const m = /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new RangeError('USD amount is not a plain non-negative decimal');
  const frac = (m[2] ?? '').padEnd(6, '0');
  let micro = BigInt(m[1]) * 1_000_000n + BigInt(frac.slice(0, 6));
  if (mode === 'ceil' && /[1-9]/.test(frac.slice(6))) micro += 1n;
  if (micro > BigInt(MAX_MICRO)) throw new RangeError('USD amount is too large');
  return Number(micro);
}

/** micro-USD integer to a decimal USD string (for display only). */
export function microToUsd(micro) {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new RangeError('micro-USD must be a non-negative safe integer');
  return `${Math.floor(micro / MICRO_PER_USD)}.${String(micro % MICRO_PER_USD).padStart(6, '0')}`;
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** Cost in micro-USD of `tokens` at `pricePerMillion` micro-USD per million tokens, rounded up. Exact (BigInt). */
export function tokensCost(tokens, pricePerMillion) {
  if (!isCount(tokens) || !isCount(pricePerMillion)) throw new RangeError('tokens and price must be non-negative safe integers');
  const n = BigInt(tokens) * BigInt(pricePerMillion);
  return Number((n + 999_999n) / 1_000_000n);
}

/** Exact combined cost of input and output tokens, rounded up once (not per part). */
export function callCost(inTokens, outTokens, price) {
  if (!isCount(inTokens) || !isCount(outTokens)) throw new RangeError('token counts must be non-negative safe integers');
  const n = BigInt(inTokens) * BigInt(price.input_micro_per_mtok) + BigInt(outTokens) * BigInt(price.output_micro_per_mtok);
  return Number((n + 999_999n) / 1_000_000n);
}
