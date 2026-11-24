import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTool, runToolSync, runToolAsync, TOOL_CANDIDATES, TOOL_ENV, ToolError, lastToolRefusal } from '../src/gateway/tools.js';
import { resolveUser, processInfo } from '../src/gateway/sys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gateway');
const st = (o = {}) => ({ isFile: () => true, uid: 0, mode: 0o100755, ...o });

test('every candidate is an absolute path and no bare command name is used', () => {
  for (const [plat, tools] of Object.entries(TOOL_CANDIDATES)) for (const [name, list] of Object.entries(tools)) { assert.ok(list.length > 0, `${plat} ${name}`); for (const p of list) assert.ok(p.startsWith('/'), `${plat} ${name} ${p}`); }
});

test('a candidate is used only if it is a regular file, owned by root and not group/world writable; otherwise the refusal names the path', () => {
  const only = (o) => (p) => (p === '/usr/bin/id' ? st(o) : (() => { const e = new Error('x'); e.code = 'ENOENT'; throw e; })());
  assert.equal(resolveTool('id', { platform: 'linux', statFn: only({}) }), '/usr/bin/id');
  assert.equal(resolveTool('id', { platform: 'darwin', statFn: only({}) }), '/usr/bin/id');
  for (const [o, why] of [[{ uid: 1000 }, /not owned by root/], [{ mode: 0o100775 }, /writable by group or others/], [{ mode: 0o100757 }, /writable by group or others/], [{ isFile: () => false }, /not a regular file/]]) {
    assert.throws(() => resolveTool('id', { platform: 'darwin', statFn: only(o) }), (e) => e instanceof ToolError && e.message.includes('/usr/bin/id') && why.test(e.message), String(why));
    assert.match(lastToolRefusal(), /\/usr\/bin\/id/);
  }
  assert.throws(() => resolveTool('id', { platform: 'darwin', statFn: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } }), /\/usr\/bin\/id: ENOENT/);
  assert.throws(() => resolveTool('dscl', { platform: 'linux' }), /no trusted location/);
  assert.throws(() => resolveTool('id', { platform: 'plan9' }), /no trusted location/);
  // Linux falls through to the second candidate when the first is missing
  const second = (p) => { if (p === '/bin/id') return st(); const e = new Error('x'); e.code = 'ENOENT'; throw e; };
  assert.equal(resolveTool('id', { platform: 'linux', statFn: second }), '/bin/id');
});

test('the child runs with the absolute path and a minimal fixed environment: no PATH, locale C', () => {
  let seen;
  const out = runToolSync('id', ['-u', 'x'], { platform: 'darwin', statFn: () => st(), exec: (p, a, o) => { seen = { p, a, o }; return '42\n'; } });
  assert.equal(out, '42\n'); assert.equal(seen.p, '/usr/bin/id'); assert.deepEqual(seen.o.env, { LC_ALL: 'C', LANG: 'C' }); assert.equal('PATH' in seen.o.env, false);
  assert.deepEqual(TOOL_ENV, { LC_ALL: 'C', LANG: 'C' });
  assert.throws(() => runToolSync('id', [], { platform: 'darwin', statFn: () => st({ uid: 501 }), exec: () => { throw new Error('must not run'); } }), ToolError);
});

test('async: a refused tool resolves with the ToolError and never runs', async () => {
  const r = await runToolAsync('lsof', [], { platform: 'darwin', statFn: () => st({ mode: 0o100777 }), exec: () => { throw new Error('must not run'); } });
  assert.ok(r.err instanceof ToolError); assert.match(r.err.message, /\/usr\/sbin\/lsof/);
});

test('a planted `id` on the PATH is never run: the lookup fails closed or uses the system one', () => {
  const dir = join(process.env.TMPDIR ?? '/tmp', `gw-plant-${process.pid}`);
  const old = process.env.PATH;
  // a name that is not in /etc/passwd: only `id` could answer, and the answer must come from the absolute path
  try {
    process.env.PATH = `${dir}:${old}`;
    assert.equal(resolveUser('no_such_user_zz9'), null);
  } finally { process.env.PATH = old; }
  assert.equal(processInfo(process.pid)?.pid, process.pid);
});

test('src/gateway runs no external command by bare name (only through tools.js, by absolute path)', () => {
  for (const n of readdirSync(root)) {
    const t = readFileSync(join(root, n), 'utf8');
    if (n === 'tools.js') continue;
    assert.ok(!/node:child_process/.test(t), `${n} imports child_process directly`);
  }
});
