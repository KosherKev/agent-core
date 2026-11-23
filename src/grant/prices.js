import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PRICE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'prices.json');
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** A model whose id ends in ":free" costs nothing. Everything else needs an explicit price. */
export const isFreeModelId = (model) => typeof model === 'string' && model.endsWith(':free');

/**
 * Validate a parsed price table: { schema_version: "1", models: { "<id>": { input_micro_per_mtok, output_micro_per_mtok } } }.
 * Prices are integer micro-USD per million tokens. Returns a frozen { models } map; throws on anything malformed.
 */
export function parsePriceTable(data) {
  if (!data || typeof data !== 'object' || data.schema_version !== '1' || !data.models || typeof data.models !== 'object' || Array.isArray(data.models)) {
    throw new Error('price table must be { schema_version: "1", models: {...} }');
  }
  const models = new Map();
  for (const [id, p] of Object.entries(data.models)) {
    if (!id || /\s/.test(id) || !p || !isCount(p.input_micro_per_mtok) || !isCount(p.output_micro_per_mtok)) throw new Error(`price table entry "${id.slice(0, 60)}" is invalid`);
    models.set(id, Object.freeze({ input_micro_per_mtok: p.input_micro_per_mtok, output_micro_per_mtok: p.output_micro_per_mtok }));
  }
  return Object.freeze({ models });
}

/** Load the tracked price file. Returns { table } or { table: null, error } (never throws). */
export function loadPriceTable(path = DEFAULT_PRICE_FILE) {
  try { return { table: parsePriceTable(JSON.parse(readFileSync(path, 'utf8'))) }; } catch (err) { return { table: null, error: String(err.message).slice(0, 200) }; }
}

/** Price for a model: free ids are 0/0, a table hit is its entry, anything else is null (unknown). */
export function priceFor(table, model) {
  if (isFreeModelId(model)) return Object.freeze({ input_micro_per_mtok: 0, output_micro_per_mtok: 0, free: true });
  return table?.models?.get(model) ?? null;
}
