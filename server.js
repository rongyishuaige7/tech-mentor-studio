import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3300;
const PROXY_URL = 'http://127.0.0.1:8317/v1/chat/completions';
const PROXY_KEY = 'REDACTED-LOCAL-KEY';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 数据持久化路径
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

function getWatchlist() {
  if (fs.existsSync(WATCHLIST_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveWatchlist(list) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

// 默认扫描的顶级目录
const DEFAULT_SCAN_ROOTS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Developer'),
  path.join(os.homedir(), 'Github'),
  path.join(os.homedir())
];

// 辅助：执行 git 命令
async function runGit(args, cwd) {
  try {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd,
      maxBuffer: 30 * 1024 * 1024,
      env: { ...process.env, LANG: 'en_US.UTF-8' }
    });
    return stdout.trim();
  } catch (err) {
    if (err.stdout) return err.stdout.trim();
    throw err;
  }
}

// ----------------- P0: 智能 Diff 过滤与文件结构化 -----------------

const NOISE_PATTERNS = [
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Cargo\.lock$/,
  /composer\.lock$/,
  /Pipfile\.lock$/,
  /poetry\.lock$/,
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|webm|zip|tar\.gz)$/i,
  /\.DS_Store$/,
  /\.pyc$/,
  /__pycache__/
];

function isNoiseFile(filePath) {
  return NOISE_PATTERNS.some(re => re.test(filePath));
}

function parseDiffFiles(diffText) {
  if (!diffText) return [];
  const files = [];
  const chunks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const header = lines[0] || '';
    const match = header.match(/a\/(.+?)\s+b\/(.+)/);
    const filePath = match ? match[2].trim() : (lines[1] || 'unknown').trim();

    let additions = 0;
    let deletions = 0;
    for (const l of lines) {
      if (l.startsWith('+') && !l.startsWith('+++')) additions++;
      else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
    }

    const isNoise = isNoiseFile(filePath);

    files.push({
      path: filePath,
      additions,
      deletions,
      isNoise,
      patch: 'diff --git ' + chunk
    });
  }

  return files;
}

function getCleanDiffForMentor(diffFiles, focusFile = null) {
  let selected = diffFiles;
  if (focusFile) {
    selected = diffFiles.filter(f => f.path === focusFile);
  }
  // 排除噪音文件
  const codeFiles = selected.filter(f => !f.isNoise);
  const targetFiles = codeFiles.length > 0 ? codeFiles : selected;

  let combined = '';
  for (const f of targetFiles) {
    if ((combined + f.patch).length > 60000) {
      combined += `\n\n# ... [文件 ${f.path} 及后续变动过长已自动截断] ...\n`;
      break;
    }
    combined += f.patch + '\n';
  }
  return combined;
}

// ----------------- P0: 项目级事实源 (SSOT) 自动探针 -----------------

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
          const raw = fs.readFileSync(fullPath, 'utf-8');
          // 取前 80 行，提炼核心架构规则
          const lines = raw.split('\n').slice(0, 80).join('\n');
          facts.push(`### [项目事实源与关键约束: ${relPath}]\n${lines.trim()}`);
          if (facts.length >= 2) break; // 取前 2 个最重要的事实文件
        }
      } catch {}
    }
  }

  // 补充 package.json 基础信息
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {}).slice(0, 10).join(', ');
      facts.unshift(`【项目属性】名称: ${pkg.name || path.basename(repoPath)} | 描述: ${pkg.description || '无'} | 核心依赖: ${deps || '原生标准库'}`);
    } catch {}
  }

  return facts.join('\n\n');
}

// 扫描 Git 仓库
async function scanRepositories() {
  const discovered = new Map();
  const watchlist = getWatchlist();

  for (const p of watchlist) {
    if (fs.existsSync(path.join(p, '.git'))) {
      discovered.set(p, { path: p, isManual: true });
    }
  }

  for (const root of DEFAULT_SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const fullPath = path.join(root, entry.name);
        if (fs.existsSync(path.join(fullPath, '.git'))) {
          if (!discovered.has(fullPath)) {
            discovered.set(fullPath, { path: fullPath, isManual: false });
          }
        }
      }
    } catch {}
  }

  const repos = [];
  for (const [repoPath] of discovered.entries()) {
    try {
      const name = path.basename(repoPath);
      let branch = 'unknown';
      let lastCommit = '';
      let dirtyCount = 0;

      try {
        branch = await runGit('branch --show-current', repoPath) || 'HEAD';
      } catch {}

      try {
        const logLine = await runGit('log -1 --pretty=format:"%h|%s|%ar|%an"', repoPath);
        if (logLine) {
          const [hash, msg, time, author] = logLine.split('|');
          lastCommit = { hash, msg, time, author };
        }
      } catch {}

      try {
        const status = await runGit('status --porcelain', repoPath);
        if (status) {
          dirtyCount = status.split('\n').filter(Boolean).length;
        }
      } catch {}

      repos.push({
        id: Buffer.from(repoPath).toString('base64url'),
        name,
        path: repoPath,
        branch,
        lastCommit,
        dirtyCount
      });
    } catch {}
  }

  return repos.sort((a, b) => (b.dirtyCount > 0 ? 1 : 0) - (a.dirtyCount > 0 ? 1 : 0));
}

// ----------------- API 路由 -----------------

app.get('/api/repos', async (req, res) => {
  try {
    const repos = await scanRepositories();
    res.json({ success: true, repos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/repos/add', async (req, res) => {
  try {
    let { targetPath } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'targetPath required' });
    targetPath = path.resolve(targetPath.replace(/^~/, os.homedir()));

    if (!fs.existsSync(path.join(targetPath, '.git'))) {
      return res.status(400).json({ error: '指定目录不是有效的 Git 仓库' });
    }

    const list = getWatchlist();
    if (!list.includes(targetPath)) {
      list.push(targetPath);
      saveWatchlist(list);
    }
    res.json({ success: true, path: targetPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos/:repoId/commits', async (req, res) => {
  try {
    const repoPath = Buffer.from(req.params.repoId, 'base64url').toString('utf-8');
    if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'Repo not found' });

    const statusOut = await runGit('status --porcelain', repoPath);
    const uncommittedFiles = statusOut ? statusOut.split('\n').filter(Boolean) : [];

    let commits = [];
    try {
      const logs = await runGit('log -n 30 --pretty=format:"%H|%h|%s|%an|%ar|%ci"', repoPath);
      if (logs) {
        commits = logs.split('\n').filter(Boolean).map(line => {
          const [hash, shortHash, msg, author, relTime, fullTime] = line.split('|');
          return { hash, shortHash, msg, author, relTime, fullTime, isWorkingTree: false };
        });
      }
    } catch {}

    if (uncommittedFiles.length > 0) {
      commits.unshift({
        hash: 'working-tree',
        shortHash: 'HEAD*',
        msg: `⚡ 当前未提交的改动 (${uncommittedFiles.length} 个文件变更)`,
        author: 'You (Uncommitted)',
        relTime: 'Just now',
        fullTime: new Date().toISOString(),
        isWorkingTree: true,
        fileCount: uncommittedFiles.length
      });
    }

    res.json({ success: true, commits, repoPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 提取工作区变动 (包括跟踪文件的修改与全新未跟踪文件 ??)
async function getWorkingTreeDiff(repoPath) {
  let diffText = '';
  try {
    diffText = await runGit('diff HEAD', repoPath) || await runGit('diff', repoPath) || await runGit('diff --cached', repoPath);
  } catch {}

  // 补全新增但尚未被 Git 跟踪的文件 (Untracked ??)
  try {
    const statusOut = await runGit('status --porcelain', repoPath);
    if (statusOut) {
      const lines = statusOut.split('\n');
      for (const line of lines) {
        if (line.startsWith('?? ')) {
          let relPath = line.slice(3).trim();
          if (relPath.startsWith('"') && relPath.endsWith('"')) {
            relPath = relPath.slice(1, -1);
          }
          if (isNoiseFile(relPath)) continue;

          const fullPath = path.join(repoPath, relPath);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const size = fs.statSync(fullPath).size;
            if (size > 0 && size < 300000) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const fileLines = content.split('\n');
                diffText += `\ndiff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${fileLines.length} @@\n`;
                for (const fl of fileLines) {
                  diffText += '+' + fl + '\n';
                }
              } catch {}
            }
          }
        }
      }
    }
  } catch {}

  return diffText;
}

// 获取 Diff 与文件结构化索引
app.get('/api/repos/:repoId/diff', async (req, res) => {
  try {
    const repoPath = Buffer.from(req.params.repoId, 'base64url').toString('utf-8');
    const target = req.query.target || 'working-tree';

    let diffText = '';
    let statText = '';
    let summaryText = '';

    if (target === 'working-tree') {
      diffText = await getWorkingTreeDiff(repoPath);
      statText = await runGit('diff --stat HEAD', repoPath) || await runGit('diff --stat', repoPath);
      summaryText = await runGit('diff --compact-summary HEAD', repoPath) || await runGit('diff --compact-summary', repoPath);
    } else {
      diffText = await runGit(`show -p ${target}`, repoPath);
      statText = await runGit(`show --stat ${target}`, repoPath);
      summaryText = await runGit(`show --compact-summary ${target}`, repoPath);
    }

    const files = parseDiffFiles(diffText);
    const facts = getProjectFacts(repoPath);

    res.json({
      success: true,
      target,
      diffText,
      statText,
      summaryText,
      repoPath,
      files,
      hasFacts: Boolean(facts)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/models', async (req, res) => {
  res.json({
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (深度思考带读 - 推荐)' },
      { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash (极速响应)' },
      { id: 'gemini-pro-agent', name: 'Gemini Pro Agent' }
    ]
  });
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

  if (!repoPath || !fs.existsSync(repoPath)) {
    return res.status(400).json({ error: 'Invalid repoPath' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    sendEvent({ type: 'status', message: '正在加载项目事实源与 Git 差异...' });

    // 1. 提取 Diff 与项目全局事实
    let rawDiff = '';
    let commitInfo = '';

    if (target === 'working-tree') {
      rawDiff = await getWorkingTreeDiff(repoPath);
      commitInfo = '【当前工作区未提交修改 (Working Tree)】';
    } else {
      commitInfo = await runGit(`log -1 --pretty=format:"提交: %h - %s (%an, %ar)" ${target}`, repoPath);
      rawDiff = await runGit(`show -p ${target}`, repoPath);
    }

    if (!rawDiff || rawDiff.trim() === '') {
      sendEvent({ 
        type: 'error', 
        message: '当前选中的目标没有检测到代码变动（Diff 为空）。\n👉 如果当前工作区代码是干净的，请在左侧列表中点击具体的【历史提交 (Commit)】，让导师为你带读已提交的代码！' 
      });
      res.end();
      return;
    }

    // 2. 智能过滤噪音并提取干净 Diff
    const parsedFiles = parseDiffFiles(rawDiff);
    const cleanDiff = getCleanDiffForMentor(parsedFiles, focusFile);
    const projectFacts = getProjectFacts(repoPath);

    sendEvent({ 
      type: 'status', 
      message: projectFacts ? '已命中项目全局规范 (CLAUDE.md 等)，导师正在结合系统约束深度解析...' : '导师正在分析架构意图与代码实相...' 
    });

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
      messages
    };

    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PROXY_KEY}`
      },
      body: JSON.stringify(apiPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      sendEvent({ type: 'error', message: `API 请求失败 (${response.status}): ${errText}` });
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') {
          sendEvent({ type: 'done' });
          continue;
        }
        try {
          const parsed = JSON.parse(jsonStr);
          const chunk = parsed.choices?.[0]?.delta?.content || '';
          if (chunk) {
            sendEvent({ type: 'chunk', text: chunk });
          }
        } catch {}
      }
    }

    sendEvent({ type: 'finished' });
    res.end();

  } catch (err) {
    sendEvent({ type: 'error', message: `分析失败: ${err.message}` });
    res.end();
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 Tech Mentor Studio 已在本地启动: http://localhost:${PORT}`);
  console.log(`📡 本地 AI 代理连接至: ${PROXY_URL}`);
});
