import { runGit, getStatus, getCommits, getPresets, loadDiff } from './lib/git.js';
import { getCleanDiffForMentor } from './lib/diff.js';
import { localAccess, RepositoryRegistry, readRepoText, httpError } from './lib/security.js';
import { relayCompletion, requestLifecycle } from './lib/stream.js';
import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

export function createApp(options = {}) {
const app = express();
const PROXY_URL = options.proxyUrl || process.env.PROXY_URL || 'http://127.0.0.1:8317/v1/chat/completions';
const fetchImpl = options.fetchImpl || fetch;
const PROXY_KEY = options.proxyKey || process.env.PROXY_KEY || 'REDACTED-LOCAL-KEY';

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

// ----------------- P0: 项目级事实源 (SSOT) 自动探针 (支持 Node/Python/Rust/Go) -----------------

function getProjectFacts(repoPath) {
  const candidateFiles = [
    'CLAUDE.md',
    'AGENTS.md',
    'GEMINI.md',
    'docs/STATE.md',
    'docs/PROJECT.md',
    'docs/ARCHITECTURE.md',
    'docs/架构与平台参考.md',
    'README.md'
  ];

  const facts = [];
  for (const relPath of candidateFiles) {
    const fullPath = path.join(repoPath, relPath);
    if (fs.existsSync(fullPath)) {
      try {
        const stats = fs.statSync(fullPath);
        if (stats.size > 0 && stats.size < 500000) {
          const raw = readRepoText(repoPath, relPath);
          // 取前 80 行，提炼核心架构规则
          const lines = raw.split('\n').slice(0, 80).join('\n');
          facts.push(`### [项目事实源与关键约束: ${relPath}]\n${lines.trim()}`);
          if (facts.length >= 2) break; // 取前 2 个最重要的事实文件
        }
      } catch {}
    }
  }

  // 1. Node.js (package.json)
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readRepoText(repoPath, 'package.json'));
      const deps = Object.keys(pkg.dependencies || {}).slice(0, 10).join(', ');
      facts.unshift(`【项目属性 (Node.js)】名称: ${pkg.name || path.basename(repoPath)} | 描述: ${pkg.description || '无'} | 核心依赖: ${deps || '原生标准库'}`);
    } catch {}
  }

  // 2. Python (pyproject.toml / requirements.txt)
  const pyprojectPath = path.join(repoPath, 'pyproject.toml');
  const reqsPath = path.join(repoPath, 'requirements.txt');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const raw = readRepoText(repoPath, 'pyproject.toml');
      const lines = raw.split('\n').slice(0, 30).join('\n');
      facts.unshift(`【项目属性 (Python pyproject.toml)】\n${lines.trim()}`);
    } catch {}
  } else if (fs.existsSync(reqsPath)) {
    try {
      const raw = readRepoText(repoPath, 'requirements.txt');
      const reqs = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).slice(0, 10).join(', ');
      facts.unshift(`【项目属性 (Python)】核心依赖: ${reqs}`);
    } catch {}
  }

  // 3. Rust (Cargo.toml)
  const cargoPath = path.join(repoPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const raw = readRepoText(repoPath, 'Cargo.toml');
      const lines = raw.split('\n').slice(0, 25).join('\n');
      facts.unshift(`【项目属性 (Rust Cargo)】\n${lines.trim()}`);
    } catch {}
  }

  // 4. Go (go.mod)
  const gomodPath = path.join(repoPath, 'go.mod');
  if (fs.existsSync(gomodPath)) {
    try {
      const raw = readRepoText(repoPath, 'go.mod');
      const lines = raw.split('\n').slice(0, 20).join('\n');
      facts.unshift(`【项目属性 (Go module)】\n${lines.trim()}`);
    } catch {}
  }

  return facts.join('\n\n');
}

// 扫描 Git 仓库
let scanCache = null;
let scanPending = null;
async function scanRepositories(refresh = false) {
  if (!refresh && scanCache && Date.now() - scanCache.at < 5000) return scanCache.repos;
  if (scanPending) return scanPending;
  scanPending = (async () => {
    const discovered = new Set(getWatchlist());
    for (const root of DEFAULT_SCAN_ROOTS) {
      if (!fs.existsSync(root)) continue;
      if (fs.existsSync(path.join(root, '.git'))) discovered.add(root);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const candidate = path.join(root, entry.name);
        if (fs.existsSync(path.join(candidate, '.git'))) discovered.add(candidate);
      }
    }
    const paths = [...discovered]; const repos = new Map(); let cursor = 0;
    async function worker() {
      while (cursor < paths.length) {
        const repoPath = paths[cursor++];
        let registered;
        try {
          registered = await registry.register(repoPath);
          const [branch, commits, status] = await Promise.all([
            runGit(['branch', '--show-current'], registered.path),
            getCommits(registered.path, 1), getStatus(registered.path)
          ]);
          const latest = commits[0];
          repos.set(registered.id, { ...registered, name: path.basename(registered.path),
            branch: branch.trim() || 'HEAD', dirtyCount: status.length,
            lastCommit: latest ? { hash: latest.shortHash, msg: latest.msg, time: latest.relTime, author: latest.author } : null });
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
    res.json({ success: true, repos });
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

const KEEPER_DB_PATH = options.keeperPath || '/opt/homebrew/var/cpa-usage-keeper/app.db';

async function getKeeperTokenStats() {
  if (!fs.existsSync(KEEPER_DB_PATH)) return null;
  try {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const tokensOut = await execAsync(`sqlite3 ${KEEPER_DB_PATH} "
      SELECT COALESCE(ui.provider, 'other'), COALESCE(ui.name, 'unknown'), SUM(s.total_tokens), SUM(s.request_count)
      FROM usage_overview_daily_stats s
      LEFT JOIN usage_identities ui ON ui.identity = s.auth_index
      WHERE s.bucket_start LIKE '${todayPrefix}%'
      GROUP BY ui.provider;
    "`);

    const stats = {
      today: todayPrefix,
      antigravity: { tokens: 0, requests: 0 },
      codex: { tokens: 0, requests: 0 },
      claude: { tokens: 0, requests: 0 }
    };

    if (tokensOut.stdout) {
      for (const line of tokensOut.stdout.trim().split('\n').filter(Boolean)) {
        const [provider, name, totalTokens, reqCount] = line.split('|');
        const p = (provider || '').toLowerCase();
        const tCount = parseInt(totalTokens || '0', 10);
        const rCount = parseInt(reqCount || '0', 10);
        if (p.includes('antigravity') || p.includes('gemini')) {
          stats.antigravity.tokens += tCount;
          stats.antigravity.requests += rCount;
        } else if (p.includes('codex') || p.includes('openai')) {
          stats.codex.tokens += tCount;
          stats.codex.requests += rCount;
        } else if (p.includes('claude')) {
          stats.claude.tokens += tCount;
          stats.claude.requests += rCount;
        }
      }
    }

    const quotaOut = await execAsync(`sqlite3 ${KEEPER_DB_PATH} "
      WITH latest_account AS (
        SELECT qc.auth_index
        FROM quota_cycles qc
        JOIN quota_percent_segments qps ON qps.cycle_id = qc.id
        WHERE qc.provider = 'codex'
        ORDER BY qps.last_observed_at DESC, qps.id DESC
        LIMIT 1
      )
      SELECT qc.quota_key, qc.window_seconds, qc.reset_at, qps.remaining_percent
      FROM quota_cycles qc
      JOIN quota_percent_segments qps ON qps.cycle_id = qc.id
      JOIN latest_account la ON qc.auth_index = la.auth_index
      WHERE qc.provider = 'codex'
      ORDER BY qps.last_observed_at DESC, qps.id DESC
      LIMIT 2;
    "`);

    const rateLimits = [];
    if (quotaOut.stdout) {
      const now = new Date();
      for (const line of quotaOut.stdout.trim().split('\n').filter(Boolean)) {
        const [key, windowSec, resetAtStr, remainingPercent] = line.split('|');
        const resetAt = new Date(resetAtStr);
        const isExpired = !isNaN(resetAt) && resetAt <= now;
        const remaining = isExpired ? 100 : parseInt(remainingPercent || '0', 10);
        const windowLabel = parseInt(windowSec, 10) <= 21600 ? '5h' : '7d';
        rateLimits.push({
          key,
          label: windowLabel,
          remainingPercent: remaining,
          usedPercent: Math.max(0, 100 - remaining),
          resetAt: resetAtStr,
          isExpired
        });
      }
    }

    return { stats, rateLimits };
  } catch (err) {
    return null;
  }
}

app.get('/api/tokens/keeper-stats', async (req, res) => {
  const data = await getKeeperTokenStats();
  if (!data) return res.json({ success: false, error: 'Keeper database unavailable' });
  res.json({ success: true, ...data });
});

app.get('/api/repos/:repoId/commits', async (req, res) => {
  try {
    const repoPath = registry.resolve(req.params.repoId);
    const [status, commits, presets] = await Promise.all([getStatus(repoPath), getCommits(repoPath), getPresets(repoPath)]);
    if (status.length) commits.unshift({ hash: 'working-tree', shortHash: 'HEAD*',
      msg: `当前未提交改动 (${status.length} 个文件)`, author: 'You', relTime: 'Just now',
      isWorkingTree: true, fileCount: status.length });
    res.json({ success: true, commits, presets, repoPath, dirtyCount: status.length });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/repos/:repoId/diff', async (req, res) => {
  try {
    const repoPath = registry.resolve(req.params.repoId);
    const data = await loadDiff(repoPath, req.query.target || 'working-tree');
    res.json({ ...data, repoPath, hasFacts: Boolean(getProjectFacts(repoPath)) });
  } catch (error) { res.status(error.status || 500).json({ success: false, error: error.message }); }
});

app.get('/api/models', async (req, res) => {
  const defaultModels = [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (深度思考带读 - 推荐)' },
    { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 High (高维架构解构)' },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High (AGY 极速免限额)' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol (Codex Plus 旗舰推理)' },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (高维架构推演)' }
  ];

  try {
    const cpaRes = await fetchImpl('http://127.0.0.1:8317/v1/models', {
      headers: { 'Authorization': `Bearer ${PROXY_KEY}` },
      signal: AbortSignal.timeout(2000)
    });
    if (cpaRes.ok) {
      const data = await cpaRes.json();
      if (Array.isArray(data.data)) {
        const availableIds = new Set(data.data.map(m => m.id));
        const activeDefaults = defaultModels.filter(m => availableIds.has(m.id));
        const otherModels = data.data
          .filter(m => !defaultModels.some(dm => dm.id === m.id))
          .map(m => ({ id: m.id, name: `${m.id} (${m.owned_by || 'CPA'})` }));

        return res.json({ models: [...activeDefaults, ...otherModels] });
      }
    }
  } catch {}

  res.json({ models: defaultModels });
});

// ----------------- P0 + P1: 导师带读核心 (多轮连贯记忆 + 项目事实源注入) -----------------
app.post('/api/mentor/analyze', async (req, res) => {
  const { 
    repoPath, 
    target, 
    mode = 'walkthrough', 
    customPrompt, 
    focusFile = null,
    model = 'claude-sonnet-4-6',
    history = [] // P1: 多轮对话记忆上下文
  } = req.body;

  try { registry.resolvePath(repoPath); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const lifecycle = requestLifecycle(res, 180000);
  const sendEvent = (data) => {
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendEvent({ type: 'status', message: '正在加载项目事实源与 Git 差异...' });

    let diff = await loadDiff(repoPath, target || 'working-tree', { signal: lifecycle.signal });
    if (diff.isCleanWorkingTree && diff.fallbackHead) {
      sendEvent({ type: 'status', message: `工作区干净，使用最新提交 ${diff.fallbackHead.shortHash}` });
      diff = await loadDiff(repoPath, diff.fallbackHead.hash, { signal: lifecycle.signal });
    }
    const parsedFiles = diff.files;
    const cleanDiff = getCleanDiffForMentor(parsedFiles, focusFile);
    if (!cleanDiff.trim()) {
      sendEvent({ type: 'error', message: '选中的目标没有可分析的文本代码，敏感文件和符号链接已排除' });
      res.end(); return;
    }
    const commitInfo = diff.commitInfo;
    const projectFacts = getProjectFacts(repoPath);
    sendEvent({ type: 'status', message: '已提取代码差异和可用项目文档，正在分析...' });

    // 3. 构建系统 Prompt 与项目约束
    const systemInstruction = `你是一位世界级的系统架构师和技术领航导师（Tech Mentor）。
用户当前由 AI 完成了代码开发，现在需要你帮助用户彻底吃透这次提交的代码实现与架构设计。

【核心教学原则】
1. 严禁空洞念代码（绝不做“第10行引入了库，第20行定义了变量”这种字面翻译）。
2. 必须讲透【设计意图与权衡】（为什么这么改？受限条件是什么？为什么选择现在的方案而不是备选方案？）。
3. 必须绘制直观的【Mermaid 架构流程图、时序图或状态流转图】。
4. 必须萃取【核心 15~30 行灵魂代码】，带行号并做深度技术原理解剖（如特定系统调用、并发锁、协议解析等）。
5. 必须揭露【隐藏的暗桩与防御性代码】（哪几行看似冗余的代码其实是在防范重大生产崩溃？）。
6. 如果存在【项目事实源与关键约束】，你必须结合该项目的事实标准（如文件系统、跨平台、单一事实源等）给出最深刻的剖析。
7. 最后给出 1~2 个【苏格拉底场景推演自测题】考查用户，促成认知内化。
`;

    // 4. 构建初始代码上下文消息
    const contextPrompt = `项目路径: ${repoPath}
${commitInfo}
${focusFile ? `【聚焦单个文件】: ${focusFile}` : `【变动文件概览】: 包含 ${parsedFiles.length} 个文件`}

${projectFacts ? `=== 项目全局事实源与架构规范 (PROJECT SSOT) ===\n${projectFacts}\n\n` : ''}
=== 代码变动 (CLEAN DIFF) ===
${cleanDiff}
`;

    // 5. 组织多轮对话消息栈 (P1 会话记忆支持)
    const messages = [
      { role: 'system', content: systemInstruction }
    ];

    if (history && history.length > 0) {
      // 多轮追问模式：保留首轮上下文，并附带历史对话
      messages.push({ role: 'user', content: contextPrompt });
      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: 'user', content: customPrompt });
    } else {
      // 首次带读模式
      let initialInstruction = '';
      if (mode === 'walkthrough') {
        initialInstruction = '请对以上代码改动结合项目全局约束进行标准的【四阶架构全景带读】。';
      } else if (mode === 'anatomy') {
        initialInstruction = '请针对以上改动做显微镜级的【核心代码实相剖析】，抽出最灵魂的 15~30 行骨架逐段解构。';
      } else if (mode === 'pitfalls') {
        initialInstruction = '请专门排查以上改动中的【隐蔽暗桩与防御性设计 (Pitfalls & Gotchas)】，指出防御点与边界风险。';
      } else if (mode === 'drill') {
        initialInstruction = '请出 2 道具挑战性的【苏格拉底实战推演题】考查我，并在问题下方提供深入推演思路。';
      } else if (mode === 'custom') {
        initialInstruction = `用户提问: ${customPrompt}`;
      }
      messages.push({ role: 'user', content: `${contextPrompt}\n\n${initialInstruction}` });
    }

    // 6. 发起本地流式请求
    const apiPayload = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages
    };

    const response = await fetchImpl(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PROXY_KEY}`
      },
      body: JSON.stringify(apiPayload),
      signal: lifecycle.signal
    });

    if (!response.ok) {
      await response.body?.cancel();
      sendEvent({ type: 'error', message: `API 请求失败 (${response.status})，请检查代理凭据和模型可用性` });
      res.end();
      return;
    }

    await relayCompletion(response, sendEvent, lifecycle.signal);
    res.end();

  } catch (err) {
    sendEvent({ type: 'error', message: lifecycle.signal.aborted ? lifecycle.signal.reason.message : `分析失败: ${err.message}` });
    res.end();
  } finally {
    lifecycle.dispose();
  }
});


app.get('/api/health', (req, res) => res.json({ success: true, service: 'tech-mentor-studio' }));
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
