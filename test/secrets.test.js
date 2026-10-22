import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitFixture } from './git-helper.js';
import { appFixture } from './http-helper.js';
import { isSensitiveFile } from '../lib/security.js';
import { gitleaksScanner, redactFindings } from '../lib/secrets.js';

const completion = () => new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n');
const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const hasGitleaks = (() => { try { execFileSync('gitleaks', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const analyzeWith = request => (root, body = {}) => request('/api/mentor/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ repoPath: root, target: 'working-tree', mode: 'anatomy', ...body }) });

test('common secret files are excluded by name, ordinary files are not', () => {
  for (const name of ['.env', '.env.local', '.envrc', 'deploy/.envrc', '.git-credentials', 'auth.json', 'terraform.tfvars', 'prod.auto.tfvars',
    '.pgpass', '.htpasswd', 'config/secrets.yaml', 'secrets.json', 'gcp-service-account.json', 'service_account.json', 'vault.kdbx', 'release.jks']) {
    assert.equal(isSensitiveFile(name), true, name);
  }
  for (const name of ['src/auth.js', 'docs/secrets.md', 'environment.ts', 'lib/credentialsView.tsx', 'accounts.json', 'README.md']) {
    assert.equal(isSensitiveFile(name), false, name);
  }
});

test('redaction replaces every occurrence, the longer value first', () => {
  const findings = [{ rule: 'short', secret: 'abcdef' }, { rule: 'long', secret: 'abcdef123456' }];
  assert.equal(redactFindings('x=abcdef123456 y=abcdef abcdef', findings), 'x=[REDACTED:long] y=[REDACTED:short] [REDACTED:short]');
});

const SECRET = 'fixture-flagged-value-0001';
const flagging = async text => ({ available: true, findings: text.includes(SECRET) ? [{ rule: 'fixture-rule', secret: SECRET }] : [] });

test('flagged values are replaced in the snapshot, the question and the history before the model sees them', async t => {
  const { root, write, commit } = gitFixture(t);
  write('code.js', 'old\n'); commit('first'); write('code.js', `const token = "${SECRET}";\n`);
  const payloads = [];
  const { request } = await appFixture(t, root, { secretScanner: flagging,
    fetchImpl: async (url, options) => { payloads.push(options.body); return completion(); } });
  await request('/api/repos');
  const analyze = analyzeWith(request);
  const first = events(await (await analyze(root)).text()).find(event => event.type === 'snapshot');
  assert.deepEqual(first.evidence.secretScan, { available: true, redacted: 1, rules: ['fixture-rule'] });
  assert.equal(payloads[0].includes(SECRET), false);
  assert.match(payloads[0], /\[REDACTED:fixture-rule\]/);
  const follow = events(await (await analyze(root, { snapshotId: first.snapshotId, customPrompt: `why ${SECRET}?`,
    history: [{ role: 'user', content: `earlier ${SECRET}` }, { role: 'assistant', content: 'answer' }] })).text());
  const snapshot = follow.find(event => event.type === 'snapshot');
  assert.equal(snapshot.promptRedacted, 1);
  assert.equal(snapshot.instruction, 'why [REDACTED:fixture-rule]?');
  assert.equal(payloads[1].includes(SECRET), false);
  assert.ok(follow.some(event => event.type === 'finished'));
});

test('a failing scan stops the request before anything reaches the model', async t => {
  const { root, write, commit } = gitFixture(t);
  write('code.js', 'old\n'); commit('first'); write('code.js', 'new\n');
  let called = false;
  const { request } = await appFixture(t, root, {
    secretScanner: async () => { throw Object.assign(new Error('密钥扫描失败，未发送给模型'), { status: 502 }); },
    fetchImpl: async () => { called = true; return completion(); } });
  await request('/api/repos');
  const result = events(await (await analyzeWith(request)(root)).text());
  assert.equal(result.find(event => event.type === 'error')?.message, '密钥扫描失败，未发送给模型');
  assert.equal(result.some(event => event.type === 'snapshot'), false);
  assert.equal(called, false);
});

test('without gitleaks the scan reports itself unavailable instead of failing', async () => {
  assert.deepEqual(await gitleaksScanner({ binary: '/nonexistent/gitleaks-for-test' })('anything'), { available: false, findings: [] });
});

test('real gitleaks redacts a key the repository tries to allowlist', { skip: !hasGitleaks && 'gitleaks not installed' }, async t => {
  // Built at run time so this file holds no secret-shaped literal.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const key = Array.from({ length: 32 }, (_, i) => alphabet[(i * 37 + 11) % alphabet.length]).join('');
  const { root, write, commit } = gitFixture(t);
  write('.gitleaks.toml', `[extend]\nuseDefault = true\n[allowlist]\nregexes = ['''${key}''']\n`);
  write('code.js', `const client = new Client({ api_key: "${key}" }); // gitleaks:allow\nexport default client;\n`);
  commit('base');
  fs.appendFileSync(path.join(root, 'code.js'), 'export const changed = true;\n');
  const payloads = [];
  const { request } = await appFixture(t, root, { secretScanner: gitleaksScanner(),
    fetchImpl: async (url, options) => { payloads.push(options.body); return completion(); } });
  await request('/api/repos');
  const snapshot = events(await (await analyzeWith(request)(root)).text()).find(event => event.type === 'snapshot');
  assert.equal(snapshot.evidence.secretScan.available, true);
  assert.ok(snapshot.evidence.secretScan.redacted >= 1);
  assert.equal(payloads[0].includes(key), false);
});
