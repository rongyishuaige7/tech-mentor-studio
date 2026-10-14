import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

async function query(database, sql) {
  const { stdout } = await execute('sqlite3', ['-readonly', '-json', database, sql], { timeout: 3000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout || '[]');
}

function parseDate(value) {
  if (!value) return NaN;
  const text = String(value).replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : text + 'Z');
}

export async function getKeeperStats(database, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const [usage, quotas] = await Promise.all([
    query(database, `SELECT COALESCE(ui.provider, 'other') AS provider,
      SUM(s.total_tokens) AS tokens, SUM(s.request_count) AS requests
      FROM usage_overview_daily_stats s LEFT JOIN usage_identities ui ON ui.identity = s.auth_index
      WHERE s.bucket_start LIKE '${today}%' GROUP BY ui.provider;`),
    query(database, `WITH latest_account AS (
      SELECT qc.auth_index FROM quota_cycles qc JOIN quota_percent_segments qps ON qps.cycle_id = qc.id
      WHERE qc.provider = 'codex' ORDER BY julianday(qps.last_observed_at) DESC, qps.id DESC LIMIT 1
    ), ranked AS (
      SELECT qc.quota_key, qc.window_seconds, qc.reset_at, qps.remaining_percent, qps.last_observed_at,
        ROW_NUMBER() OVER (PARTITION BY qc.quota_key, qc.window_seconds
          ORDER BY julianday(qps.last_observed_at) DESC, qps.id DESC) AS rank
      FROM quota_cycles qc JOIN quota_percent_segments qps ON qps.cycle_id = qc.id
      JOIN latest_account la ON qc.auth_index = la.auth_index WHERE qc.provider = 'codex'
    ) SELECT * FROM ranked WHERE rank = 1 ORDER BY window_seconds, quota_key;`)
  ]);
  const stats = { today, timezone: 'UTC', antigravity: { tokens: 0, requests: 0 }, codex: { tokens: 0, requests: 0 }, claude: { tokens: 0, requests: 0 } };
  for (const row of usage) {
    const name = String(row.provider).toLowerCase();
    const group = /antigravity|gemini/.test(name) ? 'antigravity' : /codex|openai/.test(name) ? 'codex' : /claude/.test(name) ? 'claude' : null;
    if (group) for (const key of ['tokens', 'requests']) stats[group][key] += Math.max(0, Number(row[key]) || 0);
  }
  const rateLimits = quotas.map(row => {
    const reset = parseDate(row.reset_at), expired = Number.isFinite(reset) && reset <= now.getTime();
    const raw = row.remaining_percent === null ? NaN : Number(row.remaining_percent);
    const remaining = expired || !Number.isFinite(reset) || !Number.isFinite(raw) ? null : Math.max(0, Math.min(100, raw));
    const seconds = Number(row.window_seconds);
    const label = seconds === 18000 ? '5h' : seconds === 604800 ? '7d' : seconds >= 86400 ? `${seconds / 86400}d` : `${seconds / 3600}h`;
    return { key: row.quota_key, label, remainingPercent: remaining, usedPercent: remaining === null ? null : 100 - remaining,
      resetAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null, isExpired: expired,
      observedAt: row.last_observed_at, state: expired ? 'awaiting-update' : remaining === null ? 'unknown' : 'observed' };
  });
  return { stats, rateLimits };
}
