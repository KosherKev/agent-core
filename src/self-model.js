import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from './validators.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const list = (dir, test, root = REPO_ROOT) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter(test).sort() : []);

/** All .js files under src/, recursively, as repo-relative paths with "/" separators, sorted (plain string order, locale independent). */
function listSourceFiles(dir = 'src', root = REPO_ROOT) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listSourceFiles(rel, root));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Load capability manifests under <root>/src: every src/**\/<x>-capabilities.js must export a *_CAPABILITIES array
 * whose entries are valid capability manifests. Returns { byPath, errors }; errors is [{ path, error }] for each file
 * that is present but fails to import, has no such export, or holds an invalid manifest. A missing file is not an error:
 * a module with no manifest file simply has no `capabilities` field. Never throws.
 */
export async function loadCapabilities(root = REPO_ROOT) {
  const byPath = new Map();
  const errors = [];
  for (const path of listSourceFiles('src', root).filter((f) => /-capabilities\.js$/.test(f))) {
    try {
      const mod = await import(pathToFileURL(join(root, path)).href);
      const key = Object.keys(mod).sort().find((k) => /_CAPABILITIES$/.test(k) && Array.isArray(mod[k]));
      if (!key) { errors.push({ path, error: 'no exported *_CAPABILITIES array' }); continue; }
      const bad = mod[key].map((m, i) => ({ i, r: validateManifest(m) })).filter((x) => !x.r.valid);
      if (bad.length) { errors.push({ path, error: `invalid manifest: ${bad.map((x) => `[${x.i}] ${x.r.errors.join(', ')}`).join('; ')}` }); continue; }
      if (mod[key].length) {
        byPath.set(path, mod[key].map((m) => ({ name: m.name, version: m.version, risk_tier: m.risk_tier, scopes: [...m.scopes].sort() }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
      }
    } catch (e) {
      errors.push({ path, error: `failed to import: ${e && e.message ? e.message : String(e)}` });
    }
  }
  return { byPath, errors };
}

export const formatCapabilityErrors = (errors) => errors.map((e) => `${e.path}: ${e.error}`).join('\n');

const defaultLoad = await loadCapabilities();

/**
 * Build the self-model index from repo contents. Deterministic: no timestamps, sorted output.
 * `root` and `loaded` (a loadCapabilities result) default to this repo; a present-but-broken capability manifest throws.
 */
export function generateSelfModel(root = REPO_ROOT, loaded = defaultLoad) {
  if (loaded.errors.length) throw new Error(`capability manifest error:\n${formatCapabilityErrors(loaded.errors)}`);
  const capabilitiesByPath = loaded.byPath;
  const modules = listSourceFiles('src', root).map((path) => {
    const m = { name: path.slice('src/'.length).replace(/\.js$/, ''), path };
    if (capabilitiesByPath.has(path)) m.capabilities = capabilitiesByPath.get(path);
    return m;
  });
  const contracts = list('schemas', (f) => /^v\d+$/.test(f), root).flatMap((v) =>
    list(`schemas/${v}`, (f) => f.endsWith('.schema.json'), root).map((f) => ({
      name: f.replace('.schema.json', ''), version: v, path: `schemas/${v}/${f}`,
    })));
  const adrs = list('docs/adr', (f) => /^\d{4}-.*\.md$/.test(f), root).map((f) => {
    const first = readFileSync(join(root, 'docs/adr', f), 'utf8').split('\n')[0];
    const m = first.match(/^# (ADR-\d{4}): (.+)$/);
    if (!m) throw new Error(`ADR ${f} must start with "# ADR-NNNN: Title"`);
    return { id: m[1], title: m[2], path: `docs/adr/${f}` };
  });
  return { schema_version: '1', modules, contracts, adrs };
}

export const serialize = (model) => JSON.stringify(model, null, 2) + '\n';
