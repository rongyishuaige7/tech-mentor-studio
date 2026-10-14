import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { fixture } from './fixture.js';

function stream(text) {
  return [{ type: 'snapshot', snapshotId: 'browser-snapshot', resolvedTarget: 'a'.repeat(40) }, { type: 'chunk', text }, { type: 'finished' }]
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
  expect(await page.evaluate(() => mentorSnapshotId)).toBeNull();
  expect(await page.evaluate(() => conversationHistory.length)).toBe(0);
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
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
