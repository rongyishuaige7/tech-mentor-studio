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
  await page.locator('[data-action="repo"]').click();
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
  await page.locator('[data-action="panel"][data-value="diff"]').click(); await page.locator('[data-action="focus"]').click();
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
  await page.locator('#btn-walkthrough').click();
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
