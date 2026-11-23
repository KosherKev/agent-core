import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtensionRequest } from '../src/validators.js';
import { fixtureSuite, loadFixtures } from './helpers.js';

fixtureSuite(test, assert, 'extension-request', 'extension-request', validateExtensionRequest);
test('extension-request: missing undo plan is rejected', () => {
  const { undo_plan, ...rest } = loadFixtures('extension-request', 'valid')[0].data;
  assert.equal(validateExtensionRequest(rest).valid, false);
  assert.equal(validateExtensionRequest({ ...rest, undo_plan: {} }).valid, false);
});
