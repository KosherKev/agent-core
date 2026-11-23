import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const list = (dir, test) => (existsSync(join(REPO_ROOT, dir)) ? readdirSync(join(REPO_ROOT, dir)).filter(test).sort() : []);

/** All .js files under src/, recursively, as repo-relative paths with "/" separators, sorted (plain string order, locale independent). */
function listSourceFiles(dir = 'src') {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listSourceFiles(rel));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Capability manifests that exist in the repo as exported arrays: src/<x>-capabilities.js exporting a *_CAPABILITIES array.
// They are attached to the module that exports them. A module with none gets no `capabilities` field.
const capabilitiesByPath = new Map();
for (const path of listSourceFiles().filter((f) => /-capabilities\.js$/.test(f))) {
  try {
    const mod = await import(pathToFileURL(join(REPO_ROOT, path)).href);
    const key = Object.keys(mod).sort().find((k) => /_CAPABILITIES$/.test(k) && Array.isArray(mod[k]));
    if (key && mod[key].length) {
      capabilitiesByPath.set(path, mod[key].map((m) => ({ name: m.name, version: m.version, risk_tier: m.risk_tier, scopes: [...m.scopes].sort() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    }
  } catch { /* unreadable manifests: omit the field rather than fail the build */ }
}

/** Build the self-model index from repo contents. Deterministic: no timestamps, sorted output. */
export function generateSelfModel() {
  const modules = listSourceFiles().map((path) => {
    const m = { name: path.slice('src/'.length).replace(/\.js$/, ''), path };
    if (capabilitiesByPath.has(path)) m.capabilities = capabilitiesByPath.get(path);
    return m;
  });
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
