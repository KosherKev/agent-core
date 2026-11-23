import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * Append-only spend sidecar: one JSON line per reserve/settle/release, written with the 'a' flag, never rewritten.
 * `redact` is applied to the serialised line. Returns a sink for createMeter; a write failure throws, which the meter turns into a refusal.
 */
export function createSpendSink(path, redact = (s) => s) {
  writeFileSync(path, '', { flag: 'a' });
  return (line) => appendFileSync(path, redact(JSON.stringify(line)) + '\n', { flag: 'a' });
}
