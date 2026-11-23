import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validators.js';
import { fixtureSuite, loadFixtures } from './helpers.js';

const validateTaskSpec = (d) => validate('task-spec', d);
fixtureSuite(test, assert, 'task-spec', 'task-spec', validateTaskSpec);

const ok = { schema_version: '1', goal: 'g', repo: 'github.com/KosherKev/agent-core', grant_ref: 'T-1' };

test('task-spec: targeted rules', () => {
  assert.equal(validateTaskSpec(ok).valid, true);
  for (const bad of [
    { ...ok, repo: 'agent-core' }, { ...ok, repo: 'KosherKev/agent-core' }, { ...ok, repo: 'github.com/a/b/c' },
    { ...ok, goal: '' }, { ...ok, goal: ' \n' }, { ...ok, branch: ' ' }, { ...ok, schema_version: '2' },
  ]) assert.equal(validateTaskSpec(bad).valid, false, JSON.stringify(bad));
  const { grant_ref, ...none } = ok;
  assert.equal(validateTaskSpec(none).valid, false);
});

test('task-spec: an embedded grant must itself be a valid grant', () => {
  const g = loadFixtures('grant', 'valid')[0].data;
  assert.equal(validateTaskSpec({ ...ok, grant_ref: undefined, grant: g }).valid, true);
  assert.equal(validateTaskSpec({ ...ok, grant_ref: undefined, grant: { ...g, expires_at: 'soon' } }).valid, false);
});
