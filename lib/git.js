import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { httpError, readRepoText, isSensitiveFile } from './security.js';
import { parseDiffFiles, newFilePatch, isNoiseFile, generatedDir } from './diff.js';

const execFileAsync = promisify(execFile);
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

// `input` is written to stdin (for batch commands); `encoding: 'buffer'` keeps
// binary-safe output for callers that parse byte lengths.
export async function runGit(args, cwd, { signal, maxBuffer = 8 * 1024 * 1024, input, encoding } = {}) {
  if (!Array.isArray(args)) throw new TypeError('Git arguments must be an array');
  try {
    const pending = execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, signal, timeout: 15000, maxBuffer, ...(encoding ? { encoding } : {}),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' }
    });
    if (input !== undefined) {
      // A git that exits early must not turn unwritten input into an unhandled EPIPE.
      pending.child.stdin.on('error', () => {});
      pending.child.stdin.end(input);
    }
    const { stdout } = await pending;
    return stdout;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw httpError(413, 'Git 输出超过 8 MiB 上限，请缩小选择范围');
    if (error.killed) throw httpError(504, 'Git 操作超时，请缩小选择范围');
    throw httpError(400, 'Git 操作失败，请检查仓库状态或目标引用');
  }
}

export async function hasHead(repoPath, options) {
  // An empty stdout with --quiet exit 1 means an unborn branch, rather than a
  // general command failure. Other errors must remain visible.
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: repoPath, signal: options?.signal, timeout: 15000, maxBuffer: 1024
    });
    return stdout.trim();
  } catch (error) {
    if (error.code === 1 && !error.stderr) return null;
    if (error.name === 'AbortError') throw error;
    throw httpError(400, '无法确定仓库 HEAD 状态');
  }
}

export function parseStatus(output) {
  const parts = output.split('\0');
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]; if (!record) continue;
    const status = record.slice(0, 2), name = record.slice(3);
    const oldPath = /[RC]/.test(status) ? parts[++i] : null;
    result.push({ status, path: name, oldPath });
  }
  return result;
}

export async function getStatus(repoPath, options) {
  return parseStatus(await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoPath, options));
}

// Branch, HEAD and dirty count for the repository list from one
// `status --porcelain=v2 --branch`, plus one `log -1` when HEAD exists. The
// dirty count matches getStatus: one record per changed or untracked path.
export async function getRepoSummary(repoPath, options) {
  const fields = (await runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], repoPath, options)).split('\0');
  let head = null, branch = 'HEAD', dirtyCount = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.oid ')) { const oid = field.slice(13); head = oid === '(initial)' ? null : oid; }
    else if (field.startsWith('# branch.head ')) { const name = field.slice(14); branch = name === '(detached)' ? 'HEAD' : name; }
    else if (/^[12u?] /.test(field)) { dirtyCount++; if (field[0] === '2') i++; } // a rename's original path follows
  }
  let lastCommit = null;
  if (head) {
    const [hash, msg, author, time] = (await runGit(['log', '-1', '-z', '--format=%h%x00%s%x00%an%x00%ar', head, '--'], repoPath, options)).split('\0');
    lastCommit = { hash, msg, time, author };
  }
  return { branch, dirtyCount, lastCommit };
}

export async function getCommits(repoPath, count = 30, options) {
  if (!await hasHead(repoPath, options)) return [];
  const output = await runGit(['log', '-z', '-n', String(count), '--format=%H%x00%h%x00%s%x00%an%x00%ar%x00%cI'], repoPath, options);
  const parts = output.split('\0'); const commits = [];
  for (let i = 0; i + 5 < parts.length; i += 6) {
    const [hash, shortHash, msg, author, relTime, fullTime] = parts.slice(i, i + 6);
    commits.push({ hash, shortHash, msg, author, relTime, fullTime, isWorkingTree: false });
  }
  return commits;
}

export async function resolveTarget(repoPath, rawTarget = 'working-tree', options) {
  if (typeof rawTarget !== 'string' || rawTarget.length > 512) throw httpError(400, '目标引用无效');
  const target = rawTarget.startsWith('range:') ? rawTarget.slice(6) : rawTarget;
  if (target === 'working-tree') return target;
  const range = target.match(/^(.+?)(\.\.\.?)(.+)$/);
  const refs = range ? [range[1], range[3]] : [target];
  for (const ref of refs) if (!ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw httpError(400, '目标引用无效');
  const resolved = [];
  for (const ref of refs) resolved.push((await runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repoPath, options)).trim());
  return range ? `${resolved[0]}${range[2]}${resolved[1]}` : resolved[0];
}

export async function getPresets(repoPath, options) {
  const presets = [];
  for (const count of [3, 5]) {
    try {
      await resolveTarget(repoPath, `HEAD~${count}`, options);
      presets.push({ hash: `range:HEAD~${count}..HEAD`, shortHash: `最近 ${count} 次`,
        msg: `聚合最近 ${count} 次提交变更`, author: 'Git Range', relTime: '', isRange: true });
    } catch (error) {
      if (error.name === 'AbortError' || error.status !== 400) throw error;
    }
  }
  return presets;
}

export async function getWorkingTreeDiff(repoPath, options) {
  const head = await hasHead(repoPath, options);
  const status = await getStatus(repoPath, options);
  let text = head ? await runGit(['diff', ...DIFF_FLAGS, head, '--'], repoPath, options) : '';
  // Keep a running byte count: measuring the whole text after every file made
  // this loop quadratic and blocked the event loop for seconds.
  let bytes = Buffer.byteLength(text);
  const warnings = [], generated = new Map();
  const paths = head ? status.filter(item => item.status === '??').map(item => item.path)
    : (await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repoPath, options)).split('\0').filter(Boolean);
  for (const name of [...new Set(paths)]) {
    const dir = generatedDir(name);
    if (dir) { generated.set(dir, (generated.get(dir) || 0) + 1); continue; }
    if (isSensitiveFile(name) || isNoiseFile(name)) { warnings.push(`${JSON.stringify(name)}：敏感或生成文件已排除`); continue; }
    try {
      const content = readRepoText(repoPath, name, 300000);
      const executable = Boolean(fs.lstatSync(path.join(repoPath, name)).mode & 0o111);
      const patch = '\n' + newFilePatch(name, content, executable);
      bytes += Buffer.byteLength(patch);
      if (bytes > 8 * 1024 * 1024) throw httpError(413, '工作区 Diff 超过 8 MiB，请缩小变动范围');
      text += patch;
    } catch (error) {
      if (error.status === 413) throw error;
      warnings.push(`${JSON.stringify(name)}：${error.code === 'ENOENT' ? '文件已移除' : '链接、二进制或过大文件已排除'}`);
    }
  }
  // One line per directory, first, so the 100-warning cap never hides them.
  const skipped = [...generated].map(([dir, count]) => `${JSON.stringify(dir)}：${count} 个依赖或缓存文件未读取`);
  return { text, dirtyCount: status.length, warnings: [...skipped, ...warnings], head };
}

export async function loadDiff(repoPath, target = 'working-tree', options) {
  const resolvedTarget = await resolveTarget(repoPath, target, options);
  let text, dirtyCount = 0, warnings = [], head;
  let commitInfo;
  if (resolvedTarget === 'working-tree') {
    ({ text, dirtyCount, warnings, head } = await getWorkingTreeDiff(repoPath, options));
    commitInfo = '当前工作区未提交修改';
  } else if (resolvedTarget.includes('..')) {
    text = await runGit(['diff', ...DIFF_FLAGS, resolvedTarget, '--'], repoPath, options);
    commitInfo = `提交区间 ${resolvedTarget}`;
  } else {
    text = await runGit(['show', '--format=', '--root', '-m', '--first-parent', ...DIFF_FLAGS, resolvedTarget, '--'], repoPath, options);
    commitInfo = (await runGit(['log', '-1', '--format=%h - %s (%an, %ar)', resolvedTarget, '--'], repoPath, options)).trim();
  }
  const parsed = parseDiffFiles(text);
  const files = parsed.filter(file => !file.isSensitive && !file.isLink);
  for (const file of parsed.filter(file => file.isSensitive || file.isLink)) {
    const origin = file.oldPath ? `（来自 ${JSON.stringify(file.oldPath)}）` : '';
    warnings.push(`${JSON.stringify(file.path)}${origin}：敏感文件或符号链接已排除`);
  }
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const isCleanWorkingTree = resolvedTarget === 'working-tree' && dirtyCount === 0;
  const fallbackHead = isCleanWorkingTree && head ? { hash: head, shortHash: head.slice(0, 8), msg: '最新提交' } : null;
  return { success: true, target, resolvedTarget, commitInfo, files, diffText: files.map(file => file.patch).join('\n'),
    statText: `${files.length} 个文件，+${additions} / -${deletions}`, summaryText: '',
    dirtyCount, isCleanWorkingTree, fallbackHead, warnings: warnings.slice(0, 100) };
}
