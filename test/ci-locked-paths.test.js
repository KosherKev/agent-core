import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocked, isLocked, violations, isAgentAuthored } from '../.github/scripts/locked-paths.mjs';

const locked = parseLocked('# c\nacceptance/\n.github/\n');

test('locked-paths: parse ignores comments and blanks', () => assert.deepEqual(locked, ['acceptance/', '.github/']));
test('locked-paths: directory prefixes match, siblings do not', () => {
  assert.equal(isLocked('acceptance/contracts.test.js', locked), true);
  assert.equal(isLocked('.github/CODEOWNERS', locked), true);
  assert.equal(isLocked('acceptance-notes.md', locked), false);
  assert.equal(isLocked('src/journal.js', locked), false);
});
test('locked-paths: violations lists only locked files', () =>
  assert.deepEqual(violations(['src/a.js', 'acceptance/x.js'], locked), ['acceptance/x.js']));
test('locked-paths: agent detection by branch, bot actor, or flag', () => {
  assert.equal(isAgentAuthored({ headRef: 'task/foo' }), true);
  assert.equal(isAgentAuthored({ headRef: 'agent/foo' }), true);
  assert.equal(isAgentAuthored({ actor: 'dependabot[bot]' }), true);
  assert.equal(isAgentAuthored({ flag: 'true' }), true);
  assert.equal(isAgentAuthored({ headRef: 'feature/x', actor: 'KosherKev', flag: 'false' }), false);
});
