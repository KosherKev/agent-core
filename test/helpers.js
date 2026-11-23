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

/** Register fixture tests for a schema using node:test. */
export function fixtureSuite(test, assert, schema, label, validateFn) {
  test(`${label}: valid and invalid fixtures exist`, () => {
    assert.ok(loadFixtures(schema, 'valid').length >= 1);
    assert.ok(loadFixtures(schema, 'invalid').length >= 1);
  });
  for (const { file, data } of loadFixtures(schema, 'valid')) {
    test(`${label}: valid/${file} passes`, () => {
      const r = validateFn(data);
      assert.equal(r.valid, true, r.errors.join('; '));
    });
  }
  for (const { file, data } of loadFixtures(schema, 'invalid')) {
    test(`${label}: invalid/${file} is rejected`, () => {
      assert.equal(validateFn(data).valid, false);
    });
  }
}
