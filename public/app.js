// Tech Mentor Studio Client Application (P0/P1 Multi-turn & Smart Diff Filter)
let modelsReady = false;
let allRepos = [];
let activeRepo = null;
let activeTarget = 'working-tree'; // 'working-tree' 或 commit hash
let currentDiffFiles = [];
let currentCommits = [];
let currentPresets = [];
let diffPage = 0;
let reposLoadSequence = 0;
let modelsLoadSequence = 0;
let currentDiffWarnings = [];
let currentFocusFile = null; // null 表示全部文件
let currentAbortController = null;
let mentorSessionVersion = 0;
let mentorRequestSequence = 0;
let repoRequestSequence = 0;
let diffRequestSequence = 0;
let currentRepoAbortController = null;
let currentDiffAbortController = null;

// P1: 多轮对话记忆栈 [{ role: 'user' | 'assistant', content: string }]
let conversationHistory = [];
let mentorSnapshotId = null;
let mentorResolvedTarget = null;
const repoSessions = new Map();

const ACTION_PROMPTS = {
  walkthrough: '请结合项目约束对当前代码进行全景架构带读，解释架构意图、核心实现与边界风险。',
  anatomy: '请选取当前改动的核心代码，引用真实文件与行号剖析具体实现机制与权衡。',
  pitfalls: '请深度考查当前代码的隐蔽暗桩、边界条件与防御性设计，并给出修复建议。',
  drill: '请针对当前实现设计两道苏格拉底场景推演自测考题，并附推理过程与参考答案。'
};

function saveCurrentRepoSession() {
  if (!activeRepo) return;
  const chatStream = document.getElementById('mentor-chat-stream');
  if (conversationHistory.length > 0) {
    repoSessions.set(activeRepo.id, {
      conversationHistory: [...conversationHistory],
      mentorSnapshotId,
      mentorResolvedTarget,
      chatHtml: chatStream ? chatStream.innerHTML : null
    });
  }
}

function restoreRepoSession(repoId) {
  currentAbortController?.abort();
  currentAbortController = null;
  document.getElementById('mentor-status-bar')?.classList.add('hidden');

  const saved = repoSessions.get(repoId);
  const chatStream = document.getElementById('mentor-chat-stream');
  if (saved && saved.conversationHistory && saved.conversationHistory.length > 0) {
    mentorSessionVersion++;
    conversationHistory = [...saved.conversationHistory];
    mentorSnapshotId = saved.mentorSnapshotId;
    mentorResolvedTarget = saved.mentorResolvedTarget;
    if (chatStream && saved.chatHtml) {
      chatStream.innerHTML = saved.chatHtml;
      lucide.createIcons();
    }
  } else {
    clearMentorSession();
  }
}

function clearCurrentMentorSession() {
  if (activeRepo) {
    repoSessions.delete(activeRepo.id);
  }
  clearMentorSession();
}

function triggerMentorAction(mode) {
  if (conversationHistory.length === 0 || (mentorResolvedTarget && activeTarget !== mentorResolvedTarget)) {
    startMentorAnalysis(mode, '', true);
  } else {
    const prompt = ACTION_PROMPTS[mode] || mode;
    startMentorAnalysis('custom', prompt, false);
  }
}

let localSessionPromise;
async function apiFetch(url, options = {}) {
  localSessionPromise ||= fetch('/api/session', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('本机会话初始化失败，请刷新页面');
    return (await response.json()).token;
  }).catch(error => { localSessionPromise = null; throw error; });
  const token = await localSessionPromise;
  options.signal?.throwIfAborted();
  const headers = { ...options.headers, 'X-Local-Token': token };
  return fetch(url, { ...options, headers, credentials: 'same-origin' });
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style', 'id', 'name'] });
}

function initTheme() {
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('mentor-theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } catch {}
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  const html = document.documentElement;
  const isDark = theme === 'dark';
  if (isDark) {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
  try { localStorage.setItem('mentor-theme', theme); } catch {}

  const highlightLink = document.getElementById('highlight-theme');
  if (highlightLink) {
    highlightLink.href = isDark ? '/vendor/highlight.css' : '/vendor/highlight-light.css';
  }

  const sunIcon = document.getElementById('theme-icon-sun');
  const moonIcon = document.getElementById('theme-icon-moon');
  if (sunIcon && moonIcon) {
    if (isDark) {
      sunIcon.classList.add('hidden');
      moonIcon.classList.remove('hidden');
    } else {
      sunIcon.classList.remove('hidden');
      moonIcon.classList.add('hidden');
    }
  }

  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'neutral',
      securityLevel: 'strict'
    });
  }
}

function toggleTheme() {
  const currentIsDark = document.documentElement.classList.contains('dark');
  applyTheme(currentIsDark ? 'light' : 'dark');
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight: function(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    }
  });

  lucide.createIcons();
  setupEventListeners();
  loadModels();
  loadRepos();
  loadKeeperStats();
  setInterval(loadKeeperStats, 15000);
});

// 动态同步 CPA 活跃模型清单
function updateAnalysisAvailability() {
  for (const id of ['btn-walkthrough', 'btn-anatomy', 'btn-pitfalls', 'btn-drill', 'btn-submit-prompt']) {
    const button = document.getElementById(id);
    if (button) button.disabled = !modelsReady;
  }
}

async function loadModels() {
  const sequence = ++modelsLoadSequence;
  const select = document.getElementById('model-select');
  const status = document.getElementById('model-status');
  if (!select) return;
  modelsReady = false;
  select.disabled = true;
  updateAnalysisAvailability();
  if (status) status.textContent = '正在查询模型…';
  try {
    const res = await apiFetch('/api/models');
    const data = await res.json();
    if (sequence !== modelsLoadSequence) return;
    if (!res.ok || !data.success || !Array.isArray(data.models) || !data.models.length) throw new Error(data.error || '没有可用模型');
    let preferred = select.value;
    try { preferred ||= localStorage.getItem('mentor-model'); } catch {}
    select.innerHTML = data.models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    if (!preferred) preferred = ['claude-sonnet-4-6', 'gpt-6.1-sol'].find(id => data.models.some(m => m.id === id));
    if (data.models.some(m => m.id === preferred)) select.value = preferred;
    modelsReady = true;
    if (status) status.textContent = `${data.models.length} 个可用模型`;
  } catch (error) {
    if (sequence !== modelsLoadSequence) return;
    if (status) status.textContent = error.message;
    select.innerHTML = '<option value="">模型不可用</option>';
  } finally {
    if (sequence !== modelsLoadSequence) return;
    select.disabled = !modelsReady;
    updateAnalysisAvailability();
  }
}

// 0. 加载 CPA / Keeper 实时统计与配额
async function loadKeeperStats() {
  const textEl = document.getElementById('keeper-token-text');
  const popoverContent = document.getElementById('keeper-popover-content');
  const todayDateEl = document.getElementById('keeper-today-date');
  if (!textEl) return;

  try {
    const res = await apiFetch('/api/tokens/keeper-stats');
    const data = await res.json();
    if (!data.success) {
      textEl.textContent = '计量不可用';
      if (popoverContent) popoverContent.textContent = 'Keeper 计量不可用，请检查数据库路径和 SQLite';
      return;
    }

    const { stats, rateLimits } = data;
    if (todayDateEl) todayDateEl.textContent = `${stats.today || ''} UTC`;

    const formatK = (num) => {
      if (!num) return '0';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
      return String(num);
    };

    let parts = [];
    if (stats.antigravity && stats.antigravity.tokens > 0) {
      parts.push(`AGY: ${formatK(stats.antigravity.tokens)}`);
    }
    if (stats.codex && stats.codex.tokens > 0) {
      parts.push(`Codex: ${formatK(stats.codex.tokens)}`);
    }

    const primaryLimit = (rateLimits || []).find(r => r.label === '5h');
    if (primaryLimit) {
      const remaining = primaryLimit.remainingPercent;
      const color = remaining > 30 ? 'text-[var(--diff-add-text)]' : (remaining > 10 ? 'text-[var(--accent-terracotta)]' : 'text-[var(--diff-del-text)]');
      parts.push(`<span class="${color}">5h: ${remaining === null ? '等待更新' : `${remaining}%`}</span>`);
    }

    textEl.innerHTML = parts.length > 0 ? parts.join(' · ') : '暂无今日计量';

    if (popoverContent) {
      let limitsHtml = (rateLimits || []).map(r => `
        <div class="space-y-1 bg-[var(--bg-card)] p-2.5 rounded-lg border border-[var(--border-app)]">
          <div class="flex justify-between items-center text-[11px]">
            <span class="font-medium text-[var(--text-primary)]">Codex ${escapeHtml(r.label)} 速率窗口</span>
            <span class="font-mono ${r.remainingPercent > 30 ? 'text-[var(--diff-add-text)]' : 'text-[var(--accent-terracotta)]'}">${r.remainingPercent === null ? '等待更新 / 未知' : `剩余 ${r.remainingPercent}%`}</span>
          </div>
          <div class="w-full bg-[var(--progress-track)] h-1.5 rounded-full overflow-hidden">
            <div class="h-full rounded-full ${r.remainingPercent > 30 ? 'bg-[var(--diff-add-text)]' : 'bg-[var(--accent-terracotta)]'}" style="width: ${Number(r.remainingPercent) || 0}%"></div>
          </div>
          <div class="text-[10px] text-[var(--text-subtle)] flex justify-between">
            <span>重置时间: ${r.resetAt ? new Date(r.resetAt).toLocaleString() : '未知'}</span>
          </div>
        </div>
      `).join('');

      let statsHtml = `
        <div class="grid grid-cols-2 gap-2 text-[11px]">
          <div class="bg-[var(--bg-card)] p-2.5 rounded-lg border border-[var(--border-app)]">
            <div class="text-[var(--text-muted)] text-[10px]">今日 Antigravity (AGY)</div>
            <div class="font-mono font-semibold text-[var(--accent-terracotta)] text-xs mt-0.5">${formatK(stats.antigravity?.tokens || 0)} tokens</div>
            <div class="text-[10px] text-[var(--text-subtle)]">${stats.antigravity?.requests || 0} 次请求</div>
          </div>
          <div class="bg-[var(--bg-card)] p-2.5 rounded-lg border border-[var(--border-app)]">
            <div class="text-[var(--text-muted)] text-[10px]">今日 Codex / OpenAI</div>
            <div class="font-mono font-semibold text-[var(--diff-add-text)] text-xs mt-0.5">${formatK(stats.codex?.tokens || 0)} tokens</div>
            <div class="text-[10px] text-[var(--text-subtle)]">${stats.codex?.requests || 0} 次请求</div>
          </div>
        </div>
      `;

      popoverContent.innerHTML = statsHtml + limitsHtml;
    }
  } catch (err) {
    textEl.textContent = '计量不可用';
      if (popoverContent) popoverContent.textContent = 'Keeper 计量不可用，请检查数据库路径和 SQLite';
  }
}

function renderCommitPresets(presets) {
  const container = document.getElementById('commit-presets-bar');
  if (!container) return;
  if (!presets || presets.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = presets.map(p => `
    <button data-action="target" data-value="${escapeHtml(p.hash)}"
            class="px-2 py-0.5 rounded text-[10px] font-mono transition border ${
              activeTarget === p.hash
                ? 'bg-[var(--accent-terracotta)] border-[var(--accent-terracotta)] text-[#ffffff] font-semibold'
                : 'bg-[var(--btn-action-bg)] border-[var(--border-app)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--btn-action-hover)]'
            }" title="${escapeHtml(p.msg)}">
      ${escapeHtml(p.shortHash)}
    </button>
  `).join('');
}

function setupEventListeners() {
  document.addEventListener('click', async event => {
    const copyBtn = event.target.closest('.copy-code-btn');
    if (copyBtn) {
      const wrapper = copyBtn.closest('.code-block-wrapper');
      const code = wrapper?.querySelector('pre code');
      if (code) {
        try {
          await navigator.clipboard.writeText(code.innerText || code.textContent);
          copyBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-[var(--diff-add-text)]"></i> 已复制';
          lucide.createIcons();
          setTimeout(() => {
            copyBtn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i> 复制代码';
            lucide.createIcons();
          }, 2000);
        } catch {}
      }
      return;
    }

    const button = event.target.closest('[data-action]');
    if (!button) return;
    const value = button.dataset.value;
    switch (button.dataset.action) {
      case 'repo': window.selectRepoById(value); break;
      case 'target': window.selectTarget(value); break;
      case 'focus': window.setFocusFile(value); break;
      case 'focus-all': window.setFocusFile(null); break;
      case 'ask': window.quickAsk(value); break;
      case 'diff-page': diffPage = Number(value); renderActiveDiff(false); break;
      case 'panel': showPanel(value); break;
    }
  });
  document.getElementById('btn-refresh').addEventListener('click', () => loadRepos(true));
  document.getElementById('btn-theme-toggle')?.addEventListener('click', toggleTheme);
  document.getElementById('btn-retry-models').addEventListener('click', loadModels);
  document.getElementById('model-select').addEventListener('change', event => { try { localStorage.setItem('mentor-model', event.target.value); } catch {} });
  document.getElementById('repo-search').addEventListener('input', handleRepoFilter);
  document.getElementById('btn-add-repo').addEventListener('click', handleAddRepo);
  document.getElementById('btn-add-repo-manual')?.addEventListener('click', handleAddRepoManual);

  // CPA 详情浮窗控制
  const keeperPill = document.getElementById('keeper-token-pill');
  const keeperPopover = document.getElementById('keeper-detail-popover');
  if (keeperPill && keeperPopover) {
    keeperPill.addEventListener('click', (e) => {
      e.stopPropagation();
      keeperPopover.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!keeperPopover.contains(e.target) && !keeperPill.contains(e.target)) {
        keeperPopover.classList.add('hidden');
      }
    });
  }

  // 快捷动作按钮 (未开始或切目标时启动精读，已有对话时作为追问深入)
  document.getElementById('btn-walkthrough').addEventListener('click', () => triggerMentorAction('walkthrough'));
  document.getElementById('btn-anatomy').addEventListener('click', () => triggerMentorAction('anatomy'));
  document.getElementById('btn-pitfalls').addEventListener('click', () => triggerMentorAction('pitfalls'));
  document.getElementById('btn-drill').addEventListener('click', () => triggerMentorAction('drill'));

  // 底部多轮追问表单提交
  document.getElementById('mentor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('mentor-input');
    const prompt = input.value.trim();
    if (prompt) {
      startMentorAnalysis('custom', prompt, false); // 多轮追问
      input.value = '';
    }
  });

  document.getElementById('btn-stop-analyze').addEventListener('click', stopMentorAnalysis);

  // 清空多轮对话
  document.getElementById('btn-clear-mentor').addEventListener('click', clearCurrentMentorSession);

  // 复制笔记
  document.getElementById('btn-copy-mentor').addEventListener('click', copyMentorNotes);

  // 导出笔记为 .md 本地文档
  const btnExport = document.getElementById('btn-export-mentor');
  if (btnExport) {
    btnExport.addEventListener('click', exportMentorMarkdown);
  }

  // 复制当前展示的 Diff
  const btnCopyDiff = document.getElementById('btn-copy-diff');
  if (btnCopyDiff) {
    btnCopyDiff.addEventListener('click', copyCurrentDiff);
  }
}

// 1. 加载仓库列表
async function loadRepos(refresh = false) {
  const sequence = ++reposLoadSequence;
  const refreshButton = document.getElementById('btn-refresh');
  refreshButton.disabled = true;
  const listEl = document.getElementById('repo-list');
  listEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-8">正在扫描本地 Git 仓库...</div>';

  try {
    const res = await apiFetch(`/api/repos${refresh ? '?refresh=1' : ''}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (sequence !== reposLoadSequence) return;
    allRepos = data.repos;
    if (activeRepo) activeRepo = allRepos.find(repo => repo.id === activeRepo.id) || activeRepo;
    document.getElementById('repo-count').textContent = allRepos.length;
    handleRepoFilter({ target: document.getElementById('repo-search') });

    if (allRepos.length > 0 && !activeRepo) {
      selectRepo(allRepos[0]);
    }
  } catch (err) {
    if (sequence === reposLoadSequence) listEl.innerHTML = `<div class="text-xs text-rose-400 text-center py-6">加载仓库失败: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (sequence === reposLoadSequence) refreshButton.disabled = false;
  }
}

function renderRepoList(repos) {
  const listEl = document.getElementById('repo-list');
  if (repos.length === 0) {
    listEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-6">未发现 Git 仓库</div>';
    return;
  }

  listEl.innerHTML = repos.map(repo => {
    const isSelected = activeRepo && activeRepo.id === repo.id;
    const hasDirty = repo.dirtyCount > 0;

    return `
      <div data-action="repo" data-value="${escapeHtml(repo.id)}"
           class="p-2.5 rounded-lg cursor-pointer transition flex flex-col gap-1 border ${
             isSelected
               ? 'bg-[var(--bg-surface-hover)] border-[var(--accent-terracotta)] text-[var(--text-primary)]'
               : 'bg-[var(--bg-card)] border-[var(--border-subtle)] hover:bg-[var(--bg-card-hover)] text-[var(--text-secondary)]'
           }">
        <div class="flex items-center justify-between">
          <span class="repo-name font-medium text-xs truncate flex items-center gap-1.5">
            <i data-lucide="folder-git-2" class="w-3.5 h-3.5 ${isSelected ? 'text-[var(--accent-terracotta)]' : 'text-[var(--text-muted)]'}"></i>
            <span class="truncate">${escapeHtml(repo.name)}</span>
          </span>
          ${hasDirty
            ? `<span class="text-[10px] px-2 py-0.2 rounded-full bg-[var(--accent-terracotta-bg)] text-[var(--accent-terracotta)] border border-[var(--accent-terracotta-border)] font-mono font-medium shrink-0">${repo.dirtyCount} 变动</span>`
            : `<span class="text-[10px] text-[var(--text-subtle)] font-mono">${escapeHtml(repo.branch)}</span>`
          }
        </div>
        ${repo.error ? `<div class="text-[11px] text-[var(--diff-del-text)]">读取失败: ${escapeHtml(repo.error)}</div>` : ''}
        ${repo.lastCommit ? `
          <div class="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
            ${escapeHtml(repo.lastCommit.msg)}
          </div>
          <div class="text-[10px] text-[var(--text-subtle)] flex items-center justify-between mt-0.5 font-mono">
            <span>${escapeHtml(repo.lastCommit.author)}</span>
            <span>${escapeHtml(repo.lastCommit.time)}</span>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

window.selectRepoById = (id) => {
  const repo = allRepos.find(r => r.id === id);
  if (repo) selectRepo(repo);
};

function handleRepoFilter(e) {
  const q = e.target.value.toLowerCase().trim();
  const filtered = allRepos.filter(r =>
    r.name.toLowerCase().includes(q) ||
    r.path.toLowerCase().includes(q) ||
    (r.lastCommit && r.lastCommit.msg.toLowerCase().includes(q))
  );
  renderRepoList(filtered);
}

async function handleAddRepo() {
  const addBtn = document.getElementById('btn-add-repo');
  const originalHtml = addBtn ? addBtn.innerHTML : '';
  if (addBtn) {
    addBtn.disabled = true;
    addBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> 选择中…';
    lucide.createIcons();
  }

  try {
    const res = await apiFetch('/api/repos/pick', { method: 'POST' });
    const data = await res.json();
    if (data.canceled) return;
    if (!res.ok || !data.success) {
      if (data.unsupported) {
        return handleAddRepoManual();
      }
      throw new Error(data.error || '添加项目失败');
    }

    await loadRepos();
    const added = allRepos.find(r => r.path === data.path);
    if (added) {
      selectRepo(added);
    }
  } catch (err) {
    const fallback = confirm(`启动系统目录选择器失败 (${err.message})。\n\n是否切换为手动输入路径？`);
    if (fallback) {
      handleAddRepoManual();
    }
  } finally {
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.innerHTML = originalHtml;
      lucide.createIcons();
    }
  }
}

async function handleAddRepoManual() {
  const targetPath = prompt('请输入本地 Git 项目的绝对路径 (支持 ~ 代表主目录):');
  if (!targetPath) return;

  try {
    const res = await apiFetch('/api/repos/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    await loadRepos();
    const added = allRepos.find(r => r.path === data.path);
    if (added) {
      selectRepo(added);
    }
  } catch (err) {
    alert(`添加失败: ${err.message}`);
  }
}

// 2. 选择仓库并加载提交记录
async function selectRepo(repo) {
  saveCurrentRepoSession();
  showPanel('diff');
  currentCommits = [];
  currentPresets = [];
  const sequence = ++repoRequestSequence;
  currentRepoAbortController?.abort();
  const controller = new AbortController();
  currentRepoAbortController = controller;
  currentDiffAbortController?.abort();
  diffRequestSequence++;
  currentDiffFiles = [];
  activeTarget = 'working-tree';
  activeRepo = repo;
  currentFocusFile = null;
  restoreRepoSession(repo.id);
  handleRepoFilter({ target: document.getElementById('repo-search') });

  document.getElementById('active-repo-name').textContent = repo.name;
  document.getElementById('active-repo-path').textContent = repo.path;
  const branchBadge = document.getElementById('active-repo-branch');
  branchBadge.textContent = repo.branch;
  branchBadge.classList.remove('hidden');

  const commitListEl = document.getElementById('commit-list');
  commitListEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-6">正在读取变动记录...</div>';

  try {
    const res = await apiFetch(`/api/repos/${repo.id}/commits`, { signal: controller.signal });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (sequence !== repoRequestSequence || activeRepo?.id !== repo.id) return;
    currentPresets = data.presets || [];
    currentCommits = data.commits;
    renderCommitPresets(currentPresets);
    renderCommitList(currentCommits);

    if (data.commits.length > 0) {
      if (data.dirtyCount === 0) {
        const latestRealCommit = data.commits.find(c => !c.isWorkingTree);
        selectTarget(latestRealCommit ? latestRealCommit.hash : data.commits[0].hash);
      } else {
        selectTarget(data.commits[0].hash);
      }
    } else {
      selectTarget('working-tree');
    }
  } catch (err) {
    if (sequence !== repoRequestSequence || err.name === 'AbortError') return;
    commitListEl.innerHTML = `<div class="text-xs text-rose-400 text-center py-4">读取提交失败: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCommitList(commits) {
  const commitListEl = document.getElementById('commit-list');
  if (commits.length === 0) {
    commitListEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-6">暂无提交记录</div>';
    return;
  }

  commitListEl.innerHTML = commits.map(c => {
    const isSelected = activeTarget === c.hash;
    const isWorkingTree = c.isWorkingTree;

    return `
      <div data-action="target" data-value="${escapeHtml(c.hash)}"
           class="p-2 px-3 cursor-pointer transition flex items-center justify-between border-l-2 ${
             isSelected
               ? 'bg-[var(--bg-surface-hover)] border-[var(--accent-terracotta)] text-[var(--text-primary)] font-medium'
               : isWorkingTree
                 ? 'bg-[var(--accent-terracotta-bg)] border-[var(--accent-terracotta)] text-[var(--accent-terracotta)] hover:bg-[var(--accent-terracotta-bg)]'
                 : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]'
           }">
        <div class="truncate mr-2">
          <div class="text-xs truncate flex items-center gap-1.5">
            ${isWorkingTree ? '<i data-lucide="edit-3" class="w-3 h-3 text-[var(--accent-terracotta)] shrink-0"></i>' : ''}
            ${escapeHtml(c.msg)}
          </div>
          <div class="text-[10px] text-[var(--text-subtle)] mt-0.5 font-mono">
            <span>${escapeHtml(c.author)}</span> · <span>${escapeHtml(c.relTime)}</span>
          </div>
        </div>
        <span class="text-[10px] font-mono shrink-0 px-1.5 py-0.2 rounded bg-[var(--btn-action-bg)] border border-[var(--border-app)] text-[var(--text-muted)]">
          ${escapeHtml(c.shortHash)}
        </span>
      </div>
    `;
  }).join('');
}

window.selectTarget = (targetHash) => {
  activeTarget = targetHash;
  renderCommitPresets(currentPresets);
  renderCommitList(currentCommits);
  currentFocusFile = null;
  if (activeRepo) {
    fetchDiff(activeRepo.id, targetHash);
  }
};

// 3. 加载 Diff 内容与变动文件树
async function fetchDiff(repoId, target) {
  const sequence = ++diffRequestSequence;
  currentDiffAbortController?.abort();
  const controller = new AbortController();
  currentDiffAbortController = controller;
  currentDiffFiles = [];
  currentDiffWarnings = [];
  renderFileFilterChips([]);
  document.getElementById('diff-stat-badge').textContent = '加载中';
  const diffEl = document.getElementById('diff-content');
  diffEl.innerHTML = '<div class="p-4 text-slate-500 font-mono text-xs">正在生成差异对比...</div>';

  document.getElementById('diff-target-label').textContent =
    target === 'working-tree' ? '当前未提交变动 (Working Tree)' :
    target.startsWith('range:') ? `聚合区间 ${target.slice(6)}` :
    target.includes('..') ? `区间对比 ${target}` :
    `提交 ${target.slice(0, 8)}`;

  try {
    const res = await apiFetch(`/api/repos/${repoId}/diff?target=${encodeURIComponent(target)}`, { signal: controller.signal });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (sequence !== diffRequestSequence || activeRepo?.id !== repoId) return;

    // 更新事实源挂载指示器
    const factsBadge = document.getElementById('facts-badge');
    if (data.hasFacts) {
      factsBadge.classList.remove('hidden');
      factsBadge.classList.add('flex');
    } else {
      factsBadge.classList.add('hidden');
      factsBadge.classList.remove('flex');
    }

    currentDiffFiles = data.files || [];
    currentDiffWarnings = data.warnings || [];
    renderFileFilterChips(currentDiffFiles);

    const statBadge = document.getElementById('diff-stat-badge');
    statBadge.textContent = data.statText ? data.statText.split('\n').pop().trim() : '0 文件';

    if (!data.diffText || data.diffText.trim() === '') {
      if (data.isCleanWorkingTree && data.fallbackHead) {
        diffEl.innerHTML = `
          <div class="p-8 text-center text-[var(--text-muted)] space-y-3 bg-[var(--bg-card)] rounded-xl border border-[var(--border-app)] m-4 shadow-sm">
            <div class="w-10 h-10 rounded-full bg-[var(--diff-add-bg)] text-[var(--diff-add-text)] flex items-center justify-center mx-auto">
              <i data-lucide="check" class="w-5 h-5"></i>
            </div>
            <div class="text-[var(--text-primary)] text-sm font-medium">当前工作区已全部提交 (工作区干净)</div>
            <p class="text-xs text-[var(--text-muted)] max-w-sm mx-auto leading-relaxed">
              没有未暂存的代码改动。可直接查看最新提交 [${data.fallbackHead.shortHash}]，或点击上方快捷带读让导师剖析最新提交。
            </p>
            <div class="pt-2">
              <button data-action="target" data-value="${escapeHtml(data.fallbackHead.hash)}" class="px-3.5 py-1.5 bg-[var(--accent-terracotta)] hover:bg-[var(--accent-terracotta-hover)] text-[#ffffff] rounded-lg text-xs font-semibold transition flex items-center gap-1.5 mx-auto shadow-sm">
                <i data-lucide="git-commit" class="w-3.5 h-3.5"></i>
                查看最新提交 [${data.fallbackHead.shortHash}]
              </button>
            </div>
          </div>
        `;
        lucide.createIcons();
      } else {
        diffEl.innerHTML = `
          <div class="p-6 text-center text-[var(--text-subtle)] space-y-2">
            <div class="text-[var(--text-primary)] text-sm font-medium">当前目标没有检测到代码差异</div>
            <p class="text-xs text-[var(--text-muted)] max-w-xs mx-auto leading-relaxed">
              ${target === 'working-tree'
                ? '当前工作区干净，无未提交变动。请在上方选择一条历史提交 (Commit) 查看。'
                : '该提交没有文本文件变动或为无修改合并。请选择其他提交查看。'}
            </p>
          </div>
        `;
      }
      return;
    }

    renderActiveDiff();
  } catch (err) {
    if (sequence !== diffRequestSequence || err.name === 'AbortError') return;
    diffEl.innerHTML = `<div class="p-4 text-rose-400 text-xs font-mono">获取 Diff 失败: ${escapeHtml(err.message)}</div>`;
  }
}

// 渲染变动文件过滤标签流 (Chips)
function renderFileFilterChips(files) {
  const container = document.getElementById('file-filter-chips');
  if (!files || files.length === 0) {
    container.innerHTML = '<span class="text-slate-500 text-[10px]">无变动文件</span>';
    return;
  }

  const allActive = currentFocusFile === null;
  let html = `
    <span class="text-[var(--text-subtle)] text-[10px]">变动文件:</span>
    <button data-action="focus-all"
            class="px-2 py-0.5 rounded text-[10px] font-mono transition shrink-0 ${
              allActive ? 'bg-[var(--accent-terracotta)] text-[#ffffff] font-semibold' : 'bg-[var(--btn-action-bg)] border border-[var(--border-app)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--btn-action-hover)]'
            }">
      全部文件 (${files.length})
    </button>
  `;

  html += files.map(f => {
    const isActive = currentFocusFile === f.path;
    const baseName = f.path.split('/').pop();
    const isNoise = f.isNoise;

    return `
      <button data-action="focus" data-value="${escapeHtml(f.path)}"
              title="${escapeHtml(f.path)}"
              class="px-2 py-0.5 rounded text-[10px] font-mono transition shrink-0 flex items-center gap-1 ${
                isActive
                  ? 'bg-[var(--accent-terracotta)] text-[#ffffff] font-semibold shadow-sm'
                  : isNoise
                    ? 'bg-[var(--bg-input)] text-[var(--text-subtle)] border border-[var(--border-app)] hover:bg-[var(--btn-action-hover)]'
                    : 'bg-[var(--btn-action-bg)] border border-[var(--border-app)] text-[var(--text-secondary)] hover:bg-[var(--btn-action-hover)]'
              }">
        <span class="truncate max-w-[120px]">${escapeHtml(baseName)}</span>
        <span class="text-[9px] text-[var(--diff-add-text)]">+${f.additions}</span>
        <span class="text-[9px] text-[var(--diff-del-text)]">-${f.deletions}</span>
      </button>
    `;
  }).join('');

  container.innerHTML = html;
}

window.setFocusFile = (filePath) => {
  if (currentFocusFile !== filePath) clearMentorSession();
  currentFocusFile = filePath;
  renderFileFilterChips(currentDiffFiles);
  renderActiveDiff();
};

function showPanel(panel) {
  const main = document.getElementById('workspace');
  if (!main || !['repos', 'diff', 'mentor'].includes(panel)) return;
  main.dataset.panel = panel;
  for (const button of document.querySelectorAll('[data-action="panel"]')) button.setAttribute('aria-pressed', String(button.dataset.value === panel));
}

function renderActiveDiff(resetPage = true) {
  if (resetPage) diffPage = 0;
  const diffEl = document.getElementById('diff-content');
  if (!currentDiffFiles.length) { diffEl.innerHTML = '<span class="text-slate-500">// 无差异内容</span>'; return; }
  const text = currentFocusFile ? currentDiffFiles.find(file => file.path === currentFocusFile)?.patch || '' : currentDiffFiles.map(file => file.patch).join('\n\n');
  const total = text.split('\n').length;
  const perPage = 2000, pages = Math.ceil(total / perPage);
  diffPage = Math.max(0, Math.min(pages - 1, diffPage));
  const warnings = currentDiffWarnings.length ? `<div class="p-2 text-amber-300 text-xs">${currentDiffWarnings.map(escapeHtml).join('<br>')}</div>` : '';
  const navigation = pages > 1 ? `<div class="diff-pagination">
    <span>第 ${diffPage + 1} / ${pages} 页 · 共 ${total} 行 · 复制保留完整 Diff</span>
    <button data-action="diff-page" data-value="${diffPage - 1}" ${diffPage === 0 ? 'disabled' : ''}>上一页</button>
    <button data-action="diff-page" data-value="${diffPage + 1}" ${diffPage === pages - 1 ? 'disabled' : ''}>下一页</button>
  </div>` : '';
  diffEl.innerHTML = warnings + navigation + renderFormattedDiff(text, diffPage * perPage, perPage);
}

function renderFormattedDiff(rawDiff, start = 0, count = Infinity) {
  if (!rawDiff?.trim()) return '<span class="text-slate-500">// 无差异内容</span>';
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  const lines = rawDiff.split('\n'), output = [];
  for (let i = 0; i < Math.min(lines.length, start + count); i++) {
    const line = lines[i];
    let rowClass = 'text-slate-500', number = '···';
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      rowClass = 'diff-line-hunk'; number = '@@';
    } else if (line.startsWith('diff --git ')) {
      oldRemaining = newRemaining = 0; rowClass = 'text-indigo-400 font-bold mt-3 mb-1';
    } else if (oldRemaining || newRemaining) {
      if (line.startsWith('+')) { newRemaining--; rowClass = 'diff-line-add'; number = newLine++; }
      else if (line.startsWith('-')) { oldRemaining--; rowClass = 'diff-line-del'; number = oldLine++; }
      else if (line.startsWith(' ')) { oldRemaining--; newRemaining--; oldLine++; rowClass = ''; number = newLine++; }
    }
    if (i >= start) output.push(`<div class="diff-line ${rowClass}"><span class="diff-num">${number}</span><span class="diff-text">${escapeHtml(line)}</span></div>`);
  }
  return output.join('');
}

async function copyCurrentDiff() {
  const btn = document.getElementById('btn-copy-diff');
  let textToCopy = '';
  if (currentFocusFile) {
    const file = currentDiffFiles.find(f => f.path === currentFocusFile);
    textToCopy = file ? file.patch : '';
  } else {
    textToCopy = currentDiffFiles.map(f => f.patch).join('\n\n');
  }

  if (!textToCopy) {
    alert('当前没有可复制的代码差异');
    return;
  }

  try {
    await navigator.clipboard.writeText(textToCopy);
    if (btn) {
      btn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-emerald-400"></i> 已复制';
      lucide.createIcons();
      setTimeout(() => {
        btn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i> 复制Diff';
        lucide.createIcons();
      }, 2000);
    }
  } catch {
    alert('复制失败，请手动选择复制');
  }
}

// 4. 触发 Tech Mentor 深度分析 (P1 多轮记忆流式支持)
async function startMentorAnalysis(mode, customPrompt = '', resetSession = false) {
  if (!modelsReady) { alert('模型尚未就绪，请重试模型连接'); return; }
  if (!activeRepo) {
    alert('请先在左侧选择一个仓库项目！');
    return;
  }

  showPanel('mentor');
  if (resetSession) {
    clearMentorSession();
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }
  const controller = new AbortController();
  currentAbortController = controller;
  const requestId = ++mentorRequestSequence;
  const sessionVersion = mentorSessionVersion;
  const ownsRequest = () => requestId === mentorRequestSequence && sessionVersion === mentorSessionVersion;
  const isCurrent = () => ownsRequest() && !controller.signal.aborted;

  const emptyState = document.getElementById('mentor-empty-state');
  if (emptyState) emptyState.classList.add('hidden');

  const chatStream = document.getElementById('mentor-chat-stream');
  const statusBar = document.getElementById('mentor-status-bar');
  const statusText = document.getElementById('mentor-status-text');
  const modelSelect = document.getElementById('model-select');

  statusBar.classList.remove('hidden');
  statusText.textContent = '导师正在分析架构意图与代码实相...';

  // 如果是多轮提问，先在界面追加用户提问气泡
  if (!resetSession && customPrompt) {
    const userBubble = document.createElement('div');
    userBubble.className = 'flex justify-end';
    userBubble.innerHTML = `
      <div class="bg-[var(--bg-bubble-user)] border border-[var(--border-user-bubble)] rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-xl text-xs text-[var(--text-primary)] shadow-sm leading-relaxed">
        <div class="font-medium text-[var(--text-muted)] text-[11px] mb-1 flex items-center gap-1 justify-end">
          <span>你</span> <i data-lucide="user" class="w-3 h-3 text-[var(--text-muted)]"></i>
        </div>
        <div>${escapeHtml(customPrompt)}</div>
      </div>
    `;
    chatStream.appendChild(userBubble);
    lucide.createIcons();
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  // 创建导师回答气泡容器
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'flex justify-start';
  const bubbleId = `bubble-${sessionVersion}-${requestId}`;
  assistantBubble.innerHTML = `
    <div class="bg-[var(--bg-bubble-assistant)] border border-[var(--border-assistant-bubble)] rounded-2xl rounded-tl-sm p-5 max-w-none w-full shadow-sm">
      <div class="flex items-center justify-between pb-2 mb-3 border-b border-[var(--border-app)]">
        <span class="text-xs font-semibold text-[var(--accent-terracotta)] flex items-center gap-1.5 font-mono">
          <svg class="w-3.5 h-3.5 text-[var(--accent-terracotta)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
          </svg>
          Tech Mentor (${escapeHtml(modelSelect.options[modelSelect.selectedIndex]?.text?.split(' ')[0] || 'AI')})
          ${currentFocusFile ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-terracotta-bg)] text-[var(--accent-terracotta)] border border-[var(--accent-terracotta-border)]">聚焦: ${escapeHtml(currentFocusFile.split('/').pop())}</span>` : ''}
        </span>
        <span class="text-[10px] text-[var(--text-subtle)] font-mono">${new Date().toLocaleTimeString()}</span>
      </div>
      <article id="${bubbleId}" class="mentor-prose prose max-w-none text-[var(--text-primary)] text-sm leading-relaxed">
        <div class="text-[var(--text-muted)] animate-pulse text-xs">导师正在推演系统逻辑与代码流向...</div>
      </article>
      <div id="footer-${bubbleId}"></div>
    </div>
  `;
  chatStream.appendChild(assistantBubble);
  lucide.createIcons();
  chatStream.scrollTop = chatStream.scrollHeight;

  const article = document.getElementById(bubbleId);
  const footerEl = document.getElementById(`footer-${bubbleId}`);
  let currentTurnMarkdown = '';
  let currentTurnUsage = null;
  let finalized = false;
  let renderTimer = null;
  const flushArticle = () => {
    clearTimeout(renderTimer); renderTimer = null;
    if (!ownsRequest()) return;
    const atBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 100;
    article.innerHTML = renderMarkdown(currentTurnMarkdown);
    if (atBottom) chatStream.scrollTop = chatStream.scrollHeight;
  };

  const payload = {
    repoPath: activeRepo.path,
    target: mentorSnapshotId ? (mentorResolvedTarget || activeTarget) : activeTarget,
    mode,
    customPrompt,
    focusFile: currentFocusFile,
    model: modelSelect.value,
    history: conversationHistory,
    snapshotId: mentorSnapshotId
  };

  try {
    const response = await apiFetch('/api/mentor/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `服务响应异常: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (!isCurrent()) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let event;
          try { event = JSON.parse(line.slice(5).trim()); }
          catch { throw new Error('服务器返回无效的流式数据'); }
          if (!isCurrent()) return;
          if (event.type === 'snapshot') {
            mentorSnapshotId = event.snapshotId;
            mentorResolvedTarget = event.resolvedTarget;
          } else if (event.type === 'status') {
            statusText.textContent = event.message;
          } else if (event.type === 'chunk' && !finalized) {
            currentTurnMarkdown += event.text;
            renderTimer ||= setTimeout(flushArticle, 80);
          } else if (event.type === 'usage') {
            currentTurnUsage = event.usage;
          } else if (event.type === 'error') {
            throw new Error(event.message || '分析失败');
          } else if ((event.type === 'finished' || event.type === 'done') && !finalized) {
            finalized = true;
            flushArticle();
            await postProcessArticle(article);
            if (!isCurrent()) return;
            if (mentorResolvedTarget) {
              const evidenceNotice = document.createElement('p');
              evidenceNotice.className = 'text-[10px] text-slate-500 mt-2';
              evidenceNotice.textContent = `分析快照: ${mentorResolvedTarget === 'working-tree' ? '首次读取的工作区' : mentorResolvedTarget} · 追问保留首次证据`;
              footerEl.appendChild(evidenceNotice);
            }
            if (currentTurnUsage) {
              const numeric = key => Math.max(0, Number(currentTurnUsage[key]) || 0);
              const usage = document.createElement('div');
              usage.className = 'mt-4 pt-3 border-t border-slate-800 text-xs text-slate-500';
              usage.textContent = `本次分析: ${numeric('total_tokens')} tokens (输入: ${numeric('prompt_tokens')}, 输出: ${numeric('completion_tokens')})`;
              footerEl.appendChild(usage);
            }
            if (customPrompt) conversationHistory.push({ role: 'user', content: customPrompt });
            conversationHistory.push({ role: 'assistant', content: currentTurnMarkdown });
            if (footerEl) renderQuickChips(footerEl);
            loadKeeperStats();
            statusBar.classList.add('hidden');
            saveCurrentRepoSession();
          }
        }
      }
      if (!finalized) throw new Error('回答流意外中断，未保存到对话历史');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (err) {
    if (!ownsRequest()) return;
    flushArticle();
    if (!currentTurnMarkdown) article.innerHTML = '';
    if (controller.signal.aborted) {
      const notice = document.createElement('p');
      notice.className = 'text-slate-500 text-xs mt-2';
      notice.textContent = '已终止生成，未保存未完成的回答';
      article.appendChild(notice);
    } else {
      const notice = document.createElement('p');
      notice.className = 'text-rose-400 text-xs mt-2';
      notice.textContent = `分析失败: ${err.message}`;
      article.appendChild(notice);
    }
  } finally {
    clearTimeout(renderTimer);
    if (currentAbortController === controller) {
      currentAbortController = null;
      statusBar.classList.add('hidden');
    }
  }
}

// 快速追问胶囊生成
function renderQuickChips(container) {
  const chipsWrapper = document.createElement('div');
  chipsWrapper.className = 'mt-5 pt-3.5 border-t border-[var(--border-app)] flex flex-wrap items-center gap-2 text-xs';
  chipsWrapper.innerHTML = `
    <span class="text-[var(--text-subtle)] text-[10px] mr-1 flex items-center gap-1 font-mono">
      <i data-lucide="sparkles" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> 快速追问:
    </span>
    <button class="quick-chip" data-action="ask" data-value="请深度展开刚才提出的苏格拉底考题，给出详细推演思路与参考答案">
      <i data-lucide="chevron-right" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> 展开自测考题推演与答案
    </button>
    <button class="quick-chip" data-action="ask" data-value="针对本次分析指出的隐蔽暗桩，请给出具体的防御性重构代码">
      <i data-lucide="chevron-right" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> 针对隐蔽暗桩给出防御代码
    </button>
    <button class="quick-chip" data-action="ask" data-value="请使用 Mermaid sequenceDiagram 时序图画出最核心的调用链路与异常分支">
      <i data-lucide="chevron-right" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> 绘制核心时序图 (Mermaid)
    </button>
    <button class="quick-chip" data-action="ask" data-value="如果在高并发和极端边缘场景下运行，这段代码有什么潜在瓶颈？">
      <i data-lucide="chevron-right" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> 高并发与极端场景瓶颈
    </button>
  `;
  container.appendChild(chipsWrapper);
  lucide.createIcons();
}

window.quickAsk = (prompt) => {
  const input = document.getElementById('mentor-input');
  if (input) {
    input.value = prompt;
    startMentorAnalysis('custom', prompt, false);
    input.value = '';
  }
};

function stopMentorAnalysis() {
  if (currentAbortController) {
    currentAbortController.abort();
  }
}

function clearMentorSession() {
  mentorSessionVersion++;
  currentAbortController?.abort();
  currentAbortController = null;
  document.getElementById('mentor-status-bar').classList.add('hidden');
  conversationHistory = [];
  mentorSnapshotId = null;
  mentorResolvedTarget = null;
  const chatStream = document.getElementById('mentor-chat-stream');
  chatStream.innerHTML = `
    <div id="mentor-empty-state" class="h-full flex flex-col items-center justify-center text-center p-8 text-[var(--text-muted)]">
      <div class="w-12 h-12 rounded-2xl bg-[var(--btn-action-bg)] border border-[var(--border-app)] flex items-center justify-center mb-3 text-[var(--accent-terracotta)]">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
        </svg>
      </div>
      <h3 class="text-sm font-semibold text-[var(--text-primary)]">专属技术导师就绪</h3>
      <p class="text-xs text-[var(--text-muted)] max-w-sm mt-1 leading-relaxed">
        已挂载项目事实源与防噪音过滤。点击上方【快捷精读】或在下方提问。导师将结合系统全局约束深度带读，并支持连续多轮追问。
      </p>
    </div>
  `;
  lucide.createIcons();
}

// 复制整轮精读笔记为 Markdown
async function copyMentorNotes() {
  if (conversationHistory.length === 0) {
    alert('暂无精读笔记可复制');
    return;
  }

  let fullMarkdown = `# 🧭 Tech Mentor 精读笔记: ${activeRepo ? activeRepo.name : ''}\n\n`;
  fullMarkdown += `> 目标: ${mentorResolvedTarget || activeTarget} | 时间: ${new Date().toLocaleString()}\n\n`;

  conversationHistory.forEach((item, idx) => {
    if (item.role === 'user') {
      fullMarkdown += `### 💬 追问 ${Math.ceil((idx + 1) / 2)}:\n${item.content}\n\n`;
    } else {
      fullMarkdown += `### 🧠 导师解答:\n${item.content}\n\n---\n\n`;
    }
  });

  try {
    await navigator.clipboard.writeText(fullMarkdown);
    const copyBtn = document.getElementById('btn-copy-mentor');
    copyBtn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-400"></i> 已复制!';
    lucide.createIcons();
    setTimeout(() => {
      copyBtn.innerHTML = '<i data-lucide="copy" class="w-3.5 h-3.5"></i> 复制笔记';
      lucide.createIcons();
    }, 2000);
  } catch (err) {
    alert('复制失败，请手动选择复制');
  }
}

// 导出整轮精读笔记为本地 .md 文件
function exportMentorMarkdown() {
  if (conversationHistory.length === 0) {
    alert('暂无精读笔记可导出，请先执行一次技术带读');
    return;
  }
  const repoName = activeRepo ? activeRepo.name : 'repo';
  const targetTag = (mentorResolvedTarget || activeTarget).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const fileName = `tech-mentor-${repoName}-${targetTag}.md`;

  let fullMarkdown = `# 🧭 Tech Mentor 深度精读笔记: ${repoName}\n\n`;
  fullMarkdown += `> **代码目标**: \`${mentorResolvedTarget || activeTarget}\` | **导出时间**: ${new Date().toLocaleString()} | **仓库路径**: \`${activeRepo?.path || ''}\`\n\n`;
  fullMarkdown += `---\n\n`;

  conversationHistory.forEach((item, idx) => {
    if (item.role === 'user') {
      fullMarkdown += `## 💬 提问 / 追问 ${Math.ceil((idx + 1) / 2)}\n\n${item.content}\n\n`;
    } else {
      fullMarkdown += `## 🧠 导师带读与架构剖析\n\n${item.content}\n\n---\n\n`;
    }
  });

  const blob = new Blob([fullMarkdown], { type: 'text/markdown;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 后置渲染美化：代码块复制按钮与 Mermaid 渲染
async function postProcessArticle(article) {
  // 1. Highlight.js 代码高亮
  article.querySelectorAll('pre code').forEach((block) => {
    if (!block.classList.contains('language-mermaid')) {
      hljs.highlightElement(block);
    }
  });

  // 2. 为每个代码块增加头部栏与一键复制功能
  article.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-block-wrapper')) return;
    const code = pre.querySelector('code');
    if (!code || code.classList.contains('language-mermaid')) return;

    let lang = 'code';
    for (const cls of code.classList) {
      if (cls.startsWith('language-')) {
        lang = cls.replace('language-', '');
        break;
      }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.innerHTML = `
      <span class="text-slate-400 uppercase font-mono">${escapeHtml(lang)}</span>
      <button class="copy-code-btn text-slate-400 hover:text-slate-100 flex items-center gap-1 transition text-[10px]">
        <i data-lucide="copy" class="w-3 h-3"></i> 复制代码
      </button>
    `;

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);

    const copyBtn = header.querySelector('.copy-code-btn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.innerText);
        copyBtn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-emerald-400"></i> 已复制';
        lucide.createIcons();
        setTimeout(() => {
          copyBtn.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i> 复制代码';
          lucide.createIcons();
        }, 2000);
      } catch {}
    });
  });

  // 3. 渲染 Mermaid 图表
  const mermaidBlocks = article.querySelectorAll('pre code.language-mermaid');
  if (mermaidBlocks.length > 0 && window.mermaid) {
    for (let i = 0; i < mermaidBlocks.length; i++) {
      const block = mermaidBlocks[i];
      const code = block.textContent;
      const pre = block.parentElement;
      const container = document.createElement('div');
      container.className = 'mermaid my-4 p-4 bg-slate-900 rounded-lg border border-slate-800 flex justify-center';
      container.textContent = code;
      pre.replaceWith(container);
    }
    try {
      await mermaid.run({ nodes: Array.from(article.querySelectorAll('.mermaid')) });
    } catch (e) {
      console.warn('Mermaid render error:', e);
    }
  }

  lucide.createIcons();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
