import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpError, isSensitiveFile, readRepoText } from './security.js';
import { generatedDir } from './diff.js';

const execFileAsync = promisify(execFile);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 400000;

async function git(args, cwd, { signal } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, signal, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' }
    });
    return stdout;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.killed) throw httpError(504, 'Git 操作超时');
    throw httpError(400, 'Git 操作失败，请检查仓库状态');
  }
}

// The tree mirrors the working copy: tracked files plus untracked ones that
// .gitignore does not exclude, the same set an editor would show.
export async function listWorktreeFiles(repo, options = {}) {
  const [trackedOut, untrackedOut] = await Promise.all([
    git(['ls-files', '-z', '--cached'], repo, options),
    git(['ls-files', '-z', '--others', '--exclude-standard'], repo, options)
  ]);
  const tracked = new Set(trackedOut.split('\0').filter(Boolean));
  const names = [...new Set([...tracked, ...untrackedOut.split('\0').filter(Boolean)])].sort();
  const files = [];
  let omitted = 0;
  for (const name of names) {
    if (files.length >= MAX_FILES) { omitted = names.length - files.length; break; }
    if (isSensitiveFile(name) || generatedDir(name)) { omitted++; continue; }
    let stat;
    try { stat = fs.lstatSync(path.join(repo, name)); } catch { omitted++; continue; }
    if (!stat.isFile()) { omitted++; continue; }
    files.push({ path: name, size: stat.size, tracked: tracked.has(name) });
  }
  return { files, omitted, truncated: omitted > 0 };
}

// `readRepoText` already rejects traversal, links, sensitive names, binaries
// and oversized files; the viewer only adds the line count.
export function readWorktreeFile(repo, filePath) {
  if (typeof filePath !== 'string' || !filePath) throw httpError(400, '缺少文件路径');
  const text = readRepoText(repo, filePath, MAX_FILE_BYTES);
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return { path: filePath, text, lines: lines.length, bytes: Buffer.byteLength(text), truncated: false };
}
