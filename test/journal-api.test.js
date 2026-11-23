import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/journal.js';
import * as journalModule from '../src/journal.js';
import { loadFixtures } from './helpers.js';

const valid = () => loadFixtures('run-journal-entry', 'valid');

test('journal API exposes exactly append and read (no edit, update or delete)', () => {
  const j = createJournal();
  assert.deepEqual(Object.keys(j).sort(), ['append', 'read']);
  for (const name of ['edit', 'update', 'delete', 'remove', 'replace', 'set', 'clear', 'splice', 'pop', 'truncate']) {
    assert.equal(j[name], undefined, name);
  }
  assert.deepEqual(Object.keys(journalModule), ['createJournal']);
  assert.ok(Object.isFrozen(j));
});

test('journal API cannot be extended or mutated from outside', () => {
  const j = createJournal();
  assert.throws(() => { 'use strict'; j.delete = () => {}; }, TypeError);
  assert.throws(() => { 'use strict'; j.append = () => {}; }, TypeError);
});

test('append then read returns entries in order', () => {
  const j = createJournal();
  valid().forEach(({ data }, i) => j.append({ ...data, id: `e${i}` }));
  const out = j.read();
  assert.equal(out.length, valid().length);
  assert.deepEqual(out.map((e) => e.id), valid().map((_, i) => `e${i}`));
});

test('returned entries are copies: mutating them does not alter the journal', () => {
  const j = createJournal();
  j.append(valid()[0].data);
  const got = j.read();
  got[0].kind = 'tampered';
  got.pop();
  assert.equal(j.read().length, 1);
  assert.equal(j.read()[0].kind, valid()[0].data.kind);
});

test('the stored entry is frozen and detached from the caller input', () => {
  const j = createJournal();
  const input = structuredClone(valid()[0].data);
  const stored = j.append(input);
  input.id = 'changed';
  assert.equal(j.read()[0].id, valid()[0].data.id);
  assert.throws(() => { 'use strict'; stored.id = 'x'; }, TypeError);
});

test('invalid entries and duplicate ids are rejected', () => {
  const j = createJournal();
  for (const { data } of loadFixtures('run-journal-entry', 'invalid')) assert.throws(() => j.append(data));
  j.append(valid()[0].data);
  assert.throws(() => j.append(valid()[0].data), /Duplicate/);
  assert.equal(j.read().length, 1);
});

test('read filters by run_id and kind', () => {
  const j = createJournal();
  valid().forEach(({ data }, i) => j.append({ ...data, id: `e${i}`, run_id: i % 2 ? 'a' : 'b' }));
  assert.ok(j.read({ run_id: 'a' }).every((e) => e.run_id === 'a'));
  assert.ok(j.read({ kind: 'issue' }).every((e) => e.kind === 'issue'));
});
