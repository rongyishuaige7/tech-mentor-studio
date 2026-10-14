import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { buildFingerprint } from '../lib/runtime.js';

const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 3300);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 到 65535 的整数');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上版本');
const url = `http://127.0.0.1:${port}`;

function listeners() {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 3000 })
      .split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
  } catch (error) {
    if (error.status === 1) return [];
    throw new Error('无法检查监听进程，请安装 lsof 后重试');
  }
}

function sameDirectory(pid) {
  try {
    const info = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 });
    const dir = info.split('\n').find(line => line.startsWith('n'))?.slice(1);
    return dir && fs.realpathSync(dir) === root;
  } catch { return false; }
}

async function identity() {
  const session = await fetch(url + '/api/session', { signal: AbortSignal.timeout(1500) });
  if (!session.ok) throw new Error('本机会话初始化失败');
  const { token } = await session.json();
  const response = await fetch(url + '/api/health', { headers: { 'X-Local-Token': token }, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('健康检查失败');
  return response.json();
}

function openBrowser() {
  if (process.env.NO_BROWSER === '1') return;
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [url], { stdio: 'ignore' });
  browser.on('error', () => console.warn(`请手动打开 ${url}`));
  browser.unref();
}

try {
  const occupied = listeners();
  if (occupied.length) {
    let health;
    if (occupied.every(sameDirectory)) { try { health = await identity(); } catch {} }
    if (health?.service === 'tech-mentor-studio' && health.projectRoot === root && health.fingerprint === buildFingerprint(root)) {
      console.log(`复用当前项目服务: ${url}`); openBrowser();
    } else throw new Error(`端口 ${port} 已被其他服务或旧版本占用；未停止任何进程。请使用空闲 PORT，或手动重启已确认的项目服务`);
  } else {
    if (!fs.existsSync(path.join(root, 'node_modules/express'))) execFileSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    // Refresh port ownership after building; a new listener must never be killed.
    if (listeners().length) throw new Error(`端口 ${port} 在构建期间被占用，请换用空闲 PORT`);
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
    let spawnError;
    child.once('error', error => { spawnError = error; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !spawnError) {
      try {
        const health = await identity();
        if (health.service === 'tech-mentor-studio' && health.projectRoot === root && health.fingerprint === buildFingerprint(root)) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) { child.kill('SIGTERM'); throw new Error('项目服务未通过健康检查'); }
    console.log(`服务已验证 (PID ${child.pid}): ${url}`); openBrowser();
    process.exitCode = await exit;
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
