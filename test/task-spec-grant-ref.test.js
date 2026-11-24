import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskSpec, checkGrantRef } from '../src/task-spec.js';
import { loadFixtures } from './helpers.js';

const grant = loadFixtures('grant', 'valid')[0].data;
const base = { schema_version: '1', goal: 'g', repo: 'github.com/KosherKev/agent-core' };

test('task-spec helper: grant_ref only passes', () => {
  assert.equal(validateTaskSpec({ ...base, grant_ref: 'T-9' }).valid, true);
});

test('task-spec helper: embedded grant only passes', () => {
  assert.equal(validateTaskSpec({ ...base, grant }).valid, true);
});

const pass = () => ({ valid: true, errors: [] });

test('task-spec helper: both present and equal passes the cross-check', () => {
  const spec = { ...base, grant, grant_ref: grant.task_id };
  assert.equal(checkGrantRef(spec).valid, true);
  assert.equal(validateTaskSpec(spec, pass).valid, true);
});

test('task-spec helper: both present and different fails with a clear error', () => {
  const spec = { ...base, grant, grant_ref: 'T-OTHER' };
  for (const r of [checkGrantRef(spec), validateTaskSpec(spec, pass)]) {
    assert.equal(r.valid, false);
    assert.deepEqual(r.errors, [`/grant_ref "T-OTHER" does not match /grant/task_id "${grant.task_id}"`]);
  }
});

test('task-spec helper: with the real v1 schema, both forms are still refused (by the schema, before the cross-check)', () => {
  const r = validateTaskSpec({ ...base, grant, grant_ref: 'T-OTHER' });
  assert.equal(r.valid, false);
  assert.ok(!r.errors.some((e) => e.includes('does not match')));
});

test('task-spec helper: schema failure surfaces first', () => {
  const r = validateTaskSpec({ ...base, repo: 'agent-core', grant, grant_ref: 'T-OTHER' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.startsWith('/repo ')));
  assert.ok(!r.errors.some((e) => e.includes('does not match')));
});
