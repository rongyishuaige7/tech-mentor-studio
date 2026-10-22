import { getStatus, getCommits, getPresets, loadDiff, getRepoSummary } from './lib/git.js';
import { hasProjectFacts } from './lib/facts.js';
import { buildProjectOverview, renderProjectTree, renderImports, renderEndpoints } from './lib/project.js';
import { mentorHandler } from './lib/mentor.js';
import { localAccess, RepositoryRegistry, httpError, redactKnownSecret } from './lib/security.js';
import express from 'express';
import { getKeeperStats } from './lib/keeper.js';
import { getConfig, defaultConfigDir } from './lib/config.js';
import { buildFingerprint, pickDirectory } from './lib/runtime.js';
import { requestLifecycle } from './lib/stream.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(options = {}) {
const app = express();
const config = getConfig(options, __dirname);
// Paths only: the key itself never reaches a log.
if (config.proxyKeySource === 'legacy') console.warn(`代理认证仍从 ${config.proxyKeyFile} 读取；项目目录可能随 iCloud 等同步，建议移到 ${path.join(defaultConfigDir(), 'proxy-key')}（权限 600）`);
if (config.proxyKeyLoose) console.warn(`代理认证文件 ${config.proxyKeyFile} 对其他用户可读，建议执行 chmod 600`);
const fingerprint = buildFingerprint(__dirname);
const PROXY_KEY = config.proxyKey;
const fetchImpl = options.fetchImpl || fetch;
const pickDirectoryImpl = options.pickDirectoryImpl || pickDirectory;
const pickTimeout = options.pickTimeoutMs || 300000;

// A lifecycle timeout surfaces as AbortError; answer it instead of leaving the
// request pending. A disconnected client has no one left to answer.
function sendFailure(res, error, lifecycle, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  const timedOut = error.name === 'AbortError' && lifecycle.signal.aborted;
  res.status(timedOut ? 504 : error.status || 500)
    .json({ success: false, error: timedOut ? lifecycle.signal.reason.message : error.message, ...extra });
}

const access = localAccess();
const registry = new RepositoryRegistry();
app.use(access.guard);
app.get('/api/session', access.session);
app.use('/api', access.authenticate);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 数据持久化路径
const DATA_DIR = options.dataDir || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

function getWatchlist() {
  if (fs.existsSync(WATCHLIST_FILE)) {
    try {
      const list = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8'));
      if (!Array.isArray(list) || !list.every(p => typeof p === 'string')) throw new Error('关注列表格式无效');
      return list;
    } catch {
      throw httpError(500, '关注列表无法读取，原文件已保留，请检查格式');
    }
  }
  return [];
}

function saveWatchlist(list) {
  const temporary = `${WATCHLIST_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(list, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, WATCHLIST_FILE);
}

// 默认扫描的顶级目录
const DEFAULT_SCAN_ROOTS = options.scanRoots || (process.env.SCAN_ROOTS_JSON ? JSON.parse(process.env.SCAN_ROOTS_JSON) : [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Developer'),
  path.join(os.homedir(), 'Github'),
  path.join(os.homedir())
]);
if (!Array.isArray(DEFAULT_SCAN_ROOTS) || !DEFAULT_SCAN_ROOTS.every(root => typeof root === 'string' && path.isAbsolute(root))) throw new Error('SCAN_ROOTS_JSON 必须是绝对路径数组');

// 扫描 Git 仓库
let scanCache = null;
let scanPending = null;
async function scanRepositories(refresh = false) {
  // The refresh button bypasses this; adding a repository clears it.
  if (!refresh && scanCache && Date.now() - scanCache.at < 30000) return scanCache.repos;
  if (scanPending) return scanPending;
  scanPending = (async () => {
    const discovered = new Set(getWatchlist());
    for (const root of DEFAULT_SCAN_ROOTS) {
      try {
        if (!fs.existsSync(root)) continue;
        if (fs.existsSync(path.join(root, '.git'))) discovered.add(root);
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const candidate = path.join(root, entry.name);
          if (fs.existsSync(path.join(candidate, '.git'))) discovered.add(candidate);
        }
      } catch (error) {
        // An unreadable or non-directory root must not hide every other repo.
        console.warn(`跳过无法读取的扫描根目录 ${root}: ${error.message}`);
      }
    }
    const paths = [...discovered]; const repos = new Map(); let cursor = 0;
    async function worker() {
      while (cursor < paths.length) {
        const repoPath = paths[cursor++];
        let registered;
        try {
          registered = await registry.register(repoPath);
          repos.set(registered.id, { ...registered, name: path.basename(registered.path), ...await getRepoSummary(registered.path) });
        } catch (error) {
          if (registered) repos.set(registered.id, { ...registered, name: path.basename(registered.path), branch: 'unknown', dirtyCount: 0, error: error.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker));
    const result = [...repos.values()].sort((a, b) => Number(b.dirtyCount > 0) - Number(a.dirtyCount > 0) || a.name.localeCompare(b.name));
    scanCache = { at: Date.now(), repos: result }; return result;
  })();
  try { return await scanPending; } finally { scanPending = null; }
}

// ----------------- API 路由 -----------------

app.get('/api/repos', async (req, res) => {
  try {
    const repos = await scanRepositories(req.query.refresh === '1');
    res.json({ success: true, repos: redactKnownSecret(repos, config.proxyKey) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/repos/add', async (req, res) => {
  try {
    let { targetPath } = req.body;
    if (typeof targetPath !== 'string' || !targetPath) return res.status(400).json({ error: 'targetPath required' });
    targetPath = path.resolve(targetPath.replace(/^~/, os.homedir()));

    if (!fs.existsSync(path.join(targetPath, '.git'))) {
      return res.status(400).json({ error: '指定目录不是有效的 Git 仓库' });
    }

    targetPath = (await registry.register(targetPath)).path;
    const list = getWatchlist();
    if (!list.includes(targetPath)) {
      list.push(targetPath);
      saveWatchlist(list);
    }
    scanCache = null;
    res.json({ success: true, path: targetPath });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/repos/pick', async (req, res) => {
  const lifecycle = requestLifecycle(res, pickTimeout, '目录选择超时，请重新选择');
  try {
    const result = await pickDirectoryImpl({ signal: lifecycle.signal });
    if (result.canceled || !result.path) {
      return res.json({ success: true, canceled: true });
    }

    let targetPath = path.resolve(result.path.replace(/^~/, os.homedir()));
    if (!fs.existsSync(path.join(targetPath, '.git'))) {
      return res.status(400).json({ success: false, error: `所选目录不是有效的 Git 仓库（未找到 .git 目录）: ${targetPath}` });
    }

    targetPath = (await registry.register(targetPath)).path;
    const list = getWatchlist();
    if (!list.includes(targetPath)) {
      list.push(targetPath);
      saveWatchlist(list);
    }
    scanCache = null;
    res.json({ success: true, path: targetPath });
  } catch (err) {
    sendFailure(res, err, lifecycle, { unsupported: err.status === 501 });
  } finally {
    lifecycle.dispose();
  }
});

app.get('/api/tokens/keeper-stats', async (req, res) => {
  try { res.json({ success: true, ...await getKeeperStats(config.keeperPath) }); }
  catch { res.status(503).json({ success: false, error: 'Keeper 计量不可用，请检查数据库路径和 SQLite' }); }
});

app.get('/api/repos/:repoId/commits', async (req, res) => {
  const lifecycle = requestLifecycle(res, 45000, '读取提交记录超时，请重试');
  try {
    const repoPath = registry.resolve(req.params.repoId);
    const options = { signal: lifecycle.signal };
    const [status, commits, presets] = await Promise.all([getStatus(repoPath, options), getCommits(repoPath, 30, options), getPresets(repoPath, options)]);
    if (status.length) commits.unshift({ hash: 'working-tree', shortHash: 'HEAD*',
      msg: `当前未提交改动 (${status.length} 个文件)`, author: 'You', relTime: 'Just now',
      isWorkingTree: true, fileCount: status.length });
    res.json(redactKnownSecret({ success: true, commits, presets, repoPath, dirtyCount: status.length }, config.proxyKey));
  } catch (error) { sendFailure(res, error, lifecycle); }
  finally { lifecycle.dispose(); }
});

app.get('/api/repos/:repoId/diff', async (req, res) => {
  const lifecycle = requestLifecycle(res, 45000, '生成 Diff 超时，请缩小选择范围');
  try {
    const repoPath = registry.resolve(req.params.repoId);
    const options = { signal: lifecycle.signal };
    const target = req.query.target || 'working-tree';
    // Whole-project scope has no diff: the page shows the inventory the mentor reads.
    if (target === 'project') {
      const overview = await buildProjectOverview(repoPath, options);
      return res.json(redactKnownSecret({
        success: true, target: 'project', resolvedTarget: overview.revision, branch: overview.branch,
        project: {
          stats: overview.stats,
          entryPoints: overview.entryPoints,
          hubs: overview.graph.hubs,
          deps: overview.deps,
          documents: overview.documents.map(file => file.path),
          tree: renderProjectTree(overview.files, { limit: 6000 }),
          endpoints: renderEndpoints(overview.endpoints),
          imports: renderImports(overview.graph, { limit: 4000 })
        },
        hasFacts: overview.documents.length > 0
      }, config.proxyKey));
    }
    // diffText repeats files[].patch; the page only needs the files.
    const { diffText, ...data } = await loadDiff(repoPath, target, options);
    res.json(redactKnownSecret({ ...data, repoPath, hasFacts: await hasProjectFacts(repoPath, data, options) }, config.proxyKey));
  } catch (error) { sendFailure(res, error, lifecycle); }
  finally { lifecycle.dispose(); }
});

app.get('/api/models', async (req, res) => {
  if (!PROXY_KEY) return res.status(503).json({ success: false, models: [], error: '尚未配置代理认证，请设置 PROXY_KEY 或 ~/.config/tech-mentor-studio/proxy-key' });
  try {
    const response = await fetchImpl(config.modelsUrl, {
      headers: { Authorization: `Bearer ${PROXY_KEY}` }, signal: AbortSignal.timeout(config.modelsTimeout)
    });
    if (!response.ok) {
      await response.body?.cancel();
      return res.status(502).json({ success: false, models: [], error: [401, 403].includes(response.status)
        ? '代理认证失败，请检查本地凭据' : `模型列表请求失败 (${response.status})` });
    }
    const data = await response.json();
    const models = Array.isArray(data.data) ? [...new Set(data.data.filter(m => typeof m?.id === 'string' && m.id.length > 0).map(m => m.id))]
      .map(id => ({ id, name: id })) : [];
    if (!models.length) return res.status(503).json({ success: false, models: [], error: '代理未返回可用模型，请检查代理服务后重试' });
    res.json({ success: true, models });
  } catch (error) {
    res.status(502).json({ success: false, models: [], error: ['TimeoutError', 'AbortError'].includes(error.name) ? '模型列表查询超时' : '无法读取模型列表，请检查代理连接' });
  }
});

app.post('/api/mentor/analyze', mentorHandler({ registry, config, fetchImpl, snapshots: options.snapshots, secretScanner: options.secretScanner }));

app.get('/api/health', (req, res) => res.json({ success: true, service: 'tech-mentor-studio', projectRoot: __dirname, fingerprint }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ success: false, error: error.type === 'entity.parse.failed' ? '请求 JSON 格式无效' : error.type === 'entity.too.large' ? '请求超过大小限制' : '请求处理失败' });
});
return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 3300);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 到 65535 的整数');
  createApp().listen(port, '127.0.0.1', () => console.log(`Tech Mentor Studio: http://localhost:${port}`));
}
