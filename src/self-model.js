import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const list = (dir, test) => (existsSync(join(REPO_ROOT, dir)) ? readdirSync(join(REPO_ROOT, dir)).filter(test).sort() : []);

/** Build the self-model index from repo contents. Deterministic: no timestamps, sorted output. */
export function generateSelfModel() {
  const modules = list('src', (f) => f.endsWith('.js')).map((f) => ({ name: f.replace(/\.js$/, ''), path: `src/${f}` }));
  const contracts = list('schemas', (f) => /^v\d+$/.test(f)).flatMap((v) =>
    list(`schemas/${v}`, (f) => f.endsWith('.schema.json')).map((f) => ({
      name: f.replace('.schema.json', ''), version: v, path: `schemas/${v}/${f}`,
    })));
  const adrs = list('docs/adr', (f) => /^\d{4}-.*\.md$/.test(f)).map((f) => {
    const first = readFileSync(join(REPO_ROOT, 'docs/adr', f), 'utf8').split('\n')[0];
    const m = first.match(/^# (ADR-\d{4}): (.+)$/);
    if (!m) throw new Error(`ADR ${f} must start with "# ADR-NNNN: Title"`);
    return { id: m[1], title: m[2], path: `docs/adr/${f}` };
  });
  return { schema_version: '1', modules, contracts, adrs };
}

export const serialize = (model) => JSON.stringify(model, null, 2) + '\n';
