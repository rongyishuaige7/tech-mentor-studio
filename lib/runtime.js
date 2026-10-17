import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function buildFingerprint(root) {
  const hash = createHash('sha256');
  for (const name of ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).sort().map(name => `lib/${name}`)]) {
    hash.update(name); hash.update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest('hex');
}

export async function pickDirectory({ signal } = {}) {
  if (process.platform === 'darwin') {
    const script = [
      'tell application "Finder"',
      '  activate',
      'end tell',
      'return POSIX path of (choose folder with prompt "选择要添加的 Git 仓库目录")'
    ].join('\n');
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], {
        signal,
        timeout: 300000,
        env: { ...process.env, LANG: 'en_US.UTF-8' }
      });
      const selected = stdout.trim();
      if (!selected) return { canceled: true };
      return { canceled: false, path: path.resolve(selected) };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const stderr = error.stderr || '';
      const message = error.message || '';
      if (error.code === 1 || stderr.includes('-128') || message.includes('-128') || message.includes('User canceled') || stderr.includes('User canceled') || message.includes('用户已取消') || stderr.includes('用户已取消')) {
        return { canceled: true };
      }
      throw new Error(`无法打开 Finder 目录选择器: ${error.message}`);
    }
  } else if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=选择要添加的 Git 仓库目录'], {
        signal, timeout: 300000
      });
      const selected = stdout.trim();
      return selected ? { canceled: false, path: path.resolve(selected) } : { canceled: true };
    } catch (zenityError) {
      if (zenityError.name === 'AbortError') throw zenityError;
      if (zenityError.code === 1) return { canceled: true };
      try {
        const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', '--title', '选择要添加的 Git 仓库目录'], {
          signal, timeout: 300000
        });
        const selected = stdout.trim();
        return selected ? { canceled: false, path: path.resolve(selected) } : { canceled: true };
      } catch (kdialogError) {
        if (kdialogError.name === 'AbortError') throw kdialogError;
        if (kdialogError.code === 1) return { canceled: true };
        const notFound = zenityError.code === 'ENOENT' && kdialogError.code === 'ENOENT';
        const error = new Error(notFound ? 'Linux 环境需要安装 zenity 或 kdialog 才能使用图形界面目录选择器' : '打开目录选择器失败');
        if (notFound) error.status = 501;
        throw error;
      }
    }
  } else {
    const error = new Error(`当前操作系统 (${process.platform}) 不支持原生目录选择器，请手动输入路径`);
    error.status = 501;
    throw error;
  }
}
