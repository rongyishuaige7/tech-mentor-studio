import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitFixture } from './git-helper.js';
import { appFixture } from './http-helper.js';
import { getKeeperStats } from '../lib/keeper.js';
import { loadClient } from './client-helper.js';

test('Keeper selects distinct latest windows, retains decimals and marks expired data unknown', async t => {
  const { root } = gitFixture(t);
  const db = path.join(root, 'quota fixture.db');
  execFileSync('sqlite3', [db], { input: `
    CREATE TABLE usage_identities(identity TEXT, provider TEXT);
    CREATE TABLE usage_overview_daily_stats(bucket_start TEXT, auth_index TEXT, total_tokens INT, request_count INT);
    CREATE TABLE quota_cycles(id INT, provider TEXT, auth_index TEXT, quota_key TEXT, window_seconds INT, reset_at TEXT);
    CREATE TABLE quota_percent_segments(id INT, cycle_id INT, remaining_percent REAL, last_observed_at TEXT);
    INSERT INTO usage_identities VALUES ('a', 'codex');
    INSERT INTO usage_overview_daily_stats VALUES ('2026-10-13 01:00:00', 'a', 100, 2);
    INSERT INTO quota_cycles VALUES (1,'codex','a','primary',18000,'2026-10-14 00:00:00'),
      (2,'codex','a','secondary',604800,'2026-10-12 00:00:00'),
      (3,'codex','old-account','primary',18000,'2026-10-14 00:00:00');
    INSERT INTO quota_percent_segments VALUES (1,1,80,'2026-10-13 01:00:00'),
      (2,2,10,'2026-10-13 02:00:00'), (3,1,70.5,'2026-10-13 03:00:00'),
      (4,1,60.25,'2026-10-13 04:00:00'), (5,3,99,'2026-10-12 01:00:00');` });
  const data = await getKeeperStats(db, new Date('2026-10-13T12:00:00Z'));
  assert.equal(data.stats.codex.tokens, 100);
  assert.deepEqual(data.rateLimits.map(r => r.label), ['5h', '7d']);
  assert.equal(data.rateLimits[0].remainingPercent, 60.25);
  assert.equal(data.rateLimits[1].remainingPercent, null);
  assert.equal(data.rateLimits[1].state, 'awaiting-update');
});

test('model API distinguishes failure, missing configuration and empty results without fallback', async t => {
  const { root } = gitFixture(t);
  for (const [options, status, message] of [
    [{ proxyKey: '' }, 503, /配置/],
    [{ fetchImpl: async () => new Response('', { status: 401 }) }, 502, /认证/],
    [{ fetchImpl: async () => Response.json({ data: [] }) }, 503, /可用模型/],
    [{ fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }, 502, /超时/]
  ]) {
    const { request } = await appFixture(t, root, options);
    const response = await request('/api/models');
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.success, false); assert.deepEqual(body.models, []); assert.match(body.error, message);
  }
  let called;
  const { request } = await appFixture(t, root, { proxyUrl: 'http://127.0.0.1:9999/v1/chat/completions', fetchImpl: async url => {
    called = url; return Response.json({ data: [{ id: 'model-a' }, { id: 'model-a' }, {}] });
  } });
  const data = await (await request('/api/models')).json();
  assert.equal(called, 'http://127.0.0.1:9999/v1/models');
  assert.deepEqual(data.models, [{ id: 'model-a', name: 'model-a' }]);
  assert.equal((await request('/api/tokens/keeper-stats')).status, 503);
});

test('client visibly disables analysis on model failure and recovers on retry', async () => {
  let fail = true;
  const client = loadClient(async () => Response.json(fail ? { success: false, error: '认证失败' }
    : { success: true, models: [{ id: 'm', name: 'Model' }] }));
  await client.context.loadModels();
  assert.equal(client.get('modelsReady'), false);
  assert.equal(client.nodes.get('btn-walkthrough').disabled, true);
  assert.match(client.nodes.get('model-status').textContent, /认证失败/);
  fail = false; await client.context.loadModels();
  assert.equal(client.get('modelsReady'), true);
  assert.equal(client.nodes.get('btn-walkthrough').disabled, false);
});
