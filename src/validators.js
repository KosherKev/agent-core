import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = join(root, 'schemas', 'v1');

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);

export const schemas = {};
for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.schema.json')).sort()) {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
  const name = f.replace('.schema.json', '');
  schemas[name] = schema;
  ajv.addSchema(schema, name);
}

/** Validate `data` against a named contract schema. Returns { valid, errors }. */
export function validate(name, data) {
  const fn = ajv.getSchema(name);
  if (!fn) throw new Error(`Unknown schema: ${name}`);
  const valid = fn(data);
  return { valid, errors: valid ? [] : fn.errors.map((e) => `${e.instancePath || '/'} ${e.message}`) };
}

export const validateManifest = (d) => validate('capability-manifest', d);
export const validateExtensionRequest = (d) => validate('extension-request', d);
export const validateJournalEntry = (d) => validate('run-journal-entry', d);
export const validateGrant = (d) => validate('grant', d);
export const validateSelfModel = (d) => validate('self-model', d);
