import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load fixtures/<schema>/<kind>/*.json as [{file, data}]. */
export function loadFixtures(schema, kind) {
  const dir = join(root, 'fixtures', schema, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}
