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
let currentFocusFile = null; // Diff 面板正在查看的文件，null 表示全部文件
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
let mentorRequestedTarget = null;
// What the conversation is about ({ file: null } = all files). It is fixed when
// the conversation starts; viewing other files in the diff does not change it.
let mentorScope = null;
// Conversations are kept per repository and target, so browsing to another
// commit and back finds the discussion where it was left.
const mentorSessions = new Map();
const MAX_SAVED_SESSIONS = 30;
const lastRepoView = new Map(); // repo id -> { target, viewFile }
const sessionKey = (repoId, target) => `${repoId}\n${target}`;
let pendingUndo = null;
let undoTimer = null;
const DIFF_PAGE_SIZE = 2000;

// Instructions for these actions live on the server (lib/mentor.js MODES); the
// labels only name the user's turn in the conversation.
const ACTION_LABELS = {
  walkthrough: '全景架构带读',
  anatomy: '核心代码实相',
  pitfalls: '隐蔽暗桩考查',
  drill: '苏格拉底考题'
};
// The server only gives the model this much history (HISTORY_BUDGET in
// lib/mentor.js). Send just that tail; the full history stays here for export.
const HISTORY_BUDGET = 24000;

function historyForRequest(history) {
  const groups = [];
  for (let i = 0; i < history.length;) {
    if (history[i].role === 'assistant') groups.push([history[i++]]);
    else groups.push([history[i++], history[i++]]);
  }
  let used = 0; const kept = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const size = groups[i].reduce((sum, turn) => sum + turn.content.length, 0);
    if (used + size > HISTORY_BUDGET) break;
    kept.unshift(...groups[i]); used += size;
  }
  return kept;
}

function captureSession() {
  const chatStream = document.getElementById('mentor-chat-stream');
  let chatHtml = chatStream ? chatStream.innerHTML : null;
  if (chatStream?.cloneNode) {
    // A turn still streaming is not part of the saved conversation.
    const copy = chatStream.cloneNode(true);
    copy.querySelectorAll('.pending-turn').forEach(node => node.remove());
    chatHtml = copy.innerHTML;
  }
  return {
    conversationHistory: [...conversationHistory],
    mentorSnapshotId,
    mentorResolvedTarget,
    mentorRequestedTarget,
    scopeFile: mentorScope ? mentorScope.file : null,
    chatHtml
  };
}

function saveCurrentSession() {
  if (!activeRepo) return;
  lastRepoView.set(activeRepo.id, { target: activeTarget, viewFile: currentFocusFile });
  if (!conversationHistory.length) return;
  const key = sessionKey(activeRepo.id, activeTarget);
  mentorSessions.delete(key);
  mentorSessions.set(key, captureSession());
  while (mentorSessions.size > MAX_SAVED_SESSIONS) mentorSessions.delete(mentorSessions.keys().next().value);
}

function restoreSession(saved) {
  if (!saved?.conversationHistory?.length) return false;
  currentAbortController?.abort();
  currentAbortController = null;
  document.getElementById('mentor-status-bar')?.classList.add('hidden');
  mentorSessionVersion++;
  hideMentorNotice();
  conversationHistory = [...saved.conversationHistory];
  mentorSnapshotId = saved.mentorSnapshotId;
  mentorResolvedTarget = saved.mentorResolvedTarget;
  mentorRequestedTarget = saved.mentorRequestedTarget || null;
  mentorScope = { file: saved.scopeFile ?? null };
  const chatStream = document.getElementById('mentor-chat-stream');
  if (chatStream && saved.chatHtml) {
    chatStream.innerHTML = saved.chatHtml;
    lucide.createIcons();
    redrawMermaid(chatStream);
  }
  renderMentorScope();
  return true;
}

// Ends the conversation for the current target. A user-initiated clear can be
// undone for a few seconds, so one mis-click never costs a study session.
function clearCurrentMentorSession({ undoable = true, notice = '已清空对话' } = {}) {
  const saved = undoable && conversationHistory.length ? captureSession() : null;
  const key = activeRepo ? sessionKey(activeRepo.id, activeTarget) : null;
  if (key) mentorSessions.delete(key);
  clearMentorSession();
  if (saved && key) showMentorNotice(notice, { key, saved });
  else if (!undoable && notice) showMentorNotice(notice);
}

function showMentorNotice(message, undo = null) {
  pendingUndo = undo;
  const text = document.getElementById('mentor-undo-text');
  if (text) text.textContent = message;
  const undoButton = document.getElementById('btn-undo-clear');
  if (undo) undoButton?.classList.remove('hidden');
  else undoButton?.classList.add('hidden');
  document.getElementById('mentor-undo-bar')?.classList.remove('hidden');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideMentorNotice, 10000);
  undoTimer?.unref?.();
}

function hideMentorNotice() {
  pendingUndo = null;
  clearTimeout(undoTimer);
  document.getElementById('mentor-undo-bar')?.classList.add('hidden');
}

function undoClearMentorSession() {
  const pending = pendingUndo;
  hideMentorNotice();
  if (!pending || !activeRepo || pending.key !== sessionKey(activeRepo.id, activeTarget) || conversationHistory.length) return;
  restoreSession(pending.saved);
  saveCurrentSession();
}

// Keeps "what I am looking at" and "what the mentor is discussing" visibly
// separate; changing the discussion is always an explicit action.
function renderMentorScope() {
  const text = document.getElementById('mentor-scope-text');
  const button = document.getElementById('btn-scope-new');
  if (!text || !button) return;
  const name = file => file ? file.split('/').pop() : '全部文件';
  const active = mentorScope && (conversationHistory.length > 0 || currentAbortController);
  const shown = active ? mentorScope.file : currentFocusFile;
  text.textContent = `${active ? '讨论范围' : '新对话将针对'}：${name(shown)}`;
  text.title = shown || '本次改动的全部文件';
  if (active && currentFocusFile !== mentorScope.file) {
    button.textContent = `针对${currentFocusFile ? ` ${name(currentFocusFile)} ` : '全部文件'}新开对话`;
    button.title = '结束当前对话（可撤销），下一次提问针对正在查看的内容';
    button.classList.remove('hidden');
  } else {
    button.classList.add('hidden');
  }
}

// Starts a new analysis when there is no usable snapshot for the current
// selection; otherwise the action becomes a follow-up on the same evidence.
async function triggerMentorAction(mode) {
  // Each action picks its natural scope first, and the diff is loaded before the
  // request so file references in the answer resolve against it.
  if (mode === 'walkthrough' && activeTarget !== 'project' && activeRepo) {
    await selectTarget('project');
  } else if (mode !== 'walkthrough' && activeTarget === 'project' && activeRepo) {
    await selectTarget(currentCommits[0]?.hash || 'working-tree');
  }
  return startMentorAnalysis(mode, '', false);
}

let localSessionPromise;
async function apiFetch(url, options = {}, retried = false) {
  const sessionPromise = localSessionPromise ||= fetch('/api/session', { credentials: 'same-origin' }).then(async response => {
    if (!response.ok) throw new Error('本机会话初始化失败，请刷新页面');
    return (await response.json()).token;
  }).catch(error => { localSessionPromise = null; throw error; });
  const token = await sessionPromise;
  options.signal?.throwIfAborted();
  const headers = { ...options.headers, 'X-Local-Token': token };
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  // A restarted service issues a new token. 401 is returned before any work is
  // done, so fetching a fresh token and retrying once is safe for every route.
  if (response.status === 401 && !retried) {
    await response.body?.cancel().catch(() => {});
    if (localSessionPromise === sessionPromise) localSessionPromise = null;
    return apiFetch(url, options, true);
  }
  return response;
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style', 'id', 'name'] });
}

// Where the finished part of a streaming answer ends, searching from `from`:
// the start of the last line that follows a blank line, begins without
// indentation and lies outside a code fence. Everything before it is complete
// top-level blocks; later text cannot change how they render, except in rare
// cases (loose lists, later link definitions) that the final render corrects.
function stableMarkdownSplit(text, from = 0) {
  const lines = text.slice(from).split('\n');
  let offset = from, fence = null, previousBlank = true, split = from;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      // Only a complete line can close the fence; the last line may be partial.
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && i < lines.length - 1 && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      if (offset > from && previousBlank && /^\S/.test(line)) split = offset;
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) fence = open[1];
    }
    previousBlank = !fence && line.trim() === '';
    offset += line.length + 1;
  }
  return split;
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
    redrawMermaid();
  }
}

function toggleTheme() {
  const currentIsDark = document.documentElement.classList.contains('dark');
  applyTheme(currentIsDark ? 'light' : 'dark');
}

// 中栏与导师栏之间的分隔条。宽度写进 --diff-panel-width；没拖过时不写，
// 让媒体查询决定默认值，窄屏切到单栏 Tab 模式时分隔条隐藏。
const SPLITTER_KEY = 'mentor-diff-width';
const DIFF_MIN_WIDTH = 320, MENTOR_MIN_WIDTH = 420;

function clampDiffWidth(value, workspaceWidth, reposWidth) {
  const max = Math.max(DIFF_MIN_WIDTH, workspaceWidth - reposWidth - MENTOR_MIN_WIDTH);
  return Math.min(Math.max(DIFF_MIN_WIDTH, Math.round(value)), max);
}

function initPanelSplitter() {
  const splitter = document.getElementById('panel-splitter');
  const workspace = document.getElementById('workspace');
  const diffPanel = document.getElementById('diff-panel');
  if (!splitter || !workspace || !diffPanel) return;

  const reposWidth = () => document.getElementById('repos-panel')?.getBoundingClientRect().width || 0;
  const renderedWidth = () => diffPanel.getBoundingClientRect().width;
  // The splitter itself takes layout space; the mentor panel needs the rest.
  const available = () => workspace.clientWidth - splitter.getBoundingClientRect().width;
  const maxWidth = () => Math.max(DIFF_MIN_WIDTH, available() - reposWidth() - MENTOR_MIN_WIDTH);
  const apply = width => document.documentElement.style.setProperty('--diff-panel-width', `${width}px`);
  const syncAria = () => {
    splitter.setAttribute('aria-valuenow', String(Math.round(renderedWidth())));
    splitter.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
  };

  // The width the user asked for; null means "follow the media query".
  let desired = null;
  try {
    const stored = Number(localStorage.getItem(SPLITTER_KEY));
    if (Number.isFinite(stored) && stored > 0) desired = stored;
  } catch {}

  const render = () => {
    if (desired === null) document.documentElement.style.removeProperty('--diff-panel-width');
    else apply(clampDiffWidth(desired, available(), reposWidth()));
    syncAria();
  };
  const persist = () => {
    try {
      if (desired === null) localStorage.removeItem(SPLITTER_KEY);
      else localStorage.setItem(SPLITTER_KEY, String(Math.round(desired)));
    } catch {}
  };
  // Store what the user can actually see: a drag past the limit keeps the limit,
  // while a window resize re-clamps at render time without overwriting it.
  const setDesired = width => { desired = clampDiffWidth(width, available(), reposWidth()); render(); };

  let drag = null;
  splitter.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: renderedWidth() };
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDesired(drag.startWidth + (event.clientX - drag.startX));
  });
  const endDrag = event => {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    drag = null;
    document.body.classList.remove('resizing');
    persist();
    syncAria();
  };
  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);

  // Double-click goes back to the responsive default.
  splitter.addEventListener('dblclick', () => { desired = null; render(); persist(); });
  splitter.addEventListener('keydown', event => {
    const step = event.shiftKey ? 64 : 16;
    const current = renderedWidth();
    let next = null;
    if (event.key === 'ArrowLeft') next = current - step;
    else if (event.key === 'ArrowRight') next = current + step;
    else if (event.key === 'Home') next = DIFF_MIN_WIDTH;
    else if (event.key === 'End') next = maxWidth();
    if (next === null) return;
    event.preventDefault();
    setDesired(next);
    persist();
  });

  // Re-clamp against the new viewport instead of overwriting the preference, so
  // widening the window again restores the width the user chose.
  window.addEventListener('resize', render);
  render();
}

const mermaidTheme = () => document.documentElement.classList.contains('dark') ? 'dark' : 'neutral';

// Mermaid is about 3.4 MB; load it the first time an answer contains a diagram.
let mermaidLoading = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve();
  mermaidLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/mermaid.js';
    script.onload = () => {
      mermaid.initialize({ startOnLoad: false, theme: mermaidTheme(), securityLevel: 'strict' });
      resolve();
    };
    script.onerror = () => { mermaidLoading = null; reject(new Error('Mermaid 加载失败')); };
    document.head.appendChild(script);
  });
  return mermaidLoading;
}

// Mermaid's flowchart parser rejects `(` in an unquoted label, so an answer
// containing `B[getUser()]` or `A[调用 (v2)]` renders as "Syntax error in text".
// Quoting such a label makes it valid. Shapes with their own meaning
// (`[(db)]`, `[[x]]`, `{{x}}`) and labels that are already quoted are untouched,
// and only flowchart/graph sources are rewritten.
function repairMermaid(source) {
  if (!/^\s*(flowchart|graph)\b/.test(source)) return source;
  const needsQuotes = text => !text.includes('"') && /[()]/.test(text);
  const fixLine = (line, open, close) => {
    let out = '', i = 0;
    while (i < line.length) {
      if (line[i] !== open) { out += line[i++]; continue; }
      // `[(`, `[[` open a different node shape, not a plain label.
      if (open === '[' && (line[i + 1] === '(' || line[i + 1] === '[')) { out += line[i++]; continue; }
      const end = line.indexOf(close, i + 1);
      if (end === -1) { out += line[i++]; continue; }
      const label = line.slice(i + 1, end);
      out += needsQuotes(label) ? `${open}"${label.trim()}"${close}` : line.slice(i, end + 1);
      i = end + 1;
    }
    return out;
  };
  return source.split('\n').map(line => fixLine(fixLine(line, '|', '|'), '[', ']')).join('\n');
}

// Mermaid draws its own "Syntax error in text" card into the container and
// throws, so diagrams are rendered one at a time: a diagram that still fails
// after repair is replaced by its source instead of that card.
async function renderDiagram(node) {
  const source = node.dataset.mermaidSource;
  const repaired = repairMermaid(source);
  for (const candidate of repaired === source ? [source] : [source, repaired]) {
    node.removeAttribute('data-processed');
    node.textContent = candidate;
    try {
      await mermaid.run({ nodes: [node] });
      if (!node.querySelector('.error-text')) { node.dataset.mermaidSource = candidate; return true; }
    } catch (error) {
      node.dataset.mermaidError = String(error?.message || error).slice(0, 300);
    }
  }
  showDiagramFallback(node, source);
  return false;
}

// Same shape as a code block, so the existing copy delegation works and the
// diagram source stays readable and copyable.
function showDiagramFallback(node, source) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block-wrapper mermaid-fallback';
  const header = document.createElement('div');
  header.className = 'code-block-header';
  const title = document.createElement('span');
  title.className = 'text-[var(--text-muted)] uppercase font-mono';
  title.textContent = 'mermaid 未渲染';
  const hint = document.createElement('span');
  hint.className = 'mermaid-fallback-hint';
  hint.textContent = '标签含括号需加引号 · 节点 id 不能用 end · erDiagram 实体名用英文';
  const button = document.createElement('button');
  button.className = 'copy-code-btn text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 transition text-[10px]';
  button.innerHTML = '<i data-lucide="copy" class="w-3 h-3"></i> 复制源码';
  header.append(title, hint, button);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  wrapper.append(header, pre);
  node.replaceWith(wrapper);
}

// A diagram keeps the colors of the theme it was drawn in. Redraw the ones
// drawn in another theme from the source kept on their container.
async function redrawMermaid(root = document) {
  if (!window.mermaid) return;
  const theme = mermaidTheme();
  const nodes = Array.from(root.querySelectorAll('.mermaid[data-mermaid-source]')).filter(node => node.dataset.mermaidTheme !== theme);
  for (const node of nodes) {
    node.dataset.mermaidTheme = theme;
    await renderDiagram(node);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initPanelSplitter();
  marked.setOptions({ gfm: true, breaks: true });

  lucide.createIcons();
  setupEventListeners();
  loadModels();
  loadRepos();
  loadKeeperStats();
  startKeeperPolling();
});

// Keeper usage only matters while the page is visible: a hidden tab stops
// polling (each poll runs two sqlite3 queries) and refreshes once on return.
let keeperTimer = null;
function startKeeperPolling() {
  const sync = () => {
    clearInterval(keeperTimer); keeperTimer = null;
    if (document.visibilityState !== 'hidden') keeperTimer = setInterval(loadKeeperStats, 15000);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') loadKeeperStats();
    sync();
  });
  sync();
}

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
    if (stats.claude && stats.claude.tokens > 0) {
      parts.push(`Claude: ${formatK(stats.claude.tokens)}`);
    }

    const primaryLimit = (rateLimits || []).find(r => r.label === '5h');
    if (primaryLimit) {
      const remaining = primaryLimit.remainingPercent;
      const color = remaining === null ? 'text-[var(--text-muted)]' : remaining > 30 ? 'text-[var(--diff-add-text)]' : (remaining > 10 ? 'text-[var(--accent-terracotta)]' : 'text-[var(--diff-del-text)]');
      parts.push(`<span class="${color}">5h: ${remaining === null ? '等待更新' : `${remaining}%`}</span>`);
    }

    textEl.innerHTML = parts.length > 0 ? parts.join(' · ') : '暂无今日计量';

    if (popoverContent) {
      let limitsHtml = (rateLimits || []).map(r => `
        <div class="space-y-1 bg-[var(--bg-card)] p-2.5 rounded-lg border border-[var(--border-app)]">
          <div class="flex justify-between items-center text-[11px]">
            <span class="font-medium text-[var(--text-primary)]">Codex ${escapeHtml(r.label)} 速率窗口</span>
            <span class="font-mono ${r.remainingPercent === null ? 'text-[var(--text-muted)]' : r.remainingPercent > 30 ? 'text-[var(--diff-add-text)]' : 'text-[var(--accent-terracotta)]'}">${r.remainingPercent === null ? '等待更新 / 未知' : `剩余 ${r.remainingPercent}%`}</span>
          </div>
          <div class="w-full bg-[var(--progress-track)] h-1.5 rounded-full overflow-hidden">
            <div class="h-full rounded-full ${r.remainingPercent === null ? 'bg-[var(--text-subtle)]' : r.remainingPercent > 30 ? 'bg-[var(--diff-add-text)]' : 'bg-[var(--accent-terracotta)]'}" style="width: ${Number(r.remainingPercent) || 0}%"></div>
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
          <div class="col-span-2 bg-[var(--bg-card)] p-2.5 rounded-lg border border-[var(--border-app)]">
            <div class="text-[var(--text-muted)] text-[10px]">今日 Claude</div>
            <div class="font-mono font-semibold text-[var(--text-primary)] text-xs mt-0.5">${formatK(stats.claude?.tokens || 0)} tokens</div>
            <div class="text-[10px] text-[var(--text-subtle)]">${stats.claude?.requests || 0} 次请求</div>
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
  const focused = focusedRow(container);
  container.innerHTML = presets.map(p => `
    <button type="button" data-action="target" data-value="${escapeHtml(p.hash)}" aria-pressed="${activeTarget === p.hash}"
            class="px-2 py-0.5 rounded text-[10px] font-mono transition border ${
              activeTarget === p.hash
                ? 'bg-[var(--accent-terracotta)] border-[var(--accent-terracotta)] text-[#ffffff] font-semibold'
                : 'bg-[var(--btn-action-bg)] border-[var(--border-app)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--btn-action-hover)]'
            }" title="${escapeHtml(p.msg)}">
      ${escapeHtml(p.shortHash)}
    </button>
  `).join('');
  restoreFocus(container, focused);
}

// Lists are re-rendered with innerHTML, which drops keyboard focus; these keep
// it on the row or chip with the same action and value.
function focusedRow(container) {
  const active = document.activeElement;
  if (!active?.dataset?.action || typeof container.contains !== 'function' || !container.contains(active)) return null;
  return { action: active.dataset.action, value: active.dataset.value };
}

function restoreFocus(container, focused) {
  if (!focused) return;
  const match = [...container.querySelectorAll('[data-action]')]
    .find(element => element.dataset.action === focused.action && element.dataset.value === focused.value);
  match?.focus();
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

    // Only trusted code creates these: sanitized answers cannot carry buttons or
    // data attributes, and the target file must be in the current diff.
    const codeRef = event.target.closest('.mentor-prose .code-ref');
    if (codeRef) {
      revealDiffLine(codeRef.dataset.refFile, Number(codeRef.dataset.refLine), Number(codeRef.dataset.refEnd) || null);
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
  // Repository and commit rows are divs with role="button"; Enter and Space
  // activate them the way they would a native button.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target;
    if (!row?.matches?.('[data-action][role="button"]')) return;
    event.preventDefault();
    row.click();
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
    const setKeeperOpen = open => {
      keeperPopover.classList.toggle('hidden', !open);
      keeperPill.setAttribute('aria-expanded', String(open));
    };
    keeperPill.addEventListener('click', (e) => {
      e.stopPropagation();
      setKeeperOpen(keeperPopover.classList.contains('hidden'));
    });
    document.addEventListener('click', (e) => {
      if (!keeperPopover.contains(e.target) && !keeperPill.contains(e.target)) setKeeperOpen(false);
    });
    // Escape closes the details; focus returns to the pill only if it was there or inside.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || keeperPopover.classList.contains('hidden')) return;
      const inside = document.activeElement === keeperPill || keeperPopover.contains(document.activeElement);
      setKeeperOpen(false);
      if (inside) keeperPill.focus();
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
      resizePromptInput();
    }
  });
  // Enter 发送，Shift+Enter 换行；输入法选词时的 Enter 不发送
  const promptInput = document.getElementById('mentor-input');
  promptInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    document.getElementById('mentor-form').requestSubmit();
  });
  promptInput.addEventListener('input', resizePromptInput);

  document.getElementById('btn-stop-analyze').addEventListener('click', stopMentorAnalysis);

  // 清空多轮对话（可撤销）；新开对话结束当前讨论，改为针对正在查看的内容
  document.getElementById('btn-clear-mentor').addEventListener('click', () => clearCurrentMentorSession());
  document.getElementById('btn-scope-new').addEventListener('click', () => clearCurrentMentorSession({ notice: '已结束上一段对话' }));
  document.getElementById('btn-undo-clear').addEventListener('click', undoClearMentorSession);

  // 在 Diff 中选中代码后浮出“就选中代码提问”
  const askSelection = document.getElementById('btn-ask-selection');
  askSelection.addEventListener('mousedown', event => event.preventDefault());
  askSelection.addEventListener('click', askAboutSelection);
  document.addEventListener('selectionchange', updateAskSelection);
  document.addEventListener('scroll', updateAskSelection, true);

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
  listEl.innerHTML = '<div class="text-xs text-[var(--text-muted)] text-center py-8">正在扫描本地 Git 仓库...</div>';

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
    if (sequence === reposLoadSequence) listEl.innerHTML = `<div class="text-xs text-[var(--diff-del-text)] text-center py-6">加载仓库失败: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (sequence === reposLoadSequence) refreshButton.disabled = false;
  }
}

function renderRepoList(repos) {
  const listEl = document.getElementById('repo-list');
  if (repos.length === 0) {
    listEl.innerHTML = '<div class="text-xs text-[var(--text-muted)] text-center py-6">未发现 Git 仓库</div>';
    return;
  }

  const focused = focusedRow(listEl);
  listEl.innerHTML = repos.map(repo => {
    const isSelected = activeRepo && activeRepo.id === repo.id;
    const hasDirty = repo.dirtyCount > 0;

    return `
      <div data-action="repo" data-value="${escapeHtml(repo.id)}" role="button" tabindex="0" aria-current="${isSelected ? 'true' : 'false'}"
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
  restoreFocus(listEl, focused);
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

function isKnownTarget(target, data) {
  if (typeof target !== 'string' || !target) return false;
  if (target === 'working-tree' || target === 'project') return true;
  if ((data.commits || []).some(commit => commit.hash === target)) return true;
  if ((data.presets || []).some(preset => preset.hash === target)) return true;
  return /^[0-9a-f]{40}$/.test(target);
}

// 2. 选择仓库并加载提交记录
async function selectRepo(repo) {
  saveCurrentSession();
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
  clearMentorSession();
  handleRepoFilter({ target: document.getElementById('repo-search') });

  document.getElementById('active-repo-name').textContent = repo.name;
  document.getElementById('active-repo-path').textContent = repo.path;
  const branchBadge = document.getElementById('active-repo-branch');
  branchBadge.textContent = repo.branch;
  branchBadge.classList.remove('hidden');

  const commitListEl = document.getElementById('commit-list');
  commitListEl.innerHTML = '<div class="text-xs text-[var(--text-muted)] text-center py-6">正在读取变动记录...</div>';

  try {
    const res = await apiFetch(`/api/repos/${repo.id}/commits`, { signal: controller.signal });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (sequence !== repoRequestSequence || activeRepo?.id !== repo.id) return;
    currentPresets = data.presets || [];
    currentCommits = data.commits;

    const defaultTarget = data.commits.length === 0 ? 'working-tree'
      : data.dirtyCount === 0
        ? (data.commits.find(commit => !commit.isWorkingTree)?.hash || data.commits[0].hash)
        : data.commits[0].hash;
    const view = lastRepoView.get(repo.id);
    let target = defaultTarget;
    let viewFile = null;
    if (view?.target && isKnownTarget(view.target, data)) {
      target = view.target;
      viewFile = view.viewFile || null;
    }

    activeTarget = target;
    currentFocusFile = viewFile;
    restoreSession(mentorSessions.get(sessionKey(repo.id, target)));
    renderCommitPresets(currentPresets);
    renderCommitList(currentCommits);
    fetchDiff(repo.id, target);
  } catch (err) {
    if (sequence !== repoRequestSequence || err.name === 'AbortError') return;
    commitListEl.innerHTML = `<div class="text-xs text-[var(--diff-del-text)] text-center py-4">读取提交失败: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCommitList(commits) {
  const commitListEl = document.getElementById('commit-list');
  if (commits.length === 0) {
    commitListEl.innerHTML = '<div class="text-xs text-[var(--text-muted)] text-center py-6">暂无提交记录</div>';
    return;
  }

  const focused = focusedRow(commitListEl);
  // The whole project is a first-class scope: it is what a walkthrough reads.
  const projectRow = `
      <div data-action="target" data-value="project" role="button" tabindex="0" aria-current="${activeTarget === 'project' ? 'true' : 'false'}"
           class="p-2 px-3 cursor-pointer transition flex items-center justify-between border-l-2 ${
             activeTarget === 'project'
               ? 'bg-[var(--bg-surface-hover)] border-[var(--accent-terracotta)] text-[var(--text-primary)] font-medium'
               : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]'
           }">
        <div class="truncate mr-2">
          <div class="text-xs truncate flex items-center gap-1.5">
            <i data-lucide="layers" class="w-3 h-3 text-[var(--accent-terracotta)] shrink-0"></i>
            整个项目（架构 / 技术栈 / 数据链路）
          </div>
          <div class="text-[10px] text-[var(--text-subtle)] mt-0.5 font-mono">
            <span>全量清单</span> · <span>依赖图</span> · <span>HTTP 端点</span>
          </div>
        </div>
        <span class="text-[10px] font-mono shrink-0 px-1.5 py-0.2 rounded bg-[var(--btn-action-bg)] border border-[var(--border-app)] text-[var(--text-muted)]">
          PROJECT
        </span>
      </div>`;
  commitListEl.innerHTML = projectRow + commits.map(c => {
    const isSelected = activeTarget === c.hash;
    const isWorkingTree = c.isWorkingTree;

    return `
      <div data-action="target" data-value="${escapeHtml(c.hash)}" role="button" tabindex="0" aria-current="${isSelected ? 'true' : 'false'}"
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
  lucide.createIcons();
  restoreFocus(commitListEl, focused);
}

// Whole-project scope: what the mentor will read, shown instead of a diff.
function renderProjectOverview(project) {
  const stats = project.stats || {};
  const stat = (label, value) => `
    <div class="px-3 py-2 rounded-lg bg-[var(--btn-action-bg)] border border-[var(--border-app)]">
      <div class="text-[10px] text-[var(--text-muted)]">${label}</div>
      <div class="text-sm font-mono text-[var(--text-primary)]">${escapeHtml(String(value))}</div>
    </div>`;
  const lines = text => String(text || '').split('\n').filter(Boolean);
  const list = (items, render) => items.length
    ? `<ul class="space-y-0.5">${items.map(item => `<li class="truncate">${render(item)}</li>`).join('')}</ul>`
    : '<div class="text-[var(--text-subtle)]">—</div>';
  const section = (title, body) => `
    <div>
      <div class="text-[11px] font-semibold text-[var(--text-secondary)] mb-1">${title}</div>
      <div class="text-[11px] text-[var(--text-muted)]">${body}</div>
    </div>`;
  const entryPoints = Array.isArray(project.entryPoints) ? project.entryPoints : [];
  const hubs = Array.isArray(project.hubs) ? project.hubs : [];
  const dependencies = Object.entries(project.deps && typeof project.deps === 'object' ? project.deps : {})
    .map(([name, version]) => `${name} ${version}`);
  return `
    <div class="project-overview p-4 space-y-4">
      <div class="grid grid-cols-2 gap-2">
        ${stat('跟踪文件', stats.files ?? 0)}
        ${stat('源码文件', stats.codeFiles ?? 0)}
        ${stat('目录', stats.directories ?? 0)}
        ${stat('引用边', stats.edges ?? 0)}
      </div>
      ${Number(stats.dirty) ? `<div class="text-[10px] text-[var(--text-muted)]">工作区还有 ${Number(stats.dirty)} 个未提交改动：本快照读取 HEAD，未提交内容未计入。</div>` : ''}
      ${section('入口', list(entryPoints, path => `<span class="font-mono">${escapeHtml(path)}</span>`))}
      ${section('核心模块（被依赖最多）', list(hubs, hub => `<span class="font-mono">${escapeHtml(hub.path)}</span> ← ${Number(hub.count) || 0}`))}
      ${section('HTTP 端点', list(lines(project.endpoints), line => `<span class="font-mono">${escapeHtml(line.trim())}</span>`))}
      ${section('依赖', list(dependencies, line => `<span class="font-mono">${escapeHtml(line)}</span>`))}
      ${section('目录清单', `<pre class="whitespace-pre overflow-x-auto font-mono text-[10px] leading-relaxed bg-[var(--code-block-bg)] border border-[var(--code-block-border)] rounded-lg p-3 max-h-72">${escapeHtml(project.tree || '')}</pre>`)}
    </div>`;
}

// Switching target parks the current conversation and brings back the one
// held for the new target, if any.
window.selectTarget = (targetHash) => {
  if (targetHash !== activeTarget) {
    saveCurrentSession();
    activeTarget = targetHash;
    clearMentorSession();
    if (activeRepo) restoreSession(mentorSessions.get(sessionKey(activeRepo.id, targetHash)));
  }
  currentFocusFile = null;
  renderMentorScope();
  renderCommitPresets(currentPresets);
  renderCommitList(currentCommits);
  return activeRepo ? fetchDiff(activeRepo.id, targetHash) : Promise.resolve();
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
  diffEl.innerHTML = '<div class="p-4 text-[var(--text-muted)] font-mono text-xs">正在生成差异对比...</div>';

  document.getElementById('diff-target-label').textContent =
    target === 'project' ? '整个项目 (Project)' :
    target === 'working-tree' ? '当前未提交变动 (Working Tree)' :
    target.startsWith('range:') ? `聚合区间 ${target.slice(6)}` :
    target.includes('..') ? `区间对比 ${target}` :
    `提交 ${target.slice(0, 8)}`;

  try {
    const res = await apiFetch(`/api/repos/${repoId}/diff?target=${encodeURIComponent(target)}`, { signal: controller.signal });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (sequence !== diffRequestSequence || activeRepo?.id !== repoId) return;

    if (target === 'project' && data.project) {
      // Whole-project scope has no diff: show the inventory the mentor will read.
      currentDiffFiles = [];
      currentDiffWarnings = [];
      currentFocusFile = null;
      renderFileFilterChips([]);
      renderMentorScope();
      const factsBadge = document.getElementById('facts-badge');
      factsBadge.classList.toggle('hidden', !data.hasFacts);
      factsBadge.classList.toggle('flex', Boolean(data.hasFacts));
      document.getElementById('diff-stat-badge').textContent = `整个项目 · ${data.project.stats.files} 文件`;
      diffEl.innerHTML = renderProjectOverview(data.project);
      lucide.createIcons();
      return;
    }

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
    const inDiff = path => currentDiffFiles.some(file => file.path === path);
    if (currentFocusFile && !inDiff(currentFocusFile)) currentFocusFile = null;
    if (mentorScope?.file && !inDiff(mentorScope.file)) {
      // The conversation was about a file this selection no longer contains; do
      // not let follow-ups reuse a snapshot captured for it.
      clearCurrentMentorSession({ undoable: false, notice: `${mentorScope.file.split('/').pop()} 已不在当前改动中，相关对话已结束` });
    }
    renderFileFilterChips(currentDiffFiles);
    renderMentorScope();

    const statBadge = document.getElementById('diff-stat-badge');
    statBadge.textContent = data.statText ? data.statText.split('\n').pop().trim() : '0 文件';

    if (!currentDiffFiles.length) {
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
    diffEl.innerHTML = `<div class="p-4 text-[var(--diff-del-text)] text-xs font-mono">获取 Diff 失败: ${escapeHtml(err.message)}</div>`;
  }
}

// 渲染变动文件过滤标签流 (Chips)
function renderFileFilterChips(files) {
  const container = document.getElementById('file-filter-chips');
  if (!files || files.length === 0) {
    container.innerHTML = '<span class="text-[var(--text-muted)] text-[10px]">无变动文件</span>';
    return;
  }

  const allActive = currentFocusFile === null;
  let html = `
    <span class="text-[var(--text-subtle)] text-[10px]">变动文件:</span>
    <button type="button" data-action="focus-all" aria-pressed="${allActive}"
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
      <button type="button" data-action="focus" data-value="${escapeHtml(f.path)}" aria-pressed="${isActive}"
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

  const focused = focusedRow(container);
  container.innerHTML = html;
  restoreFocus(container, focused);
}

// Only changes what the diff panel shows; the mentor conversation keeps its scope.
window.setFocusFile = (filePath) => {
  currentFocusFile = filePath;
  renderFileFilterChips(currentDiffFiles);
  renderActiveDiff();
  renderMentorScope();
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
  if (!currentDiffFiles.length) { diffEl.innerHTML = '<span class="text-[var(--text-muted)]">// 无差异内容</span>'; return; }
  const text = diffViewSegments().map(segment => segment.file.patch).join('\n\n');
  const total = text.split('\n').length;
  const perPage = DIFF_PAGE_SIZE, pages = Math.ceil(total / perPage);
  diffPage = Math.max(0, Math.min(pages - 1, diffPage));
  const warnings = currentDiffWarnings.length ? `<div class="p-2 text-[var(--diff-hunk-text)] text-xs">${currentDiffWarnings.map(escapeHtml).join('<br>')}</div>` : '';
  const navigation = pages > 1 ? `<div class="diff-pagination">
    <span>第 ${diffPage + 1} / ${pages} 页 · 共 ${total} 行 · 复制保留完整 Diff</span>
    <button data-action="diff-page" data-value="${diffPage - 1}" ${diffPage === 0 ? 'disabled' : ''}>上一页</button>
    <button data-action="diff-page" data-value="${diffPage + 1}" ${diffPage === pages - 1 ? 'disabled' : ''}>下一页</button>
  </div>` : '';
  diffEl.innerHTML = warnings + navigation + renderFormattedDiff(text, diffPage * perPage, perPage);
}

function renderFormattedDiff(rawDiff, start = 0, count = Infinity) {
  if (!rawDiff?.trim()) return '<span class="text-[var(--text-muted)]">// 无差异内容</span>';
  const output = [];
  for (const row of walkDiff(rawDiff.split('\n'))) {
    if (row.index >= start + count) break;
    if (row.index < start) continue;
    output.push(`<div class="diff-line ${DIFF_ROW_CLASS[row.kind]}" data-row="${row.index}"><span class="diff-num">${row.label}</span><span class="diff-text">${escapeHtml(row.line)}</span></div>`);
  }
  return output.join('');
}

const DIFF_ROW_CLASS = {
  hunk: 'diff-line-hunk', file: 'text-[var(--diff-hunk-text)] font-bold mt-3 mb-1',
  add: 'diff-line-add', del: 'diff-line-del', context: '', meta: 'text-[var(--text-muted)]'
};

// Walks patch lines once, tracking hunk line numbers. The renderer and code
// reference navigation share it, so "line N" means the same row in both.
function* walkDiff(lines) {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      yield { index, line, kind: 'hunk', label: '@@' };
    } else if (line.startsWith('diff --git ')) {
      oldRemaining = newRemaining = 0;
      yield { index, line, kind: 'file', label: '···' };
    } else if ((oldRemaining || newRemaining) && line.startsWith('+')) {
      newRemaining--;
      yield { index, line, kind: 'add', newNo: newLine, label: newLine++ };
    } else if ((oldRemaining || newRemaining) && line.startsWith('-')) {
      oldRemaining--;
      yield { index, line, kind: 'del', oldNo: oldLine, label: oldLine++ };
    } else if ((oldRemaining || newRemaining) && line.startsWith(' ')) {
      oldRemaining--; newRemaining--;
      yield { index, line, kind: 'context', oldNo: oldLine++, newNo: newLine, label: newLine++ };
    } else {
      yield { index, line, kind: 'meta', label: '···' };
    }
  }
}

// The files shown in the diff panel and the row each starts at; the panel
// joins their patches with a blank line.
function diffViewSegments() {
  const files = currentFocusFile ? currentDiffFiles.filter(file => file.path === currentFocusFile) : currentDiffFiles;
  let start = 0;
  return files.map(file => {
    const segment = { file, start };
    start += file.patch.split('\n').length + 1;
    return segment;
  });
}

// Finds the row for a cited line: the new-file line first (what the model sees
// on context and added lines), then a deleted old-file line, else the nearest
// changed row so the reader still lands in the right place.
function locateDiffLine(patch, line) {
  let deleted = null, nearest = null;
  for (const row of walkDiff(patch.split('\n'))) {
    if (row.newNo === line) return { row: row.index, exact: true };
    if (row.oldNo === line && row.kind === 'del' && deleted === null) deleted = row.index;
    const number = row.newNo ?? row.oldNo;
    if (number !== undefined && (!nearest || Math.abs(number - line) < nearest.distance)) nearest = { row: row.index, distance: Math.abs(number - line) };
  }
  if (deleted !== null) return { row: deleted, exact: true };
  return nearest && { row: nearest.row, exact: false };
}

// `path:line`, `path:start-end` or `path#Lline` in an answer. Candidates are
// resolved against the diff files, so prose such as "端口:3300" stays text.
const CODE_REF = /([\w.\-@+\/\u4e00-\u9fff]+)(?::|#L)(\d+)(?:\s*[-–~]\s*L?(\d+))?/g;

function resolveRefPath(token, paths) {
  // Chinese prose often runs straight into a path ("见lib/a.js:3"), so also try
  // each start just after a CJK character, longest first.
  for (let skip = 0; skip < token.length; skip++) {
    if (skip && !/[\u4e00-\u9fff]/.test(token[skip - 1])) continue;
    const name = token.slice(skip).replace(/^\.?\//, '');
    if (!name) continue;
    if (paths.includes(name)) return { file: name, skip };
    const stripped = name.replace(/^[ab]\//, '');
    const matches = paths.filter(path => path === stripped || path.endsWith(`/${stripped}`));
    if (matches.length === 1) return { file: matches[0], skip };
  }
  return null;
}

function findCodeRefs(text, paths) {
  const refs = [];
  for (const match of text.matchAll(CODE_REF)) {
    const resolved = resolveRefPath(match[1], paths);
    if (!resolved) continue;
    const line = Number(match[2]), end = Number(match[3]) || null;
    if (!line) continue;
    refs.push({ start: match.index + resolved.skip, stop: match.index + match[0].length, file: resolved.file, line, end: end > line ? end : null });
  }
  return refs;
}

function linkCodeReferences(root) {
  const paths = currentDiffFiles.map(file => file.path);
  if (!paths.length) return;
  const visit = node => {
    for (const child of [...(node.childNodes || [])]) {
      if (child.nodeType === 3) linkTextNode(child, paths);
      else if (child.nodeType === 1 && !child.matches('pre, a, button, svg, .mermaid, .code-block-header')) visit(child);
    }
  };
  visit(root);
}

function linkTextNode(textNode, paths) {
  const text = textNode.nodeValue;
  const refs = findCodeRefs(text, paths);
  if (!refs.length) return;
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const ref of refs) {
    fragment.append(text.slice(last, ref.start));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-ref';
    button.dataset.refFile = ref.file;
    button.dataset.refLine = String(ref.line);
    if (ref.end) button.dataset.refEnd = String(ref.end);
    button.title = `在代码差异中查看 ${ref.file} 第 ${ref.line}${ref.end ? `-${ref.end}` : ''} 行`;
    button.textContent = text.slice(ref.start, ref.stop);
    fragment.append(button);
    last = ref.stop;
  }
  fragment.append(text.slice(last));
  textNode.replaceWith(fragment);
}

function revealDiffLine(file, line, end = null) {
  showPanel('diff');
  const target = currentDiffFiles.find(item => item.path === file);
  const diffEl = document.getElementById('diff-content');
  const notice = message => {
    const note = document.createElement('div');
    note.className = 'diff-ref-notice';
    note.textContent = message;
    diffEl.prepend(note);
  };
  if (!target) { notice(`${file} 不在当前代码差异中`); return; }
  currentFocusFile = file;
  renderFileFilterChips(currentDiffFiles);
  renderMentorScope();
  const found = locateDiffLine(target.patch, line);
  if (!found) { renderActiveDiff(); return; }
  diffPage = Math.floor(found.row / DIFF_PAGE_SIZE);
  renderActiveDiff(false);
  const last = end ? locateDiffLine(target.patch, end) : null;
  const stop = last?.exact && last.row > found.row ? last.row : found.row;
  let first = null;
  for (let row = found.row; row <= stop; row++) {
    const element = diffEl.querySelector(`[data-row="${row}"]`);
    if (element) { element.classList.add('diff-line-ref'); first ||= element; }
  }
  if (!found.exact) notice(`第 ${line} 行不在本次改动的 Diff 中，已定位到最近的改动行`);
  first?.scrollIntoView({ block: 'center' });
}

// Builds a question that quotes the selected diff rows with their file and
// real line numbers, so the reader can ask about exactly what they see.
const QUOTE_MAX_LINES = 120, QUOTE_MAX_CHARS = 6000;

function selectionPrompt(fromRow, toRow) {
  const blocks = [];
  let used = 0, truncated = false;
  for (const { file, start } of diffViewSegments()) {
    const lines = file.patch.split('\n');
    const from = Math.max(fromRow - start, 0), to = Math.min(toRow - start, lines.length - 1);
    if (from > to) continue;
    const picked = [];
    for (const row of walkDiff(lines)) {
      if (row.index < from) continue;
      if (row.index > to) break;
      if (row.kind === 'file' || row.kind === 'meta') continue;
      if (picked.length >= QUOTE_MAX_LINES || used + row.line.length > QUOTE_MAX_CHARS) { truncated = true; break; }
      picked.push(row); used += row.line.length + 1;
    }
    if (!picked.length) { if (truncated) break; continue; }
    const newNos = picked.map(row => row.newNo).filter(Number.isInteger);
    const oldNos = picked.map(row => row.oldNo).filter(Number.isInteger);
    const span = numbers => numbers.length ? `${Math.min(...numbers)}${Math.max(...numbers) > Math.min(...numbers) ? `-${Math.max(...numbers)}` : ''}` : '';
    const where = newNos.length ? `${file.path}:${span(newNos)}` : oldNos.length ? `${file.path}（旧版本第 ${span(oldNos)} 行）` : file.path;
    const code = picked.map(row => row.line).join('\n');
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) || []).map(run => run.length + 1)));
    blocks.push(`关于 ${where}：\n${fence}diff\n${code}\n${fence}`);
    if (truncated) break;
  }
  if (!blocks.length) return null;
  return `${blocks.join('\n\n')}${truncated ? '\n（选区较长，已截取前面部分）' : ''}\n\n`;
}

function selectedDiffRows() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const diffEl = document.getElementById('diff-content');
  const range = selection.getRangeAt(0);
  const rowOf = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.diff-line');
  const first = rowOf(range.startContainer), last = rowOf(range.endContainer);
  if (!first || !last || !diffEl.contains(first) || !diffEl.contains(last)) return null;
  const from = Number(first.dataset.row);
  let to = Number(last.dataset.row);
  // A triple-click ends at offset 0 of the next row, which holds nothing selected.
  if (range.endOffset === 0 && to > from) to--;
  return { from, to, rect: range.getBoundingClientRect() };
}

let selectionFrame = 0;
function updateAskSelection() {
  cancelAnimationFrame(selectionFrame);
  selectionFrame = requestAnimationFrame(() => {
    const button = document.getElementById('btn-ask-selection');
    const selected = selectedDiffRows();
    if (!button) return;
    if (!selected) { button.classList.add('hidden'); return; }
    button.style.top = `${Math.min(innerHeight - 44, selected.rect.bottom + 6)}px`;
    button.style.left = `${Math.max(8, Math.min(innerWidth - 170, selected.rect.left))}px`;
    button.classList.remove('hidden');
  });
}

function askAboutSelection() {
  const selected = selectedDiffRows();
  document.getElementById('btn-ask-selection')?.classList.add('hidden');
  if (!selected) return;
  const quote = selectionPrompt(selected.from, selected.to);
  if (!quote) return;
  window.getSelection().removeAllRanges();
  const input = document.getElementById('mentor-input');
  input.value = quote + input.value;
  showPanel('mentor');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  resizePromptInput();
}

function resizePromptInput() {
  const input = document.getElementById('mentor-input');
  if (!input?.style) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
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
      btn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-[var(--diff-add-text)]"></i> 已复制';
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
  if (!resetSession && (conversationHistory.length === 0 || !mentorSnapshotId || mentorRequestedTarget !== activeTarget)) {
    // A follow-up without a usable snapshot is a fresh analysis, never a
    // request that reuses stale evidence or a mismatched target.
    resetSession = true;
  }
  if (resetSession) {
    clearMentorSession();
    if (activeRepo) mentorSessions.delete(sessionKey(activeRepo.id, activeTarget));
    mentorScope = { file: currentFocusFile };
  }
  const scopeFile = mentorScope ? mentorScope.file : currentFocusFile;

  if (currentAbortController) {
    currentAbortController.abort();
  }
  const controller = new AbortController();
  currentAbortController = controller;
  renderMentorScope();
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
  announce('导师正在分析');

  // 每一轮都追加用户气泡：自由提问显示原文，精读动作显示动作名
  const userBubble = document.createElement('div');
  userBubble.className = 'flex justify-end pending-turn';
  userBubble.innerHTML = `
    <div class="bg-[var(--bg-bubble-user)] border border-[var(--border-user-bubble)] rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-xl text-xs text-[var(--text-primary)] shadow-sm leading-relaxed">
      <div class="font-medium text-[var(--text-muted)] text-[11px] mb-1 flex items-center gap-1 justify-end">
        <span>你</span> <i data-lucide="user" class="w-3 h-3 text-[var(--text-muted)]"></i>
      </div>
      <div class="user-prompt">${escapeHtml(customPrompt || ACTION_LABELS[mode] || mode)}</div>
    </div>
  `;
  chatStream.appendChild(userBubble);
  lucide.createIcons();
  chatStream.scrollTop = chatStream.scrollHeight;

  // 创建导师回答气泡容器
  const assistantBubble = document.createElement('div');
  assistantBubble.className = 'flex justify-start pending-turn';
  const settleTurn = () => {
    userBubble.classList.remove('pending-turn');
    assistantBubble.classList.remove('pending-turn');
  };
  const bubbleId = `bubble-${sessionVersion}-${requestId}`;
  assistantBubble.innerHTML = `
    <div class="bg-[var(--bg-bubble-assistant)] border border-[var(--border-assistant-bubble)] rounded-2xl rounded-tl-sm p-5 max-w-none w-full shadow-sm">
      <div class="flex items-center justify-between pb-2 mb-3 border-b border-[var(--border-app)]">
        <span class="text-xs font-semibold text-[var(--accent-terracotta)] flex items-center gap-1.5 font-mono">
          <svg class="w-3.5 h-3.5 text-[var(--accent-terracotta)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>
          </svg>
          Tech Mentor (${escapeHtml(modelSelect.options[modelSelect.selectedIndex]?.text?.split(' ')[0] || 'AI')})
          ${scopeFile ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-terracotta-bg)] text-[var(--accent-terracotta)] border border-[var(--accent-terracotta-border)]">聚焦: ${escapeHtml(scopeFile.split('/').pop())}</span>` : ''}
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
  // While streaming, finished top-level blocks are rendered once into `stableEl`
  // and only the open tail is re-rendered, so a long answer no longer costs a
  // full parse on every flush. The finished answer is rendered whole once.
  let stableEnd = 0, stableEl = null, tailEl = null, renderDelay = 80;
  const flushArticle = (final = false) => {
    clearTimeout(renderTimer); renderTimer = null;
    if (!ownsRequest()) return;
    const atBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 100;
    const started = Date.now();
    if (final) {
      article.innerHTML = renderMarkdown(currentTurnMarkdown);
      stableEl = tailEl = null; stableEnd = 0;
    } else {
      if (!stableEl) {
        article.innerHTML = '';
        stableEl = document.createElement('div'); tailEl = document.createElement('div');
        article.appendChild(stableEl); article.appendChild(tailEl);
      }
      const split = stableMarkdownSplit(currentTurnMarkdown, stableEnd);
      if (split > stableEnd) {
        stableEl.insertAdjacentHTML('beforeend', renderMarkdown(currentTurnMarkdown.slice(stableEnd, split)));
        stableEnd = split;
      }
      tailEl.innerHTML = renderMarkdown(currentTurnMarkdown.slice(stableEnd));
    }
    // Back off when a render gets slow so the page stays responsive.
    renderDelay = Math.min(500, Math.max(80, (Date.now() - started) * 4));
    if (atBottom) chatStream.scrollTop = chatStream.scrollHeight;
  };

  const sentHistory = historyForRequest(conversationHistory);
  if (sentHistory.length < conversationHistory.length) {
    statusText.textContent = `对话较长：本次携带最近 ${sentHistory.length} 条消息，首次代码快照仍完整保留`;
  }
  const payload = {
    repoPath: activeRepo.path,
    target: activeTarget,
    mode,
    customPrompt,
    focusFile: activeTarget === 'project' ? null : scopeFile,
    model: modelSelect.value,
    history: sentHistory,
    snapshotId: mentorSnapshotId
  };
  // The server echoes the instruction it actually sent, so the history records
  // the real question even for action buttons.
  let turnInstruction = customPrompt;
  let renewing = false;
  let snapshotRenewed = false;
  let turnEvidence = null;
  let turnPromptRedacted = 0;

  try {
    let response;
    while (true) {
      response = await apiFetch('/api/mentor/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (response.ok) break;
      const error = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!renewing && response.status === 409 && error.code === 'snapshot-expired' && conversationHistory.length) {
        // The snapshot sat idle too long or the service restarted. Re-capture
        // evidence for the same selection and keep the conversation; the answer
        // footer states that the evidence was renewed.
        renewing = true;
        payload.snapshotId = null;
        payload.renewSnapshot = true;
        statusText.textContent = '分析快照已失效，正在重新捕获证据…';
        continue;
      }
      const failure = new Error(error.error || `服务响应异常: ${response.status}`);
      failure.status = response.status;
      throw failure;
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
            mentorRequestedTarget = typeof event.requestedTarget === 'string' ? event.requestedTarget : activeTarget;
            snapshotRenewed = renewing || Boolean(event.renewed);
            if (typeof event.instruction === 'string' && event.instruction) turnInstruction = event.instruction;
            if (event.evidence && typeof event.evidence === 'object') turnEvidence = event.evidence;
            if (Number.isInteger(event.promptRedacted) && event.promptRedacted > 0) turnPromptRedacted = event.promptRedacted;
          } else if (event.type === 'status') {
            statusText.textContent = event.message;
          } else if (event.type === 'chunk' && !finalized) {
            currentTurnMarkdown += event.text;
            renderTimer ||= setTimeout(flushArticle, renderDelay);
          } else if (event.type === 'usage') {
            currentTurnUsage = event.usage;
          } else if (event.type === 'error') {
            throw new Error(event.message || '分析失败');
          } else if ((event.type === 'finished' || event.type === 'done') && !finalized) {
            finalized = true;
            flushArticle(true);
            await postProcessArticle(article);
            if (!isCurrent()) return;
            if (mentorResolvedTarget) {
              const evidenceNotice = document.createElement('p');
              evidenceNotice.className = 'text-[10px] text-[var(--text-muted)] mt-2';
              const evidenceTarget = mentorRequestedTarget === 'project'
                ? `整个项目 @ ${String(mentorResolvedTarget).slice(0, 8)}`
                : mentorResolvedTarget === 'working-tree' ? '读取时的工作区' : mentorResolvedTarget;
              evidenceNotice.textContent = snapshotRenewed
                ? `分析快照已在会话中重新捕获: ${evidenceTarget} · 早先回答可能基于旧证据`
                : `分析快照: ${evidenceTarget} · 追问保留首次证据`;
              footerEl.appendChild(evidenceNotice);
            }
            if (turnEvidence) footerEl.appendChild(renderEvidence(turnEvidence));
            if (turnPromptRedacted) {
              const note = document.createElement('p');
              note.className = 'text-[10px] text-[var(--text-muted)] mt-1';
              note.textContent = `本轮提问与历史中 ${turnPromptRedacted} 个疑似密钥已替换后发送`;
              footerEl.appendChild(note);
            }
            if (currentTurnUsage) {
              const numeric = key => Math.max(0, Number(currentTurnUsage[key]) || 0);
              const usage = document.createElement('div');
              usage.className = 'mt-4 pt-3 border-t border-[var(--border-app)] text-xs text-[var(--text-muted)]';
              usage.textContent = `本次分析: ${numeric('total_tokens')} tokens (输入: ${numeric('prompt_tokens')}, 输出: ${numeric('completion_tokens')})`;
              footerEl.appendChild(usage);
            }
            if (turnInstruction) conversationHistory.push({ role: 'user', content: turnInstruction });
            conversationHistory.push({ role: 'assistant', content: currentTurnMarkdown });
            if (footerEl) renderQuickChips(footerEl, mode);
            loadKeeperStats();
            statusBar.classList.add('hidden');
            settleTurn();
            saveCurrentSession();
            announce('导师回答完成');
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
    flushArticle(true);
    if (!currentTurnMarkdown) article.innerHTML = '';
    if (controller.signal.aborted) {
      const notice = document.createElement('p');
      notice.className = 'text-[var(--text-muted)] text-xs mt-2';
      notice.textContent = '已终止生成，未保存未完成的回答';
      article.appendChild(notice);
      announce('已终止生成');
    } else {
      const staleSnapshot = err.status === 409 && /快照/.test(err.message);
      if (staleSnapshot) {
        mentorSnapshotId = null;
        mentorRequestedTarget = null;
        mentorResolvedTarget = null;
        if (activeRepo) mentorSessions.delete(sessionKey(activeRepo.id, activeTarget));
      }
      const notice = document.createElement('p');
      notice.className = 'text-[var(--diff-del-text)] text-xs mt-2';
      notice.textContent = staleSnapshot
        ? `分析快照已失效: ${err.message}。下一次精读或提问会重新建立快照。`
        : `分析失败: ${err.message}`;
      article.appendChild(notice);
      announce(staleSnapshot ? '分析快照已失效' : `分析失败: ${err.message}`);
    }
  } finally {
    clearTimeout(renderTimer);
    settleTurn();
    if (currentAbortController === controller) {
      currentAbortController = null;
      statusBar.classList.add('hidden');
      renderMentorScope();
    }
  }
}

// Screen readers hear the start and end of an analysis through a hidden status
// region; the visible status bar disappears without being announced.
function announce(message) {
  const live = document.getElementById('mentor-live');
  if (live) live.textContent = message;
}

// "本次依据": which diff files, documents and source lines the model was given.
// Built from text nodes only; the manifest carries paths and ranges, no contents.
function renderEvidence(evidence) {
  const list = value => Array.isArray(value) ? value.filter(item => item && typeof item.path === 'string') : [];
  const project = evidence.scope === 'project';
  const diffFiles = project ? [] : list(evidence.diff?.files), documents = list(evidence.documents), sources = list(evidence.sources);
  const omitted = Math.max(0, Number(evidence.diff?.omitted) || 0);
  const cut = [...diffFiles, ...documents, ...sources].filter(item => item.truncated).length;
  const spans = ranges => Array.isArray(ranges) && ranges.length
    ? ranges.map(([start, end]) => start === end ? `${start}` : `${start}-${end}`).join(', ') : '';
  const details = document.createElement('details');
  details.className = 'evidence-details';
  const summary = document.createElement('summary');
  const scan = evidence.secretScan && typeof evidence.secretScan === 'object' ? evidence.secretScan : null;
  const redacted = Math.max(0, Number(scan?.redacted) || 0);
  const scanNote = !scan ? '' : scan.available === false ? ' · 未做密钥扫描' : redacted ? ` · ${redacted} 个疑似密钥已替换` : '';
  const stats = evidence.stats && typeof evidence.stats === 'object' ? evidence.stats : {};
  summary.textContent = project
    ? `本次依据：整个项目 @ ${String(evidence.revision || '').slice(0, 8)} · 清单 ${Number(stats.files) || 0} 个文件 · 引用边 ${Number(stats.edges) || 0} 条 · 端点 ${Number(stats.endpoints) || 0} 个 · 文档 ${documents.length} 份 · 源码 ${sources.length} 个文件${cut ? ` · ${cut} 处截断` : ''}${scanNote}`
    : `本次依据：Diff ${diffFiles.length} 个文件${omitted ? `（另有 ${omitted} 个未展示）` : ''} · 文档 ${documents.length} 份 · 源码 ${sources.length} 个文件${cut ? ` · ${cut} 处截断` : ''}${scanNote}`;
  details.appendChild(summary);
  const section = (title, items, describe) => {
    if (!items.length) return;
    const heading = document.createElement('div');
    heading.className = 'evidence-heading';
    heading.textContent = title;
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = describe(item);
      ul.appendChild(li);
    }
    details.appendChild(heading);
    details.appendChild(ul);
  };
  if (project) {
    const entryPoints = Array.isArray(evidence.entryPoints) ? evidence.entryPoints.filter(path => typeof path === 'string') : [];
    const hubs = list(evidence.hubs);
    section('入口', entryPoints.map(path => ({ path })), item => item.path);
    section('核心模块', hubs, item => `${item.path} ← ${Number(item.count) || 0} 个模块`);
  } else {
    section('Diff', diffFiles, item => `${item.path}${item.truncated ? '（已截断）' : ''}`);
  }
  section('文档', documents, item => `${item.path}${item.truncated ? `（第 ${spans(item.ranges)} 行，已截断）` : ''}`);
  section('源码', sources, item => `${item.path}${item.truncated ? `：第 ${spans(item.ranges)} 行` : '：全文'}`);
  if (scan) {
    const rules = Array.isArray(scan.rules) ? scan.rules.filter(rule => typeof rule === 'string') : [];
    section('密钥扫描', [{ path: scan.available === false ? '未安装 gitleaks，发给模型的内容没有做密钥扫描'
      : redacted ? `gitleaks 发现 ${redacted} 个疑似密钥，已替换为 [REDACTED]${rules.length ? `（${rules.join('、')}）` : ''}` : 'gitleaks 未发现疑似密钥' }], item => item.path);
  }
  const warnings = Array.isArray(evidence.warnings) ? evidence.warnings.filter(text => typeof text === 'string') : [];
  const more = Math.max(0, (Number(evidence.warningCount) || warnings.length) - warnings.length);
  section('提示', warnings.map(text => ({ path: text })).concat(more ? [{ path: `另有 ${more} 条提示` }] : []), item => item.path);
  return details;
}

// 快速追问胶囊生成：第一项随本轮模式变化，只有出过题时才“展开考题”
function renderQuickChips(container, mode) {
  const drill = mode === 'drill'
    ? { prompt: '请深度展开刚才提出的自测考题，给出详细推演思路与参考答案', label: '展开自测考题推演与答案' }
    : { prompt: '请基于刚才的讲解出两道场景推演自测题，先列题目，推理过程和参考答案放在最后', label: '出两道自测题检验理解' };
  const chipsWrapper = document.createElement('div');
  chipsWrapper.className = 'mt-5 pt-3.5 border-t border-[var(--border-app)] flex flex-wrap items-center gap-2 text-xs';
  chipsWrapper.innerHTML = `
    <span class="text-[var(--text-subtle)] text-[10px] mr-1 flex items-center gap-1 font-mono">
      <i data-lucide="sparkles" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> 快速追问:
    </span>
    <button class="quick-chip" data-action="ask" data-value="${drill.prompt}">
      <i data-lucide="chevron-right" class="w-3 h-3 text-[var(--accent-terracotta)]"></i> ${drill.label}
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
  mentorRequestedTarget = null;
  mentorScope = null;
  hideMentorNotice();
  renderMentorScope();
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
        点击上方精读动作或在下方提问，可以连续追问。回答里的“文件:行号”可点击跳到对应代码；在代码差异中选中几行，可以直接就这段提问。
      </p>
    </div>
  `;
  lucide.createIcons();
}

// 复制整轮精读笔记为 Markdown
// What the notes say they cover: the whole project or the selected revision.
function scopeLabel() {
  if (mentorRequestedTarget === 'project' || activeTarget === 'project') {
    const revision = mentorResolvedTarget && mentorResolvedTarget !== 'project' ? ` @ ${String(mentorResolvedTarget).slice(0, 8)}` : '';
    return `整个项目${revision}`;
  }
  return mentorResolvedTarget || activeTarget;
}

async function copyMentorNotes() {
  if (conversationHistory.length === 0) {
    alert('暂无精读笔记可复制');
    return;
  }

  let fullMarkdown = `# 🧭 Tech Mentor 精读笔记: ${activeRepo ? activeRepo.name : ''}\n\n`;
  fullMarkdown += `> 目标: ${scopeLabel()} | 时间: ${new Date().toLocaleString()}\n\n`;

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
    copyBtn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-[var(--diff-add-text)]"></i> 已复制!';
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
  const safeRepoName = repoName.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 80) || 'repo';
  const targetTag = (mentorRequestedTarget === 'project' ? 'project' : mentorResolvedTarget || activeTarget).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const fileName = `tech-mentor-${safeRepoName}-${targetTag}.md`;

  let fullMarkdown = `# 🧭 Tech Mentor 深度精读笔记: ${repoName}\n\n`;
  fullMarkdown += `> **代码目标**: \`${scopeLabel()}\` | **导出时间**: ${new Date().toLocaleString()} | **仓库路径**: \`${activeRepo?.path || ''}\`\n\n`;
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
      <span class="text-[var(--text-muted)] uppercase font-mono">${escapeHtml(lang)}</span>
      <button class="copy-code-btn text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 transition text-[10px]">
        <i data-lucide="copy" class="w-3 h-3"></i> 复制代码
      </button>
    `;

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });

  // 3. 渲染 Mermaid 图表
  const mermaidBlocks = article.querySelectorAll('pre code.language-mermaid');
  if (mermaidBlocks.length > 0) {
    // Without Mermaid the diagram source stays visible as a code block.
    try { await loadMermaid(); } catch (error) { console.warn('Mermaid unavailable:', error); }
  }
  if (mermaidBlocks.length > 0 && window.mermaid) {
    for (const block of mermaidBlocks) {
      const code = block.textContent;
      const container = document.createElement('div');
      container.className = 'mermaid mermaid-box my-4 p-4 rounded-lg flex justify-center';
      // Kept so a theme switch can redraw the diagram from its source.
      container.dataset.mermaidSource = code;
      container.dataset.mermaidTheme = mermaidTheme();
      container.textContent = code;
      block.parentElement.replaceWith(container);
    }
    // Only containers built here: sanitized answers cannot carry data attributes.
    for (const node of Array.from(article.querySelectorAll('.mermaid[data-mermaid-source]'))) {
      await renderDiagram(node);
    }
  }

  // 4. 把 `文件:行号` 变成可跳转到 Diff 对应行的链接
  linkCodeReferences(article);

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
