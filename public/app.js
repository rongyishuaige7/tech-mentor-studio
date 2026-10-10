// Tech Mentor Studio Client Application (P0/P1 Multi-turn & Smart Diff Filter)
let allRepos = [];
let activeRepo = null;
let activeTarget = 'working-tree'; // 'working-tree' 或 commit hash
let currentDiffFiles = [];
let currentFocusFile = null; // null 表示全部文件
let currentAbortController = null;

// P1: 多轮对话记忆栈 [{ role: 'user' | 'assistant', content: string }]
let conversationHistory = [];

document.addEventListener('DOMContentLoaded', () => {
  if (window.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose'
    });
  }

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
  loadRepos();
});

function setupEventListeners() {
  document.getElementById('btn-refresh').addEventListener('click', loadRepos);
  document.getElementById('repo-search').addEventListener('input', handleRepoFilter);
  document.getElementById('btn-add-repo').addEventListener('click', handleAddRepo);

  // 快捷动作按钮 (启动全新专项精读)
  document.getElementById('btn-walkthrough').addEventListener('click', () => startMentorAnalysis('walkthrough', '', true));
  document.getElementById('btn-anatomy').addEventListener('click', () => startMentorAnalysis('anatomy', '', true));
  document.getElementById('btn-pitfalls').addEventListener('click', () => startMentorAnalysis('pitfalls', '', true));
  document.getElementById('btn-drill').addEventListener('click', () => startMentorAnalysis('drill', '', true));

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
  document.getElementById('btn-clear-mentor').addEventListener('click', clearMentorSession);

  // 复制笔记
  document.getElementById('btn-copy-mentor').addEventListener('click', copyMentorNotes);
}

// 1. 加载仓库列表
async function loadRepos() {
  const listEl = document.getElementById('repo-list');
  listEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-8">正在扫描本地 Git 仓库...</div>';

  try {
    const res = await fetch('/api/repos');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    allRepos = data.repos;
    document.getElementById('repo-count').textContent = allRepos.length;
    renderRepoList(allRepos);

    if (allRepos.length > 0 && !activeRepo) {
      selectRepo(allRepos[0]);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="text-xs text-rose-400 text-center py-6">加载仓库失败: ${err.message}</div>`;
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
      <div onclick="selectRepoById('${repo.id}')" 
           class="p-2.5 rounded-lg cursor-pointer transition flex flex-col gap-1 border ${
             isSelected 
               ? 'bg-indigo-600/15 border-indigo-500/40 text-white' 
               : 'bg-slate-900/40 border-slate-800/40 hover:bg-slate-800/60 text-slate-300'
           }">
        <div class="flex items-center justify-between">
          <span class="font-medium text-xs truncate flex items-center gap-1.5">
            <i data-lucide="folder-git-2" class="w-3.5 h-3.5 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}"></i>
            ${escapeHtml(repo.name)}
          </span>
          ${hasDirty 
            ? `<span class="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono font-medium">⚡ ${repo.dirtyCount} 变动</span>` 
            : `<span class="text-[10px] text-slate-500 font-mono">${escapeHtml(repo.branch)}</span>`
          }
        </div>
        ${repo.lastCommit ? `
          <div class="text-[11px] text-slate-400 truncate mt-0.5">
            ${escapeHtml(repo.lastCommit.msg)}
          </div>
          <div class="text-[10px] text-slate-500 flex items-center justify-between mt-0.5">
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
  const targetPath = prompt('请输入本地 Git 项目的绝对路径 (支持 ~ 代表主目录):');
  if (!targetPath) return;

  try {
    const res = await fetch('/api/repos/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    await loadRepos();
  } catch (err) {
    alert(`添加失败: ${err.message}`);
  }
}

// 2. 选择仓库并加载提交记录
async function selectRepo(repo) {
  activeRepo = repo;
  currentFocusFile = null;
  clearMentorSession();
  renderRepoList(allRepos);

  document.getElementById('active-repo-name').textContent = repo.name;
  document.getElementById('active-repo-path').textContent = repo.path;
  const branchBadge = document.getElementById('active-repo-branch');
  branchBadge.textContent = repo.branch;
  branchBadge.classList.remove('hidden');

  const commitListEl = document.getElementById('commit-list');
  commitListEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-6">正在读取变动记录...</div>';

  try {
    const res = await fetch(`/api/repos/${repo.id}/commits`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    renderCommitList(data.commits);

    if (data.commits.length > 0) {
      selectTarget(data.commits[0].hash);
    }
  } catch (err) {
    commitListEl.innerHTML = `<div class="text-xs text-rose-400 text-center py-4">读取提交失败: ${err.message}</div>`;
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
      <div onclick="selectTarget('${c.hash}')" 
           class="p-2 px-3 cursor-pointer transition flex items-center justify-between border-l-2 ${
             isSelected 
               ? 'bg-indigo-600/20 border-indigo-500 text-white font-medium' 
               : isWorkingTree 
                 ? 'bg-amber-500/10 border-amber-500/60 text-amber-200 hover:bg-amber-500/15'
                 : 'border-transparent text-slate-300 hover:bg-slate-800/40'
           }">
        <div class="truncate mr-2">
          <div class="text-xs truncate flex items-center gap-1.5">
            ${isWorkingTree ? '<span class="text-amber-400">⚡</span>' : ''}
            ${escapeHtml(c.msg)}
          </div>
          <div class="text-[10px] text-slate-500 mt-0.5 font-mono">
            <span>${escapeHtml(c.author)}</span> · <span>${escapeHtml(c.relTime)}</span>
          </div>
        </div>
        <span class="text-[10px] font-mono shrink-0 px-1 py-0.2 rounded bg-slate-800 text-slate-400">
          ${escapeHtml(c.shortHash)}
        </span>
      </div>
    `;
  }).join('');
}

window.selectTarget = (targetHash) => {
  activeTarget = targetHash;
  currentFocusFile = null;
  clearMentorSession();
  const commitListEl = document.getElementById('commit-list');
  if (activeRepo) {
    fetchDiff(activeRepo.id, targetHash);
  }
};

// 3. 加载 Diff 内容与变动文件树
async function fetchDiff(repoId, target) {
  const diffEl = document.getElementById('diff-content');
  diffEl.innerHTML = '<span class="text-slate-500">正在生成差异对比...</span>';

  document.getElementById('diff-target-label').textContent = 
    target === 'working-tree' ? '当前未提交变动 (Working Tree)' : `提交 ${target.slice(0, 8)}`;

  try {
    const res = await fetch(`/api/repos/${repoId}/diff?target=${target}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

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
    renderFileFilterChips(currentDiffFiles);

    const statBadge = document.getElementById('diff-stat-badge');
    statBadge.textContent = data.statText ? data.statText.split('\n').pop().trim() : '0 文件';

    if (!data.diffText || data.diffText.trim() === '') {
      diffEl.innerHTML = `
        <div class="p-6 text-center text-slate-500 space-y-2">
          <div class="text-amber-400 text-sm font-medium">✨ 当前目标没有检测到代码差异</div>
          <p class="text-xs text-slate-400 max-w-xs mx-auto leading-relaxed">
            ${target === 'working-tree' 
              ? '当前工作区非常干净，没有未提交的代码改动。请在上方选择一条具体的【历史提交 (Commit)】，让导师带读已提交的代码！' 
              : '该提交没有文本文件变动。请选择其他提交查看。'}
          </p>
        </div>
      `;
      return;
    }

    renderActiveDiff();
  } catch (err) {
    diffEl.innerHTML = `<span class="text-rose-400">获取 Diff 失败: ${err.message}</span>`;
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
    <span class="text-slate-500 text-[10px]">变动文件:</span>
    <button onclick="setFocusFile(null)" 
            class="px-2 py-0.5 rounded text-[10px] font-mono transition shrink-0 ${
              allActive ? 'bg-indigo-600 text-white font-medium' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }">
      全部文件 (${files.length})
    </button>
  `;

  html += files.map(f => {
    const isActive = currentFocusFile === f.path;
    const baseName = f.path.split('/').pop();
    const isNoise = f.isNoise;

    return `
      <button onclick="setFocusFile('${escapeHtml(f.path)}')" 
              title="${escapeHtml(f.path)}"
              class="px-2 py-0.5 rounded text-[10px] font-mono transition shrink-0 flex items-center gap-1 ${
                isActive 
                  ? 'bg-indigo-600 text-white font-medium shadow-sm' 
                  : isNoise
                    ? 'bg-slate-900 text-slate-500 border border-slate-800 hover:bg-slate-800'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }">
        <span class="truncate max-w-[120px]">${escapeHtml(baseName)}</span>
        <span class="text-[9px] text-emerald-400">+${f.additions}</span>
        <span class="text-[9px] text-rose-400">-${f.deletions}</span>
      </button>
    `;
  }).join('');

  container.innerHTML = html;
}

window.setFocusFile = (filePath) => {
  currentFocusFile = filePath;
  renderFileFilterChips(currentDiffFiles);
  renderActiveDiff();
};

function renderActiveDiff() {
  const diffEl = document.getElementById('diff-content');
  if (!currentDiffFiles || currentDiffFiles.length === 0) {
    diffEl.innerHTML = '<span class="text-slate-500">// 无差异内容</span>';
    return;
  }

  let textToRender = '';
  if (currentFocusFile) {
    const file = currentDiffFiles.find(f => f.path === currentFocusFile);
    textToRender = file ? file.patch : '// 未找到选中文件的 Diff';
  } else {
    textToRender = currentDiffFiles.map(f => f.patch).join('\n\n');
  }

  diffEl.innerHTML = renderFormattedDiff(textToRender);
}

function renderFormattedDiff(rawDiff) {
  const lines = rawDiff.split('\n');
  return lines.map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---')) {
      return `<span class="text-indigo-300 font-bold">${escaped}</span>`;
    }
    if (line.startsWith('+')) {
      return `<span class="diff-line-add">${escaped}</span>`;
    }
    if (line.startsWith('-')) {
      return `<span class="diff-line-del">${escaped}</span>`;
    }
    if (line.startsWith('@@')) {
      return `<span class="diff-line-hunk">${escaped}</span>`;
    }
    return `<span>${escaped}</span>`;
  }).join('\n');
}

// 4. 触发 Tech Mentor 深度分析 (P1 多轮记忆流式支持)
async function startMentorAnalysis(mode, customPrompt = '', resetSession = false) {
  if (!activeRepo) {
    alert('请先在左侧选择一个仓库项目！');
    return;
  }

  if (resetSession) {
    clearMentorSession();
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

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
      <div class="bg-indigo-600/20 border border-indigo-500/40 rounded-xl rounded-tr-none px-4 py-2.5 max-w-xl text-xs text-indigo-100 shadow-sm leading-relaxed">
        <div class="font-semibold text-indigo-300 text-[11px] mb-1 flex items-center gap-1 justify-end">
          <span>你</span> <i data-lucide="user" class="w-3 h-3"></i>
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
  const bubbleId = 'bubble-' + Date.now();
  assistantBubble.innerHTML = `
    <div class="bg-slate-900/80 border border-slate-800 rounded-xl rounded-tl-none p-5 max-w-none w-full shadow-lg">
      <div class="flex items-center justify-between pb-2 mb-3 border-b border-slate-800/80">
        <span class="text-xs font-semibold text-indigo-300 flex items-center gap-1.5 font-mono">
          <i data-lucide="compass" class="w-3.5 h-3.5 text-indigo-400"></i>
          Tech Mentor (${modelSelect.options[modelSelect.selectedIndex].text.split(' ')[0]})
          ${currentFocusFile ? `<span class="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300">聚焦: ${currentFocusFile.split('/').pop()}</span>` : ''}
        </span>
        <span class="text-[10px] text-slate-500 font-mono">${new Date().toLocaleTimeString()}</span>
      </div>
      <article id="${bubbleId}" class="prose prose-invert prose-slate max-w-none text-slate-200 text-sm leading-relaxed">
        <div class="text-slate-500 animate-pulse text-xs">导师正在推演系统逻辑与代码流向...</div>
      </article>
    </div>
  `;
  chatStream.appendChild(assistantBubble);
  lucide.createIcons();
  chatStream.scrollTop = chatStream.scrollHeight;

  const article = document.getElementById(bubbleId);
  let currentTurnMarkdown = '';

  const payload = {
    repoPath: activeRepo.path,
    target: activeTarget,
    mode,
    customPrompt,
    focusFile: currentFocusFile,
    model: modelSelect.value,
    history: conversationHistory // 附带上一轮历史
  };

  try {
    const response = await fetch('/api/mentor/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: currentAbortController.signal
    });

    if (!response.ok) throw new Error(`服务响应异常: ${response.status}`);

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
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        try {
          const event = JSON.parse(jsonStr);
          if (event.type === 'status') {
            statusText.textContent = event.message;
          } else if (event.type === 'chunk') {
            currentTurnMarkdown += event.text;
            article.innerHTML = marked.parse(currentTurnMarkdown);
            chatStream.scrollTop = chatStream.scrollHeight;
          } else if (event.type === 'error') {
            currentTurnMarkdown += `\n\n> ⚠️ **错误**: ${event.message}`;
            article.innerHTML = marked.parse(currentTurnMarkdown);
          } else if (event.type === 'finished' || event.type === 'done') {
            statusBar.classList.add('hidden');
            postProcessArticle(article);

            // 存入多轮历史
            if (!resetSession && customPrompt) {
              conversationHistory.push({ role: 'user', content: customPrompt });
            }
            conversationHistory.push({ role: 'assistant', content: currentTurnMarkdown });
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      statusText.textContent = '已终止生成';
      setTimeout(() => statusBar.classList.add('hidden'), 1000);
    } else {
      article.innerHTML = `<div class="text-rose-400 p-3 bg-rose-500/10 rounded border border-rose-500/20 text-xs">分析失败: ${err.message}</div>`;
      statusBar.classList.add('hidden');
    }
  } finally {
    currentAbortController = null;
  }
}

function stopMentorAnalysis() {
  if (currentAbortController) {
    currentAbortController.abort();
  }
}

function clearMentorSession() {
  conversationHistory = [];
  const chatStream = document.getElementById('mentor-chat-stream');
  chatStream.innerHTML = `
    <div id="mentor-empty-state" class="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500">
      <div class="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-3 text-indigo-400">
        <i data-lucide="graduation-cap" class="w-6 h-6"></i>
      </div>
      <h3 class="text-sm font-semibold text-slate-300">专属技术导师就绪</h3>
      <p class="text-xs text-slate-400 max-w-sm mt-1 leading-relaxed">
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
  fullMarkdown += `> 目标: ${activeTarget} | 时间: ${new Date().toLocaleString()}\n\n`;

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

async function postProcessArticle(article) {
  article.querySelectorAll('pre code').forEach((block) => {
    if (!block.classList.contains('language-mermaid')) {
      hljs.highlightElement(block);
    }
  });

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
      await mermaid.run();
    } catch (e) {
      console.warn('Mermaid render error:', e);
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
