import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, ConfineError } from '../src/builder-confine.js';
import { validateGrant } from '../src/validators.js';
import { loadFixtures } from './helpers.js';

const root = mkdtempSync(join(tmpdir(), 'grant-prefix-'));
mkdirSync(join(root, 'src'), { recursive: true });
test.after(() => rmSync(root, { recursive: true, force: true }));
const writable = (paths, p) => { try { confine(root, p, { write: true, allowedPaths: paths }); return true; } catch (e) { if (e instanceof ConfineError) return false; throw e; } };
const fixture = (name) => loadFixtures('grant', 'valid').find((f) => f.file === name).data;

test('scope.paths doc: a prefix entry allows a write under it', () => {
  assert.equal(writable(['src/'], 'src/a.js'), true);
  assert.equal(writable(['src'], 'src/deep/b.js'), true);
});

test('scope.paths doc: src/** is not a glob and allows no write', () => {
  assert.equal(writable(['src/**'], 'src/a.js'), false);
  assert.equal(writable(['src/**'], 'src/deep/b.js'), false);
});

test('scope.paths doc: the new prefix fixture is a valid grant and allows writes; the old src/** fixture is valid and allows none', () => {
  const prefix = fixture('prefix-paths.json');
  assert.equal(validateGrant(prefix).valid, true);
  assert.equal(writable(prefix.scope.paths, 'src/a.js'), true);
  assert.equal(writable(prefix.scope.paths, 'docs/a.md'), true);
  const old = fixture('basic.json');
  assert.equal(validateGrant(old).valid, true);
  assert.equal(writable(old.scope.paths, 'src/a.js'), false);
});

test('scope.paths doc: the schema does not reject glob characters', () => {
  const g = { ...fixture('basic.json'), scope: { repos: ['agent-core'], paths: ['src/**', 'a?b', '[x]', '{a,b}'] } };
  assert.equal(validateGrant(g).valid, true);
});
