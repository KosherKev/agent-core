import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/self-model.js';

const script = join(REPO_ROOT, 'scripts', 'build-self-model.js');
const run = (root, ...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'selfmodel-broken-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  return root;
};
const dirs = [];
const mk = (files) => { const d = tree(files); dirs.push(d); return d; };
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GOOD = `export const X_CAPABILITIES = [{ schema_version: '1', name: 'x.do', version: '1.0.0', scopes: ['a:b'], inputs: [], outputs: [], undo: { reversal_steps: ['none'] }, risk_tier: 'low' }];\n`;

test('broken manifest (syntax error): build and --check exit non-zero naming file and error', () => {
  const root = mk({ 'src/a.js': 'export const a = 1;\n', 'src/x-capabilities.js': 'export const X_CAPABILITIES = [ {;\n' });
  for (const args of [[], ['--check']]) {
    const r = run(root, ...args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /src\/x-capabilities\.js: failed to import: .+/);
  }
  assert.equal(existsSync(join(root, 'self-model.json')), false, 'build wrote nothing');
});

test('broken manifest (throws on import): names the file and the error', () => {
  const root = mk({ 'src/x-capabilities.js': "throw new Error('boom-marker');\n" });
  const r = run(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /src\/x-capabilities\.js: failed to import: boom-marker/);
});

test('broken manifest (invalid manifest content or no export): names the file and the error', () => {
  const bad = mk({ 'src/x-capabilities.js': "export const X_CAPABILITIES = [{ name: 'x' }];\n" });
  const r1 = run(bad, '--check');
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /src\/x-capabilities\.js: invalid manifest: \[0\]/);
  const none = mk({ 'src/y-capabilities.js': 'export const other = 1;\n' });
  const r2 = run(none);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /src\/y-capabilities\.js: no exported \*_CAPABILITIES array/);
});

test('missing manifest stays optional: exits 0 and omits capabilities', () => {
  const root = mk({ 'src/a.js': 'export const a = 1;\n' });
  assert.equal(run(root).status, 0);
  const m = JSON.parse(readFileSync(join(root, 'self-model.json'), 'utf8'));
  assert.deepEqual(m.modules, [{ name: 'a', path: 'src/a.js' }]);
  assert.equal(run(root, '--check').status, 0);
});

test('a valid manifest in a temp tree still yields capabilities', () => {
  const root = mk({ 'src/x-capabilities.js': GOOD });
  assert.equal(run(root).status, 0);
  const m = JSON.parse(readFileSync(join(root, 'self-model.json'), 'utf8'));
  assert.equal(m.modules[0].capabilities[0].name, 'x.do');
});

test('the real repo: npm run check:self-model equivalent passes', () => {
  const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
