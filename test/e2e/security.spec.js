import { test, expect } from '@playwright/test';

import { fixture } from './fixture.js';

test('local resources, literal filenames and sanitized model output work under CSP', async ({ page }) => {
  const errors = []; const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(process.env.MENTOR_TEST_URL || 'http://127.0.0.1:3301').origin) external.push(request.url()); });
  await fixture(page);
  const text = '<img src="/missing-audit-image" onerror="window.__auditExecuted=1">\n'
    + '<button data-action="ask" data-value="injected">invalid action</button>\n\n'
    + '```js\nconst value = 1;\n```\n\n```mermaid\nflowchart TD\nA[代码] --> B[理解]\n```';
  await page.route('**/api/mentor/analyze', route => route.fulfill({ contentType: 'text/event-stream', body:
    [{ type: 'chunk', text }, { type: 'done' }, { type: 'finished' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  }));
  await page.goto('/');
  await expect(page.locator('[data-action="focus"]')).toHaveCount(1);
  await page.locator('[data-action="focus"]').click();
  expect(await page.evaluate(() => window.__auditExecuted)).toBeUndefined();
  await page.locator('#btn-walkthrough').click();
  await expect(page.locator('.mermaid svg')).toHaveCount(1);
  await expect(page.locator('.copy-code-btn')).toHaveCount(1);
  await expect(page.locator('#mentor-status-bar')).toBeHidden();
  expect(await page.evaluate(() => conversationHistory.length)).toBe(1);
  expect(await page.locator('.mentor-prose [onerror]').count()).toBe(0);
  expect(await page.locator('.mentor-prose [data-action]').count()).toBe(0);
  expect(await page.evaluate(() => window.__auditExecuted)).toBeUndefined();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('HTTP API rejects cross-origin requests, missing sessions and forged repo IDs', async ({ request }) => {
  const crossOrigin = await request.get('/api/session', { headers: { Origin: 'https://audit.invalid' } });
  expect(crossOrigin.status()).toBe(403);
  const missing = await request.get('/api/repos');
  expect(missing.status()).toBe(401);
  const session = await request.get('/api/session');
  const { token } = await session.json();
  const forged = Buffer.from('/Users/rongyi/Desktop/tech-mentor-studio/public').toString('base64url');
  const result = await request.get(`/api/repos/${forged}/commits`, { headers: { 'X-Local-Token': token } });
  expect(result.status()).toBe(404);
});
