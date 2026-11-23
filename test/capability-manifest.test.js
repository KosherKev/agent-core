import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../src/validators.js';
import { loadFixtures } from './helpers.js';

const S = 'capability-manifest';
test('manifest: at least one valid and one invalid fixture exist', () => {
  assert.ok(loadFixtures(S, 'valid').length >= 1);
  assert.ok(loadFixtures(S, 'invalid').length >= 1);
});
for (const { file, data } of loadFixtures(S, 'valid')) {
  test(`manifest: valid/${file} passes`, () => {
    const r = validateManifest(data);
    assert.equal(r.valid, true, r.errors.join('; '));
  });
}
for (const { file, data } of loadFixtures(S, 'invalid')) {
  test(`manifest: invalid/${file} is rejected`, () => {
    assert.equal(validateManifest(data).valid, false);
  });
}
test('manifest: neither button reference nor reversal steps is rejected (R1)', () => {
  const base = loadFixtures(S, 'valid')[0].data;
  const { undo, ...noUndo } = base;
  assert.equal(validateManifest(noUndo).valid, false);
  assert.equal(validateManifest({ ...base, undo: {} }).valid, false);
  assert.equal(validateManifest({ ...base, undo: { reversal_steps: [] } }).valid, false);
  assert.equal(validateManifest({ ...base, undo: { button_ref: 'b' } }).valid, true);
  assert.equal(validateManifest({ ...base, undo: { reversal_steps: ['s'] } }).valid, true);
});
