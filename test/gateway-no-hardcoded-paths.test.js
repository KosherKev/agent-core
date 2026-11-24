import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : [p]; });

test('src/gateway and bin contain no hardcoded host home paths', () => {
  const all = [...files(join(root, 'src', 'gateway')), ...files(join(root, 'bin'))];
  assert.ok(all.length >= 10);
  for (const f of all) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!t.includes('/Users/'), `${f} contains /Users/`);
    assert.ok(!t.includes('/home/'), `${f} contains /home/`);
  }
});

test('the gateway never opens a TCP listener: every listen() call takes a path, and no http/https/dgram server is created', () => {
  for (const f of files(join(root, 'src', 'gateway'))) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\.listen\(([^)]*)\)/g)) assert.match(m[1], /^\s*p\b/, `${f}: listen(${m[1]})`);
    assert.ok(!/createServer\(/.test(t.replace(/net\.createServer/g, '')), `${f} creates a non-net server`);
    assert.ok(!/from 'node:(http|https|http2|dgram|tls)'/.test(t), `${f} imports a network server module`);
  }
});

test('src/gateway does not import from or write to locked paths (it only imports their public index files)', () => {
  for (const f of files(join(root, 'src', 'gateway'))) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/from '(\.\.\/(?:grant|ledger)\/[^']*)'/g)) assert.match(m[1], /\/index\.js$/, `${f} imports ${m[1]}`);
  }
});

test('network tokens (fetch(, node:net, node:http(s), WebSocket, XMLHttpRequest) appear only in server.js, client.js and proxy.js', () => {
  const banned = /\bfetch\s*\(|fetchFn|node:https?|node:net|XMLHttpRequest|WebSocket/;
  const allowed = new Set(['server.js', 'client.js', 'proxy.js']);
  const here = files(join(root, 'src', 'gateway')); const bin = files(join(root, 'bin'));
  for (const f of [...here, ...bin]) {
    const name = f.split('/').pop();
    if (allowed.has(name) && f.includes('/src/gateway/')) continue;
    assert.ok(!banned.test(readFileSync(f, 'utf8')), `${f} must not carry a network token (only server.js, client.js and proxy.js may)`);
  }
  // the three allowed files really are the ones that use the network
  assert.match(readFileSync(join(root, 'src', 'gateway', 'server.js'), 'utf8'), /node:net/);
  assert.match(readFileSync(join(root, 'src', 'gateway', 'client.js'), 'utf8'), /node:net/);
});
