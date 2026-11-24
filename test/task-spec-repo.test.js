import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validators.js';
import { loadFixtures } from './helpers.js';

const GOOD = 'github.com/KosherKev/agent-core';
const v = (d) => validate('task-spec', d);

for (const { file, data } of loadFixtures('task-spec', 'invalid').filter((f) => f.file.startsWith('repo-'))) {
  test(`task-spec repo rule: invalid/${file} fails on the repo pattern and nothing else`, () => {
    const r = v(data);
    assert.equal(r.valid, false);
    assert.deepEqual(r.errors.filter((e) => !e.startsWith('/repo ')), [], 'only /repo errors');
    assert.ok(r.errors.some((e) => e.startsWith('/repo must match pattern')), r.errors.join('; '));
    assert.equal(v({ ...data, repo: GOOD }).valid, true, 'same document with a good repo passes');
  });
}

test('task-spec repo rule: accepted shapes', () => {
  for (const repo of [GOOD, 'github.com/o/n', 'git.example.co.uk/my_org/my.repo-1', 'gitlab.com/a.b/c_d', 'github.com/o/git', 'github.com/o/a.gitx', 'github.com/o/...', 'github.com/' + 'a'.repeat(100) + '/' + 'b'.repeat(100)])
    assert.equal(v({ schema_version: '1', goal: 'g', repo, grant_ref: 'T-1' }).valid, true, repo);
});
