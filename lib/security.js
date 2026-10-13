import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function localAccess() {
  const token = randomBytes(32).toString('base64url');
  function guard(req, res, next) {
    const port = req.socket.localPort;
    const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
    const host = req.headers.host;
    if (!allowedHosts.has(host)) return res.status(403).json({ error: '只允许本机访问' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
      return res.status(403).json({ error: '不允许跨来源访问' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: '不允许跨站访问' });
    }
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  }
  function authenticate(req, res, next) {
    const supplied = req.headers['x-local-token'];
    const bytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    if (bytes.length !== Buffer.byteLength(token) || !timingSafeEqual(bytes, Buffer.from(token))) {
      return res.status(401).json({ error: '本机会话已失效，请刷新页面' });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
  return { guard, authenticate, session: (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token });
  } };
}

export class RepositoryRegistry {
  #repos = new Map();
  async register(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0')) throw httpError(400, '仓库路径无效');
    let canonical;
    try {
      canonical = fs.realpathSync(targetPath);
      if (!fs.statSync(canonical).isDirectory()) throw new Error();
      const gitEntry = fs.lstatSync(path.join(canonical, '.git'));
      if (gitEntry.isSymbolicLink()) throw new Error();
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: canonical, timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      });
      if (fs.realpathSync(stdout.trim()) !== canonical) throw new Error();
    } catch { throw httpError(400, '指定目录不是有效的 Git 仓库根目录'); }
    const id = createHash('sha256').update(canonical).digest('base64url');
    const repo = { id, path: canonical };
    this.#repos.set(id, repo);
    return repo;
  }
  resolve(id) {
    const repo = this.#repos.get(id);
    if (!repo || !fs.existsSync(path.join(repo.path, '.git'))) throw httpError(404, '仓库未登记或已移除，请刷新仓库列表');
    return repo.path;
  }
  resolvePath(targetPath) {
    let canonical;
    try { canonical = typeof targetPath === 'string' && fs.realpathSync(targetPath); } catch {}
    for (const repo of this.#repos.values()) if (repo.path === canonical) return this.resolve(repo.id);
    throw httpError(404, '仓库未登记，请刷新仓库列表');
  }
}

export function isSensitiveFile(filePath) {
  return /(^|\/)(\.env(?:\.|$)|id_(rsa|dsa|ecdsa|ed25519)(?:\.|$)|credentials(?:\.|$)|\.npmrc$|\.netrc$)|\.(pem|key|p12|pfx|keystore)$/i.test(filePath);
}

export function readRepoText(repoPath, relativePath, maxBytes = 500000) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw httpError(400, '文件路径无效');
  const parts = relativePath.split('/');
  if (parts.some(part => part === '..' || part.toLowerCase() === '.git')) throw httpError(400, '文件路径超出允许范围');
  if (isSensitiveFile(relativePath)) throw httpError(400, '敏感文件已排除');
  const root = fs.realpathSync(repoPath);
  let fullPath = root;
  for (const part of parts.filter(Boolean)) {
    fullPath = path.join(fullPath, part);
    if (fs.lstatSync(fullPath).isSymbolicLink()) throw httpError(400, '符号链接已排除');
  }
  const relative = path.relative(root, fs.realpathSync(fullPath));
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw httpError(400, '文件超出仓库边界');
  if (!fs.lstatSync(fullPath).isFile()) throw httpError(400, '非普通文件已排除');
  const fd = fs.openSync(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw httpError(400, '文件超过读取上限');
    const buf = fs.readFileSync(fd);
    if (buf.length > maxBytes || buf.includes(0)) throw httpError(400, '过大或二进制文件已排除');
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
