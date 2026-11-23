import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateSelfModel, serialize, REPO_ROOT } from '../src/self-model.js';
import { validateSelfModel } from '../src/validators.js';

const out = join(REPO_ROOT, 'self-model.json');
const model = generateSelfModel();
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
