import path from 'node:path';
import { runGit } from './git.js';
import { readRepoText, isSensitiveFile, httpError } from './security.js';

export function evidenceRevision(diff) {
  return diff.resolvedTarget === 'working-tree' ? null : diff.resolvedTarget.split(/\.\.\.?/).at(-1);
}

export async function readVersionText(repo, name, revision, options) {
  if (!revision) return readRepoText(repo, name);
  if (path.isAbsolute(name) || name.split('/').some(part => part === '..' || part.toLowerCase() === '.git') || isSensitiveFile(name)) throw httpError(400, '证据文件路径无效');
  // -l reports the blob size, so oversized files are rejected without another process.
  const record = await runGit(['--literal-pathspecs', 'ls-tree', '-l', '-z', revision, '--', name], repo, options);
  if (!record) { const error = new Error('文件在所选版本不存在'); error.code = 'ENOENT'; throw error; }
  const [mode, type, object, size] = record.split('\t')[0].trim().split(/\s+/);
  if (!['100644', '100755'].includes(mode) || type !== 'blob') throw httpError(400, '版本中的链接或非普通文件已排除');
  if (!(Number(size) <= 500000)) throw httpError(400, '证据文件超过读取上限');
  const text = await runGit(['cat-file', '-p', object], repo, options);
  if (text.includes('\0')) throw httpError(400, '二进制证据已排除');
  return text;
}

const INSTRUCTION_DOCS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const PROJECT_DOCS = ['docs/STATE.md', 'docs/PROJECT.md', 'docs/ARCHITECTURE.md', 'docs/架构与平台参考.md', 'README.md'];
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];
const ROOT_DOCS = [...INSTRUCTION_DOCS, ...PROJECT_DOCS, ...MANIFESTS];
const NESTED_DOCS = ['AGENTS.md', 'CLAUDE.md'];

export async function hasProjectFacts(repo, diff, options) {
  for (const name of ROOT_DOCS) {
    try { if ((await readVersionText(repo, name, evidenceRevision(diff), options)).trim()) return true; }
    catch (error) { if (error.name === 'AbortError' || error.status === 504) throw error; }
  }
  return false;
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
  const documents = [], sources = [], warnings = [], captured = new Map();
  const read = async name => {
    if (captured.has(name)) return captured.get(name);
    try {
      const text = await readVersionText(repo, name, revision, options);
      captured.set(name, text); return text;
    } catch (error) {
      if (error.name === 'AbortError' || error.status === 504 || error.status === 413) throw error;
      if (error.code !== 'ENOENT') warnings.push(`${JSON.stringify(name)}：证据不可读取或已排除`);
      return null;
    }
  };
  let docBudget = 14000;
  for (const name of names) {
    if (docBudget < 200) { warnings.push('项目文档达到预算，部分文档未展示'); break; }
    const text = await read(name); if (text === null) continue;
    const limit = Math.min(2500, docBudget);
    const lines = text.split('\n').slice(0, 100);
    const excerpt = lines.map((line, index) => `${index + 1}: ${line}`).join('\n').slice(0, limit);
    const truncated = excerpt.length >= limit || text.split('\n').length > 100;
    documents.push({ path: name, excerpt, truncated }); docBudget -= excerpt.length;
  }
  let sourceBudget = 20000;
  for (const file of selected.slice(0, 40)) {
    if (sourceBudget < 200) { warnings.push('源码片段达到预算，部分文件未展示'); break; }
    const text = await read(file.path); if (text === null) continue;
    const lines = text.split('\n');
    const anchors = [...file.patch.matchAll(/^@@ .*? \+(\d+)(?:,\d+)? @@/gm)].slice(0, 3).map(match => Number(match[1]));
    if (!anchors.length) anchors.push(1);
    const indices = new Set();
    for (const anchor of anchors) for (let i = Math.max(0, anchor - 11); i < Math.min(lines.length, anchor + 49); i++) indices.add(i);
    const limit = Math.min(3000, sourceBudget);
    const excerpt = [...indices].sort((a, b) => a - b).map(i => `${i + 1}: ${lines[i]}`).join('\n').slice(0, limit);
    sources.push({ path: file.path, excerpt, truncated: indices.size < lines.length || excerpt.length >= limit });
    sourceBudget -= excerpt.length;
  }
  if (selected.length > 40) warnings.push(`源码证据仅选择前 40 个文件，共 ${selected.length} 个文件`);
  // A worktree has no immutable Git object. Detect files changed while capturing
  // evidence rather than silently mixing versions into the first snapshot.
  if (!revision) for (const [name, text] of captured) {
    if (await readVersionText(repo, name, null, options) !== text) throw httpError(409, '文件在读取过程中变化，请重新分析');
  }
  return { revision: revision || 'working-tree', documents, sources, warnings };
}
