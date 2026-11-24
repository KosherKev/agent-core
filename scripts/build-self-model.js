import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateSelfModel, serialize, loadCapabilities, formatCapabilityErrors, REPO_ROOT } from '../src/self-model.js';
import { validateSelfModel } from '../src/validators.js';

// --root <dir> points the generator at another tree (used by tests with a temp dir); default is this repo.
const ri = process.argv.indexOf('--root');
const root = ri >= 0 ? resolve(process.argv[ri + 1] ?? '') : REPO_ROOT;
const out = join(root, 'self-model.json');

// A present-but-broken capability manifest fails both the build and --check. A missing manifest is optional.
const loaded = await loadCapabilities(root);
if (loaded.errors.length) {
  console.error(`Capability manifest error:\n${formatCapabilityErrors(loaded.errors)}`);
  process.exit(1);
}
const model = generateSelfModel(root, loaded);
const r = validateSelfModel(model);
if (!r.valid) { console.error('Generated self-model is invalid:', r.errors.join('; ')); process.exit(1); }
const text = serialize(model);

if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== text) {
    console.error('self-model.json is stale. Run: npm run build');
    process.exit(1);
  }
  console.log('self-model.json is up to date');
} else {
  writeFileSync(out, text);
  console.log(`wrote self-model.json (${model.modules.length} modules, ${model.contracts.length} contracts, ${model.adrs.length} ADRs)`);
}
