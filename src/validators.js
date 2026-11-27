import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = join(root, 'schemas', 'v1');
export const SCHEMA_DIR_V2 = join(root, 'schemas', 'v2');

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);

export const schemas = {};
for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.schema.json')).sort()) {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'));
  const name = f.replace('.schema.json', '');
  schemas[name] = schema;
  ajv.addSchema(schema, name);
}

// v2 schemas are registered under their own $id (capability-manifest-v2, grant-v2, ...), never under the v1 names.
for (const f of readdirSync(SCHEMA_DIR_V2).filter((n) => n.endsWith('.schema.json')).sort()) {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR_V2, f), 'utf8'));
  schemas[schema.$id] = schema;
  ajv.addSchema(schema, schema.$id);
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

// v2 schema-only wrappers (ADR-0007). Cross-field and cross-document checks live in src/capability-v2.js.
export const validateManifestV2Schema = (d) => validate('capability-manifest-v2', d);
export const validateGrantV2Schema = (d) => validate('grant-v2', d);
export const validateTrustRegistryV2Schema = (d) => validate('trust-registry-v2', d);
export const validateScopesV2Schema = (d) => validate('capability-scopes-v2', d);
