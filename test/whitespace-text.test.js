import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateExtensionRequest } from '../src/validators.js';
import { loadFixtures } from './helpers.js';

// Each whitespace-only fixture must fail for the TARGETED reason: a `pattern` error at the exact path.
const PATTERN = (path) => `${path} must match pattern "\\S"`;
const cases = [
  ['capability-manifest', validateManifest, 'ws-button-space.json', '/undo/button_ref'],
  ['capability-manifest', validateManifest, 'ws-button-newline.json', '/undo/button_ref'],
  ['capability-manifest', validateManifest, 'ws-steps.json', '/undo/reversal_steps/0'],
  ['extension-request', validateExtensionRequest, 'ws-undo-button.json', '/undo_plan/button_ref'],
  ['extension-request', validateExtensionRequest, 'ws-undo-steps.json', '/undo_plan/reversal_steps/0'],
  ['extension-request', validateExtensionRequest, 'ws-why.json', '/why'],
  ['extension-request', validateExtensionRequest, 'ws-proposed-approach.json', '/proposed_approach'],
  ['extension-request', validateExtensionRequest, 'ws-missing-capability.json', '/missing_capability'],
];
for (const [schema, validate, file, path] of cases) {
  test(`whitespace-only: ${schema}/invalid/${file} rejected by pattern at ${path}`, () => {
    const fx = loadFixtures(schema, 'invalid').find((f) => f.file === file);
    assert.ok(fx, `missing fixture ${file}`);
    const r = validate(fx.data);
    assert.equal(r.valid, false);
    assert.ok(r.errors.includes(PATTERN(path)), `expected pattern error at ${path}; got: ${r.errors.join('; ')}`);
    // the only non-anyOf errors are the targeted pattern error (no unrelated reason)
    assert.deepEqual(r.errors.filter((e) => !e.includes('anyOf') && !e.includes('must match a schema in anyOf')), [PATTERN(path)]);
  });
}
test('whitespace-only: text with surrounding whitespace but real content still passes', () => {
  const base = loadFixtures('extension-request', 'valid')[0].data;
  assert.equal(validateExtensionRequest({ ...base, why: ' needs\ncalendar ' }).valid, true);
});
