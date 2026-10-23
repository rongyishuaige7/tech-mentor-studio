import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fixture, contrastReport } from './fixture.js';

function stream(text, snapshot = {}) {
  return [{ type: 'snapshot', snapshotId: 'browser-snapshot', resolvedTarget: 'a'.repeat(40), ...snapshot }, { type: 'chunk', text }, { type: 'finished' }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('model errors are visible and retry enables analysis', async ({ page }) => {
  await fixture(page); let unavailable = true;
  await page.route('**/api/models', route => route.fulfill({ status: unavailable ? 502 : 200, json: unavailable
    ? { success: false, error: '代理认证失败', models: [] } : { success: true, models: [{ id: 'test-model', name: 'Test Model' }] } }));
  await page.goto('/');
  await expect(page.locator('#model-status')).toHaveText('代理认证失败');
  await expect(page.locator('#btn-walkthrough')).toBeDisabled();
  await expect(page.locator('#keeper-token-text')).toHaveText('计量不可用');
  unavailable = false; await page.locator('#btn-retry-models').click();
  await expect(page.locator('#btn-walkthrough')).toBeEnabled();
  await expect(page.locator('#model-select')).toHaveValue('test-model');
});

test('narrow layout supports snapshot follow-ups, clipboard and Markdown export', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page); const payloads = [];
  await page.route('**/api/mentor/analyze', route => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: stream('## 代码机制\n\n```js\nconst result = 42;\n```') });
  });
  await page.goto('/');
  await expect(page.locator('#diff-panel')).toBeVisible();
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-action="panel"][data-value="repos"]').click();
  await expect(page.locator('#repos-panel')).toBeVisible();
  await expect(page.locator('#repo-select')).toBeVisible();
  await page.locator('[data-action="panel"][data-value="diff"]').click();
  await expect(page.locator('#diff-panel')).toBeVisible();
  await page.locator('[data-action="panel"][data-value="mentor"]').click();
  await page.locator('#btn-walkthrough').click();
  await expect(page.locator('.copy-code-btn')).toHaveCount(1);
  await expect(page.locator('#mentor-status-bar')).toBeHidden();
  await page.locator('.copy-code-btn').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const result = 42;\n');
  await page.locator('#mentor-input').fill('解释这个结果'); await page.locator('#btn-submit-prompt').click();
  await expect(page.locator('.copy-code-btn')).toHaveCount(2);
  await expect(page.locator('#mentor-status-bar')).toBeHidden();
  expect(payloads[1].snapshotId).toBe('browser-snapshot');
  expect(payloads[1].history).toHaveLength(1);
  expect(await page.evaluate(() => conversationHistory.length)).toBe(3);
  await page.locator('#btn-copy-mentor').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('代码机制');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#btn-export-mentor').click();
  const download = await downloadPromise;
  expect(fs.readFileSync(await download.path(), 'utf8')).toContain('const result = 42;');
  await page.locator('[data-action="panel"][data-value="diff"]').click();
  await page.locator('#tab-diff').click();
  await page.locator('[data-action="focus"]').click();
  expect(await page.evaluate(() => mentorSnapshotId)).toBe('browser-snapshot');
  expect(await page.evaluate(() => conversationHistory.length)).toBe(3);
  await page.locator('[data-action="panel"][data-value="mentor"]').click();
  await page.locator('#btn-scope-new').click();
  expect(await page.evaluate(() => mentorSnapshotId)).toBeNull();
  expect(await page.evaluate(() => conversationHistory.length)).toBe(0);
  await page.locator('#btn-undo-clear').click();
  expect(await page.evaluate(() => conversationHistory.length)).toBe(3);
  await expect(page.locator('.copy-code-btn')).toHaveCount(2);
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
});

test('answer references open the cited diff line and selected lines become a quoted question', async ({ page }) => {
  const patch = 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail\n';
  await fixture(page, { path: 'src/app.js', patch });
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream('改动在 `src/app.js:11`，随后 app.js:12 收尾。') }));
  await page.goto('/');
  await page.locator('#btn-anatomy').click();
  await expect(page.locator('.mentor-prose .code-ref')).toHaveCount(2);
  await page.locator('.mentor-prose .code-ref').first().click();
  await expect(page.locator('#diff-content .diff-line-ref .diff-text')).toHaveText('+new');
  await expect(page.locator('#mentor-scope-text')).toHaveText('讨论范围：全部文件');
  expect(await page.evaluate(() => conversationHistory.length)).toBe(1);

  await page.evaluate(() => {
    const rows = document.querySelectorAll('#diff-content .diff-line');
    const range = document.createRange();
    range.setStart(rows[5].querySelector('.diff-text').firstChild, 0);
    range.setEnd(rows[7].querySelector('.diff-text').firstChild, 3);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await page.locator('#btn-ask-selection').click();
  await expect(page.locator('#mentor-input')).toHaveValue(/^关于 src\/app\.js:11-12：\n```diff\n-old\n\+new\n tail\n```/);
});

test('the whole-project scope shows the inventory and a walkthrough reads it', async ({ page }) => {
  await fixture(page);
  const project = {
    stats: { files: 12, codeFiles: 8, directories: 3, edges: 5, endpoints: 2, documents: 1 },
    entryPoints: ['server.js'], hubs: [{ path: 'lib/security.js', count: 4 }],
    deps: { express: '^4.21.2' }, documents: ['README.md'],
    tree: './ (2)\n  server.js 1.0k\nlib/ (1)\n  security.js 2.0k',
    endpoints: '服务端路由：\n  GET /api/health  server.js:4',
    imports: '模块引用边：\n  server.js -> lib/security.js'
  };
  await page.route('**/api/repos/fixture/diff?target=project', route => route.fulfill({ json: {
    success: true, target: 'project', resolvedTarget: 'a'.repeat(40), branch: 'main', project, hasFacts: true } }));
  const payloads = [];
  await page.route('**/api/mentor/analyze', route => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: stream('回答') });
  });
  await page.goto('/');
  await page.locator('#tab-diff').click();
  await page.locator('#commit-list [data-value="project"]').click();
  await expect(page.locator('#diff-target-label')).toHaveText('整个项目 (Project)');
  await expect(page.locator('#diff-content')).toContainText('引用边');
  await expect(page.locator('#diff-content')).toContainText('lib/security.js');
  await expect(page.locator('#diff-content')).toContainText('GET /api/health');
  await page.locator('#btn-walkthrough').click();
  await expect.poll(() => payloads.length).toBeGreaterThan(0);
  expect(payloads[0].target).toBe('project');
  expect(payloads[0].focusFile).toBe(null);
});

test('the first answer lists the evidence the model received', async ({ page }) => {
  await fixture(page);
  const evidence = { revision: 'a'.repeat(40), diff: { files: [{ path: 'src/app.js', truncated: false }], omitted: 0 },
    documents: [{ path: 'README.md', truncated: false, ranges: [[1, 12]] }],
    sources: [{ path: 'src/app.js', truncated: true, ranges: [[1, 40], [90, 120]] }], warnings: [], warningCount: 0 };
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream('回答', { evidence }) }));
  await page.goto('/');
  await page.locator('#btn-walkthrough').click();
  const details = page.locator('.evidence-details');
  await expect(details.locator('summary')).toHaveText('本次依据：Diff 1 个文件 · 文档 1 份 · 源码 1 个文件 · 1 处截断');
  await details.locator('summary').click();
  await expect(details.locator('li')).toHaveText(['src/app.js', 'README.md', 'src/app.js：第 1-40, 90-120 行']);
});

test('repository switching and commit rows work from the keyboard', async ({ page }) => {
  await fixture(page);
  await page.route(/\/api\/repos(?:\?.*)?$/, route => route.fulfill({ json: { success: true, repos: [
    { id: 'fixture', name: 'Fixture', path: '/fixture', branch: 'main', dirtyCount: 0 },
    { id: 'second', name: 'Second', path: '/second', branch: 'dev', dirtyCount: 0 }
  ] } }));
  await page.route('**/api/repos/second/commits', route => route.fulfill({ json: { success: true, presets: [], dirtyCount: 0, commits: [
    { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', msg: 'newer', author: 'audit', relTime: 'now' },
    { hash: 'c'.repeat(40), shortHash: 'ccccccc', msg: 'older', author: 'audit', relTime: 'then' }
  ] } }));
  await page.route('**/api/repos/second/diff?*', route => route.fulfill({ json: { success: true, files: [], hasFacts: false } }));
  const diffTargets = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/repos/second/diff') diffTargets.push(url.searchParams.get('target')); });
  await page.goto('/');
  await expect(page.locator('#active-repo-name')).toHaveText('Fixture');

  // The repository picker is a native select, so it is keyboard operable by default.
  await page.locator('#repo-select').focus();
  await expect(page.locator('#repo-select')).toBeFocused();
  await page.locator('#repo-select').selectOption('second');
  await expect(page.locator('#active-repo-name')).toHaveText('Second');

  await page.locator('#tab-diff').click();
  const commitRow = hash => page.locator(`#commit-list [data-value="${hash}"]`);
  await expect(commitRow('b'.repeat(40))).toHaveAttribute('aria-current', 'true');
  await commitRow('c'.repeat(40)).focus();
  await page.keyboard.press('Space');
  await expect(commitRow('c'.repeat(40))).toHaveAttribute('aria-current', 'true');
  await expect(commitRow('c'.repeat(40))).toBeFocused();
  await expect.poll(() => diffTargets.at(-1)).toBe('c'.repeat(40));
});

test('the usage details open from the keyboard and analysis progress reaches screen readers', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream('回答') }));
  await page.goto('/');
  const pill = page.locator('#keeper-token-pill'), popover = page.locator('#keeper-detail-popover');
  await expect(page.locator('#keeper-token-text')).toHaveText('计量不可用');
  await pill.focus();
  await expect(pill).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(popover).toBeVisible();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(pill).toHaveAttribute('aria-expanded', 'false');
  await expect(pill).toBeFocused();
  for (const name of ['刷新所有仓库', '手动输入仓库路径', '清空导师对话']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '向导师追问', exact: true })).toHaveCount(1);
  await page.locator('#btn-walkthrough').click();
  await expect(page.locator('#mentor-live')).toHaveText('导师回答完成');
});

test('both themes keep small text and Mermaid diagrams readable, redrawing diagrams on switch', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mentor-theme', 'light'));
  await fixture(page);
  const diagram = '```mermaid\nsequenceDiagram\n  页面->>服务: 请求分析\n  服务-->>页面: 流式回答\n```';
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream(diagram) }));
  await page.goto('/');
  await page.locator('#btn-walkthrough').click();
  await expect(page.locator('.mermaid svg')).toHaveCount(1);
  for (const theme of ['neutral', 'dark']) {
    if (theme === 'dark') {
      await page.locator('#btn-theme-toggle').click();
      await expect(page.locator('.mermaid')).toHaveAttribute('data-mermaid-theme', 'dark');
      await expect(page.locator('.mermaid svg')).toHaveCount(1);
    }
    const report = await contrastReport(page);
    expect(report['mermaid message text'], `${theme}: mermaid rendered`).toBeDefined();
    for (const [pair, ratio] of Object.entries(report)) expect(ratio, `${theme}: ${pair}`).toBeGreaterThanOrEqual(4.5);
  }
});

test('a diagram Mermaid cannot parse keeps its source instead of an error card', async ({ page }) => {
  await fixture(page);
  const answer = [
    '```mermaid\nflowchart TD\n  A[用户] --> B[getUser()]\n```',
    '```mermaid\nflowchart TD\n  A[代码] --> B[理解]\n```',
    '```mermaid\nerDiagram\n  用户 ||--o{ 订单 : 下单\n```'
  ].join('\n\n');
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream(answer) }));
  await page.goto('/');
  await page.locator('#btn-walkthrough').click();
  // Unquoted parentheses are repaired, so this diagram and the valid one both draw.
  await expect(page.locator('.mermaid svg')).toHaveCount(2);
  // Chinese entity names cannot be repaired: the source stays readable and copyable.
  await expect(page.locator('.mermaid-fallback')).toHaveCount(1);
  await expect(page.locator('.mermaid-fallback pre code')).toHaveText('erDiagram\n  用户 ||--o{ 订单 : 下单');
  await expect(page.locator('.mermaid-fallback')).toContainText('mermaid 未渲染');
  await expect(page.locator('.mermaid-fallback .copy-code-btn')).toHaveCount(1);
});

test('Keeper polling pauses while the page is hidden and refreshes on return', async ({ page }) => {
  await page.clock.install();
  await fixture(page);
  let polls = 0;
  page.on('request', request => { if (request.url().includes('/api/tokens/keeper-stats')) polls++; });
  const setVisibility = state => page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await page.goto('/');
  await expect.poll(() => polls).toBe(1);
  await page.clock.runFor(30000);
  await expect.poll(() => polls).toBe(3);
  await setVisibility('hidden');
  await page.clock.runFor(60000);
  await page.waitForTimeout(300);
  expect(polls).toBe(3);
  await setVisibility('visible');
  await expect.poll(() => polls).toBe(4);
  await page.clock.runFor(15000);
  await expect.poll(() => polls).toBe(5);
});

test('Mermaid loads only when an answer contains a diagram', async ({ page }) => {
  const loaded = [];
  page.on('request', request => { if (request.url().includes('/vendor/mermaid.js')) loaded.push(request.url()); });
  await fixture(page);
  let text = '普通回答';
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream(text) }));
  await page.goto('/');
  await page.locator('#btn-walkthrough').click();
  await expect(page.locator('#mentor-status-bar')).toBeHidden();
  expect(loaded).toHaveLength(0);
  text = '```mermaid\nflowchart TD\nA[代码] --> B[理解]\n```';
  await page.locator('#mentor-input').fill('画一张图');
  await page.locator('#btn-submit-prompt').click();
  await expect(page.locator('.mermaid svg')).toHaveCount(1);
  expect(loaded).toHaveLength(1);
});

test('large Diff pages retain correct line numbers and full copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const patch = 'diff --git a/code.js b/code.js\nnew file mode 100644\n--- /dev/null\n+++ b/code.js\n@@ -0,0 +1,4500 @@\n'
    + Array.from({ length: 4500 }, (_, i) => `+line-${i + 1}`).join('\n') + '\n';
  await fixture(page, { patch }); await page.goto('/');
  await page.locator('#tab-diff').click();
  await expect(page.locator('#diff-content .diff-line')).toHaveCount(2000);
  await page.locator('[data-action="diff-page"]').filter({ hasText: '下一页' }).click();
  await expect(page.locator('#diff-content .diff-num').first()).toHaveText('1996');
  await expect(page.locator('#diff-content .diff-line')).toHaveCount(2000);
  await page.locator('#btn-copy-diff').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('+line-4500');
});

test('stopping a pending analysis terminates loading without retaining an answer', async ({ page }) => {
  await fixture(page); let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/mentor/analyze', async route => { await gate; await route.fulfill({ contentType: 'text/event-stream', body: stream('late answer') }).catch(() => {}); });
  await page.goto('/');
  const pending = page.waitForRequest('**/api/mentor/analyze');
  await page.locator('#btn-walkthrough').click(); await pending;
  await page.locator('#btn-stop-analyze').click();
  await expect(page.locator('#mentor-status-bar')).toBeHidden();
  await expect(page.locator('.mentor-prose')).toContainText('已终止生成');
  release();
  expect(await page.evaluate(() => conversationHistory.length)).toBe(0);
});

test('the splitter resizes both panels, remembers the width and resets on double-click', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream('回答') }));
  await page.goto('/');
  const width = () => page.evaluate(() => Math.round(document.getElementById('diff-panel').getBoundingClientRect().width));
  const splitter = page.locator('#panel-splitter');
  await expect(splitter).toBeVisible();
  expect(await width()).toBe(440);

  const box = await splitter.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const dragged = await width();
  expect(dragged - 440).toBeGreaterThan(60);
  await expect(page.locator('body')).not.toHaveClass(/resizing/);

  // Keyboard nudges by 16 px and keeps focus.
  await splitter.focus();
  await page.keyboard.press('ArrowLeft');
  const nudged = await width();
  expect(nudged).toBe(dragged - 16);
  await expect(splitter).toHaveAttribute('aria-valuenow', String(nudged));

  // The width survives a reload.
  await page.reload();
  await expect.poll(width).toBe(nudged);

  // Double-click restores the responsive default for this viewport.
  await page.locator('#panel-splitter').dblclick();
  await expect.poll(width).toBe(440);
});

test('the splitter stops at its limits and hides in the single-panel layout', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  const width = () => page.evaluate(() => Math.round(document.getElementById('diff-panel').getBoundingClientRect().width));
  const splitter = page.locator('#panel-splitter');
  const box = await splitter.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 2000, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  // 1280 viewport - 230 repos - 7 splitter - 420 mentor = 623
  expect(await width()).toBe(623);

  await splitter.focus();
  await page.keyboard.press('Home');
  expect(await width()).toBe(320);

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(splitter).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(splitter).toBeVisible();
  // The stored preference is re-clamped, not overwritten: 320 is still the width.
  expect(await width()).toBe(320);
});

test('the file tree opens a file with line numbers, filters, and keeps it across view switches', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  const dir = page.locator('#file-tree .tree-row[data-kind="dir"]').first();
  await expect(dir).toContainText('src');
  await dir.click();
  await page.locator('#file-tree .tree-row[data-path="src/app.js"]').click();
  await expect(page.locator('#file-path-label')).toHaveText('src/app.js');
  await expect(page.locator('#file-content .file-line')).toHaveCount(2);
  await expect(page.locator('#file-content .file-num').first()).toHaveText('1');
  await expect(page.locator('#file-content .file-text').first()).toContainText('const value = 1;');
  await expect(page.locator('#file-stat-badge')).toContainText('2 行');

  // Filtering turns the tree into a flat result list.
  await page.locator('#file-filter').fill('util');
  await expect(page.locator('#file-tree .tree-row')).toHaveCount(1);
  await expect(page.locator('#file-tree .tree-row')).toContainText('util.js');
  await page.locator('#file-filter').fill('');

  await page.locator('#tab-diff').click();
  await expect(page.locator('#diff-view')).toBeVisible();
  await expect(page.locator('#file-view')).toBeHidden();
  await page.locator('#tab-file').click();
  await expect(page.locator('#file-content .file-line')).toHaveCount(2);
});

test('a question about the open file is scoped to that file', async ({ page }) => {
  await fixture(page);
  const payloads = [];
  await page.route('**/api/mentor/analyze', route => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'text/event-stream', body: stream('回答') });
  });
  await page.goto('/');
  await page.locator('#file-tree .tree-row[data-kind="dir"]').first().click();
  await page.locator('#file-tree .tree-row[data-path="src/app.js"]').click();
  await expect(page.locator('#file-path-label')).toHaveText('src/app.js');
  await page.locator('#btn-anatomy').click();
  await expect.poll(() => payloads.length).toBeGreaterThan(0);
  expect(payloads[0].target).toBe('file');
  expect(payloads[0].focusFile).toBe('src/app.js');
});

test('selecting lines in the file viewer becomes a question quoting the file and lines', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream('回答') }));
  await page.goto('/');
  await page.locator('#file-tree .tree-row[data-kind="dir"]').first().click();
  await page.locator('#file-tree .tree-row[data-path="src/app.js"]').click();
  await expect(page.locator('#file-content .file-line')).toHaveCount(2);
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#file-content .file-line');
    const range = document.createRange();
    range.setStart(rows[0].querySelector('.file-text'), 0);
    range.setEnd(rows[1].querySelector('.file-text'), 1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await expect(page.locator('#btn-ask-selection')).toBeVisible();
  await page.locator('#btn-ask-selection').click();
  await expect(page.locator('#mentor-input')).toHaveValue(/^关于 src\/app\.js:1-2：\n```javascript\nconst value = 1;/);
});

test('adding a folder opens it without rescanning every repository', async ({ page }) => {
  await fixture(page);
  let listCalls = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/repos') listCalls++; });
  await page.route('**/api/repos/pick', route => route.fulfill({ json: { success: true, path: '/new-repo', repo: {
    id: 'new-repo', name: 'NewRepo', path: '/new-repo', branch: 'main', dirtyCount: 0 } } }));
  await page.route('**/api/repos/new-repo/commits', route => route.fulfill({ json: { success: true, presets: [], dirtyCount: 0, commits: [] } }));
  await page.route('**/api/repos/new-repo/diff?*', route => route.fulfill({ json: { success: true, files: [], hasFacts: false } }));
  await page.goto('/');
  await expect(page.locator('#repo-select')).toHaveValue('fixture');
  const before = listCalls;
  await page.locator('#btn-add-repo').click();
  await expect(page.locator('#active-repo-name')).toHaveText('NewRepo');
  await expect(page.locator('#repo-select')).toHaveValue('new-repo');
  expect(listCalls).toBe(before);
});

test('long lines in the file viewer wrap instead of scrolling sideways', async ({ page }) => {
  await fixture(page);
  await page.route(/\/api\/repos\/[^/]+\/tree$/, route => route.fulfill({ json: { success: true, omitted: 0, files: [
    { path: 'long.js', size: 600, tracked: true }
  ] } }));
  await page.route(/\/api\/repos\/[^/]+\/file\?.*/, route => route.fulfill({ json: { success: true, path: 'long.js',
    text: `const value = '${'x'.repeat(400)}';\n`, lines: 1, bytes: 420 } }));
  await page.goto('/');
  await page.locator('#file-tree .tree-row[data-path="long.js"]').click();
  await expect(page.locator('#file-content .file-line')).toHaveCount(1);
  const metrics = await page.evaluate(() => {
    const row = document.querySelector('#file-content .file-line');
    const scroller = document.querySelector('#file-content').parentElement;
    return {
      whiteSpace: getComputedStyle(row.querySelector('.file-text')).whiteSpace,
      overflow: scroller.scrollWidth - scroller.clientWidth,
      height: Math.round(row.getBoundingClientRect().height)
    };
  });
  expect(metrics.whiteSpace).toBe('pre-wrap');
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.height).toBeGreaterThan(20);
});

test('a reload restores the repository, the open file, the tree state and the conversation', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream',
    body: stream('上次的回答内容', { requestedTarget: 'file', focusFile: 'src/app.js', instruction: '核心代码实相' }) }));
  await page.goto('/');
  await page.locator('#file-tree .tree-row[data-kind="dir"]').first().click();
  await page.locator('#file-tree .tree-row[data-path="src/app.js"]').click();
  await expect(page.locator('#file-path-label')).toHaveText('src/app.js');
  await page.locator('#btn-anatomy').click();
  await expect(page.locator('.mentor-prose')).toContainText('上次的回答内容');

  await page.reload();
  await expect(page.locator('#active-repo-name')).toHaveText('Fixture');
  await expect(page.locator('#repo-select')).toHaveValue('fixture');
  await expect(page.locator('#file-path-label')).toHaveText('src/app.js');
  await expect(page.locator('#file-content .file-line')).toHaveCount(2);
  // The tree is still expanded where it was left.
  await expect(page.locator('#file-tree .tree-row[data-path="src/app.js"]')).toBeVisible();
  await expect(page.locator('.mentor-prose')).toContainText('上次的回答内容');
  await expect(page.locator('#mentor-scope-text')).toContainText('讨论范围：app.js');
});

test('a reload shows the file before the repository scan finishes', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body: stream('回答') }));
  let slowList = false;
  await page.route(/\/api\/repos(?:\?.*)?$/, async route => {
    if (slowList) await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fallback();
  });
  await page.goto('/');
  await page.locator('#file-tree .tree-row[data-kind="dir"]').first().click();
  await page.locator('#file-tree .tree-row[data-path="src/app.js"]').click();
  await expect(page.locator('#file-path-label')).toHaveText('src/app.js');

  slowList = true;
  await page.reload();
  // The file and the picker come from storage, not from the slow scan.
  await expect(page.locator('#file-path-label')).toHaveText('src/app.js', { timeout: 1000 });
  await expect(page.locator('#repo-select')).toHaveValue('fixture', { timeout: 5000 });
});
