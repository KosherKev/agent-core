import { validateJournalEntry } from './validators.js';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

/**
 * Create an append-only run journal. The returned API has exactly two
 * operations: `append` and `read`. There is deliberately no edit, update,
 * replace or delete operation, and stored entries are frozen copies.
 */
export function createJournal() {
  const entries = [];
  const ids = new Set();

  const api = {
    /** Validate and append one entry. Returns the stored (frozen) entry. Rejects invalid entries and duplicate ids. */
    append(entry) {
      const r = validateJournalEntry(entry);
      if (!r.valid) throw new Error(`Invalid journal entry: ${r.errors.join('; ')}`);
      if (ids.has(entry.id)) throw new Error(`Duplicate journal entry id: ${entry.id}`);
      const stored = deepFreeze(structuredClone(entry));
      ids.add(stored.id);
      entries.push(stored);
      return stored;
    },
    /** Read entries in append order, optionally filtered by { run_id, kind }. */
    read(filter = {}) {
      return entries
        .filter((e) => (filter.run_id === undefined || e.run_id === filter.run_id) && (filter.kind === undefined || e.kind === filter.kind))
        .map((e) => structuredClone(e));
    },
  };
  return Object.freeze(api);
}
