// Characterization tests: they pin what the code does today so docs/adr/0004-grant.md (addendum) stays true. They do not define new behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confine, ConfineError } from '../src/builder-confine.js';

const root = mkdtempSync(join(tmpdir(), 'grant-sem-'));
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'srcx'), { recursive: true });
mkdirSync(join(root, 'docs'), { recursive: true });
test.after(() => rmSync(root, { recursive: true, force: true }));

const writable = (paths, p) => { try { confine(root, p, { write: true, allowedPaths: paths }); return true; } catch (e) { if (e instanceof ConfineError) return false; throw e; } };

test('scope.paths: entries are relative prefixes matched on whole path segments', () => {
  assert.equal(writable(['src'], 'src/a.js'), true);
  assert.equal(writable(['src/'], 'src/a.js'), true);
  assert.equal(writable(['./src'], 'src/a.js'), true);
  assert.equal(writable(['src'], 'srcx/a.js'), false);
  assert.equal(writable(['src'], 'docs/a.md'), false);
  assert.equal(writable(['src', 'docs'], 'docs/a.md'), true);
});

test('scope.paths: ".", "", "*" and "**" mean everything; other globs are not expanded', () => {
  for (const all of ['.', './', '', '*', '**']) assert.equal(writable([all], 'docs/a.md'), true, JSON.stringify(all));
  assert.equal(writable(['src/**'], 'src/a.js'), false, 'src/** is a literal prefix, not a glob');
  assert.equal(writable(['src/*'], 'src/a.js'), false);
});

test('scope.paths: locked paths stay refused even when the grant covers everything', () => {
  assert.equal(writable(['**'], 'acceptance/x.test.js'), false);
  assert.equal(writable(['**'], '.github/CODEOWNERS'), false);
});

test('scope.paths: only writes are restricted by the grant; reads are not', () => {
  assert.doesNotThrow(() => confine(root, 'docs', { allowedPaths: ['src'] }));
});
