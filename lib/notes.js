import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { httpError } from './security.js';

const MAX_NOTES = 500;
const MAX_TEXT = 20000;
const MAX_FIELD = 4096;

const cleanField = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_FIELD) throw httpError(400, `${name}无效`);
  return value;
};

// A small note library: an array in one JSON file next to the watchlist. Writes
// go through a temporary file and a rename, so a crash never leaves half a file.
export class NoteStore {
  constructor(file) {
    this.file = file;
    this.notes = this.#load();
  }

  #load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(list)) return [];
      return list.filter(note => note && typeof note.id === 'string' && typeof note.text === 'string'
        && Number.isFinite(note.createdAt));
    } catch {
      return [];
    }
  }

  #save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.notes, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  list() {
    return [...this.notes].sort((a, b) => b.createdAt - a.createdAt);
  }

  add(input = {}) {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw httpError(400, '笔记内容不能为空');
    if (text.length > MAX_TEXT) throw httpError(413, '笔记内容超过 20000 字符');
    const note = {
      id: randomUUID(),
      text,
      repo: cleanField(input.repo, '仓库'),
      file: cleanField(input.file, '文件'),
      from: Number.isInteger(input.from) ? input.from : null,
      to: Number.isInteger(input.to) ? input.to : null,
      createdAt: Date.now()
    };
    this.notes.push(note);
    if (this.notes.length > MAX_NOTES) this.notes = this.notes.slice(-MAX_NOTES);
    this.#save();
    return note;
  }

  remove(id) {
    if (typeof id !== 'string' || !id) throw httpError(400, '笔记标识无效');
    const before = this.notes.length;
    this.notes = this.notes.filter(note => note.id !== id);
    if (this.notes.length === before) throw httpError(404, '笔记不存在');
    this.#save();
    return true;
  }
}
