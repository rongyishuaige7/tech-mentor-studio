import path from 'node:path';
import { runGit } from './git.js';
import { readRepoText, isSensitiveFile, httpError } from './security.js';

export function evidenceRevision(diff) {
  return diff.resolvedTarget === 'working-tree' ? null : diff.resolvedTarget.split(/\.\.\.?/).at(-1);
}

const MAX_EVIDENCE_BYTES = 500000;
// Aborts, timeouts and the output cap end the whole request; any other failure
// belongs to the one file that caused it.
const isFatal = error => error.name === 'AbortError' || error.status === 504 || error.status === 413;
const missing = () => Object.assign(new Error('文件在所选版本不存在'), { code: 'ENOENT' });
const invalidName = name => typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\0')
  || name.split('/').some(part => part === '..' || part.toLowerCase() === '.git') || isSensitiveFile(name);

function chunkBy(items, sizeOf, limit) {
  const groups = []; let group = [], used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (group.length && used + size > limit) { groups.push(group); group = []; used = 0; }
    group.push(item); used += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

// Reads evidence files from one revision with two git processes in total: one
// `ls-tree -l` for modes, sizes and object IDs, one `cat-file --batch` for the
// contents. Each file keeps its own outcome, `{ text }` or `{ error }`, so one
// link or oversized blob never hides the others. Worktree reads use the file
// system directly.
export async function readVersionTexts(repo, names, revision, options) {
  const results = new Map();
  const unique = [...new Set(names)];
  if (!revision) {
    for (const name of unique) {
      try { results.set(name, { text: readRepoText(repo, name) }); } catch (error) { results.set(name, { error }); }
    }
    return results;
  }
  const wanted = [];
  for (const name of unique) {
    if (invalidName(name)) results.set(name, { error: httpError(400, '证据文件路径无效') });
    else wanted.push(name);
  }
  const entries = new Map();
  // Grouped so each command line stays far below the OS argument limit.
  for (const group of chunkBy(wanted, name => Buffer.byteLength(name) + 1, 64 * 1024)) {
    let output;
    try { output = await runGit(['--literal-pathspecs', 'ls-tree', '-l', '-z', revision, '--', ...group], repo, options); }
    catch (error) { if (isFatal(error)) throw error; for (const name of group) results.set(name, { error }); continue; }
    for (const record of output.split('\0')) {
      const tab = record.indexOf('\t'); if (tab < 0) continue;
      const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
      entries.set(record.slice(tab + 1), { mode, type, object, size: Number(size) });
    }
  }
  const blobs = [];
  for (const name of wanted) {
    if (results.has(name)) continue;
    const entry = entries.get(name);
    if (!entry) results.set(name, { error: missing() });
    else if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') results.set(name, { error: httpError(400, '版本中的链接或非普通文件已排除') });
    else if (!(entry.size <= MAX_EVIDENCE_BYTES)) results.set(name, { error: httpError(400, '证据文件超过读取上限') });
    else blobs.push({ name, ...entry });
  }
  // Sizes are known from ls-tree, so each batch stays well inside the 8 MiB output cap.
  for (const group of chunkBy(blobs, blob => blob.size + 64, 4 * 1024 * 1024)) {
    const objects = [...new Set(group.map(blob => blob.object))];
    let output;
    try { output = await runGit(['cat-file', '--batch'], repo, { ...options, input: objects.join('\n') + '\n', encoding: 'buffer' }); }
    catch (error) { if (isFatal(error)) throw error; for (const blob of group) results.set(blob.name, { error }); continue; }
    const contents = new Map();
    for (let offset = 0; offset < output.length;) {
      const newline = output.indexOf(10, offset); if (newline < 0) break;
      const [object, , size] = output.subarray(offset, newline).toString().split(' ');
      if (size === undefined) { offset = newline + 1; continue; } // "<object> missing"
      contents.set(object, output.subarray(newline + 1, newline + 1 + Number(size)));
      offset = newline + 1 + Number(size) + 1;
    }
    for (const blob of group) {
      const content = contents.get(blob.object);
      if (!content) results.set(blob.name, { error: missing() });
      else if (content.includes(0)) results.set(blob.name, { error: httpError(400, '二进制证据已排除') });
      else results.set(blob.name, { text: content.toString('utf8') });
    }
  }
  return results;
}

export async function readVersionText(repo, name, revision, options) {
  const result = (await readVersionTexts(repo, [name], revision, options)).get(name);
  if (result.error) throw result.error;
  return result.text;
}

const INSTRUCTION_DOCS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const PROJECT_DOCS = ['docs/STATE.md', 'docs/PROJECT.md', 'docs/ARCHITECTURE.md', 'docs/架构与平台参考.md', 'README.md'];
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];
const ROOT_DOCS = [...INSTRUCTION_DOCS, ...PROJECT_DOCS, ...MANIFESTS];
const NESTED_DOCS = ['AGENTS.md', 'CLAUDE.md'];

const DOC_BUDGET = 14000, SOURCE_BUDGET = 20000, DOC_FLOOR = 2500, SOURCE_FLOOR = 1500;
// Context margins tried around hunks, widest first, when a file does not fit whole.
const MARGINS = [1000, 500, 250, 120, 60, 30, 15, 8, 4, 2, 0];

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// Numbered lines for 1-based inclusive ranges, "…" between gaps, whole lines
// only, within `limit` characters. `complete` is false when anything was cut.
function renderRanges(lines, ranges, limit) {
  const rows = [], shown = []; let used = 0, complete = true;
  for (const [start, end] of ranges) {
    const gap = shown.length > 0 && start > shown.at(-1)[1] + 1;
    let last = null;
    for (let n = start; n <= end; n++) {
      const row = `${n}: ${lines[n - 1]}`;
      const cost = row.length + 1 + (gap && last === null ? 2 : 0);
      if (used + cost > limit) break;
      if (gap && last === null) rows.push('…');
      rows.push(row); used += cost; last = n;
    }
    if (last !== null) shown.push([start, last]);
    if (last !== end) { complete = false; break; }
  }
  // A single line longer than the limit (minified code) is cut rather than dropped.
  if (!rows.length && ranges.length) {
    const [start] = ranges[0];
    rows.push(`${start}: ${lines[start - 1]}`.slice(0, Math.max(0, limit - 1)));
    shown.push([start, start]);
  }
  return { excerpt: rows.join('\n'), shown, complete };
}

function documentExcerpt(text, limit) {
  const lines = splitLines(text);
  const view = renderRanges(lines, [[1, lines.length]], limit);
  return { excerpt: view.excerpt, truncated: !view.complete, ranges: view.shown };
}

// The whole file when it fits; otherwise every hunk with the widest context
// margin that still fits, so the budget is used rather than left idle.
function sourceExcerpt(text, patch, limit) {
  const lines = splitLines(text);
  const whole = renderRanges(lines, [[1, lines.length]], limit);
  if (whole.complete) return { excerpt: whole.excerpt, truncated: false, ranges: whole.shown };
  const hunks = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(match => {
    const start = Math.min(lines.length, Math.max(1, Number(match[1])));
    return [start, Math.min(lines.length, start + Math.max(1, Number(match[2] ?? 1)) - 1)];
  });
  if (!hunks.length) hunks.push([1, 1]);
  let view;
  for (const margin of MARGINS) {
    view = renderRanges(lines, mergeRanges(hunks.map(([start, end]) => [Math.max(1, start - margin), Math.min(lines.length, end + margin)])), limit);
    if (view.complete) break;
  }
  return { excerpt: view.excerpt, truncated: true, ranges: view.shown };
}

export async function hasProjectFacts(repo, diff, options) {
  let results;
  try { results = await readVersionTexts(repo, ROOT_DOCS, evidenceRevision(diff), options); }
  catch (error) { if (error.name === 'AbortError' || error.status === 504) throw error; return false; }
  return ROOT_DOCS.some(name => results.get(name)?.text?.trim());
}

export async function collectEvidence(repo, diff, focusFile, options = {}) {
  const revision = evidenceRevision(diff);
  const selected = diff.files.filter(file => focusFile ? file.path === focusFile : !file.isNoise);
  // Constraints closest to the change matter most, so nested instruction files
  // (deepest first) are read before general project docs and manifests.
  const nested = new Set();
  for (const file of selected.slice(0, 40)) {
    let dir = path.posix.dirname(file.path);
    while (dir !== '.' && dir !== '/') {
      for (const doc of NESTED_DOCS) nested.add(`${dir}/${doc}`);
      dir = path.posix.dirname(dir);
    }
  }
  const names = [...INSTRUCTION_DOCS, ...[...nested].slice(0, 40), ...PROJECT_DOCS, ...MANIFESTS];
  const sourceFiles = selected.slice(0, 40);
  const results = await readVersionTexts(repo, [...names, ...sourceFiles.map(file => file.path)], revision, options);
  const documents = [], sources = [], warnings = [], used = new Map();
  for (const name of new Set([...names, ...sourceFiles.map(file => file.path)])) {
    const error = results.get(name)?.error;
    if (error && error.code !== 'ENOENT') warnings.push(`${JSON.stringify(name)}：证据不可读取或已排除`);
  }
  const textOf = name => results.get(name)?.text;
  // Each document gets at least DOC_FLOOR characters or an equal share of what
  // is left, so a short list of documents is shown whole.
  const docs = names.filter(name => textOf(name) !== undefined);
  let docBudget = DOC_BUDGET;
  for (let i = 0; i < docs.length; i++) {
    if (docBudget < 200) { warnings.push('项目文档达到预算，部分文档未展示'); break; }
    const limit = Math.min(docBudget, Math.max(DOC_FLOOR, Math.floor(docBudget / (docs.length - i))));
    const view = documentExcerpt(textOf(docs[i]), limit);
    used.set(docs[i], textOf(docs[i])); documents.push({ path: docs[i], ...view }); docBudget -= view.excerpt.length;
  }
  // The same rule for sources: a focused file gets the whole budget, several
  // changed files share it with a floor each.
  const available = sourceFiles.filter(file => textOf(file.path) !== undefined);
  let sourceBudget = SOURCE_BUDGET;
  for (let i = 0; i < available.length; i++) {
    if (sourceBudget < 200) { warnings.push('源码片段达到预算，部分文件未展示'); break; }
    const file = available[i];
    const limit = Math.min(sourceBudget, Math.max(SOURCE_FLOOR, Math.floor(sourceBudget / (available.length - i))));
    const view = sourceExcerpt(textOf(file.path), file.patch, limit);
    used.set(file.path, textOf(file.path)); sources.push({ path: file.path, ...view }); sourceBudget -= view.excerpt.length;
  }
  if (selected.length > 40) warnings.push(`源码证据仅选择前 40 个文件，共 ${selected.length} 个文件`);
  // A worktree has no immutable Git object. Re-read the files the snapshot
  // actually uses, rather than silently mixing versions into it.
  if (!revision && used.size) {
    const again = await readVersionTexts(repo, [...used.keys()], null, options);
    for (const [name, text] of used) if (again.get(name)?.text !== text) throw httpError(409, '文件在读取过程中变化，请重新分析');
  }
  return { revision: revision || 'working-tree', documents, sources, warnings };
}
