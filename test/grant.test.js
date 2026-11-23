import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGrant } from '../src/validators.js';
import { fixtureSuite, loadFixtures } from './helpers.js';

fixtureSuite(test, assert, 'grant', 'grant', validateGrant);
test('grant: unknown extra fields are rejected', () => {
  const g = { ...loadFixtures('grant', 'valid')[0].data, extra: 1 };
  assert.equal(validateGrant(g).valid, false);
});
