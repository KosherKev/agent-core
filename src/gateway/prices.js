import { loadPriceTable, parsePriceTable, priceFor } from '../grant/index.js';

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,120}$/;

/**
 * The grant meter prices by one string id. The gateway prices by provider AND model, so it hands the meter the composite
 * key "<provider>|<model>". Provider names never contain "|" so the key is unambiguous. A ":free" model keeps the ":free" suffix,
 * so the meter's own free-model rule still applies to the composite key.
 */
export function priceKey(provider, model) {
  if (typeof provider !== 'string' || !PROVIDER.test(provider)) throw new RangeError('provider name is invalid');
  if (typeof model !== 'string' || !MODEL.test(model)) throw new RangeError('model id is invalid');
  return `${provider}|${model}`;
}

/** Load the tracked price table (config/prices.json) unmodified. Returns { table, error }. */
export const loadGatewayPrices = (path) => loadPriceTable(path);

/**
 * Doctor check (g): the table parses (every entry has both integer prices) and every key is a provider|model composite.
 * A bare model key (the file's older shape) is reported: the gateway never matches it, so it would silently price nothing.
 */
export function checkPriceTable(table) {
  if (!table) return { ok: false, why: 'price table is missing or malformed' };
  const keys = [...table.models.keys()];
  const bare = keys.filter((k) => !k.includes('|'));
  if (bare.length) return { ok: false, why: `price entries must be keyed "provider|model" (bare: ${bare.slice(0, 3).join(', ').slice(0, 80)})` };
  return { ok: true, why: keys.length === 0 ? 'price table is empty (free models only)' : `${keys.length} priced entries, each with both prices` };
}

export { parsePriceTable, priceFor };
