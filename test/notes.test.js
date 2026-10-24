import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NoteStore } from '../lib/notes.js';

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'notes.json');
}

test('notes are stored, listed newest first, reloaded from disk and removed', async t => {
  const file = tempFile(t);
  const store = new NoteStore(file);
  const first = store.add({ text: '  first note  ', repo: '/repo', file: 'src/a.js', from: 3, to: 5 });
  await new Promise(resolve => setTimeout(resolve, 5));
  store.add({ text: 'second' });

  assert.equal(first.text, 'first note');
  assert.deepEqual(store.list().map(note => note.text), ['second', 'first note']);

  const reloaded = new NoteStore(file);
  assert.equal(reloaded.list().length, 2);
  reloaded.remove(first.id);
  assert.deepEqual(new NoteStore(file).list().map(note => note.text), ['second']);
  assert.throws(() => reloaded.remove(first.id), /不存在/);
});

test('empty and oversized notes are rejected', async t => {
  const store = new NoteStore(tempFile(t));
  assert.throws(() => store.add({ text: '   ' }), /不能为空/);
  assert.throws(() => store.add({ text: 'x'.repeat(20001) }), /20000/);
  assert.throws(() => store.add({ text: 'ok', file: 42 }), /文件/);
});
