import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gitFixture } from './git-helper.js';
import { appFixture } from './http-helper.js';

test('HTTP selection supports unborn diff, registered IDs and JSON errors', async t => {
  const { root, write } = gitFixture(t); write('新目录/new.js', 'new\n');
  const { request } = await appFixture(t, root);
  const repos = await (await request('/api/repos')).json();
  assert.equal(repos.repos.length, 1);
  const id = repos.repos[0].id;
  const diffResponse = await request(`/api/repos/${id}/diff?target=working-tree`);
  assert.equal(diffResponse.status, 200);
  const diff = await diffResponse.json();
  assert.equal(diff.files[0].path, '新目录/new.js');
  const badTarget = await request(`/api/repos/${id}/diff?target=--help`);
  assert.equal(badTarget.status, 400);
  const malformed = await request('/api/repos/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
});

test('HTTP pick directory supports selection, cancel, non-git and unsupported platforms', async t => {
  const { root, write } = gitFixture(t); write('README.md', '# test\n');
  let mockResult = { canceled: false, path: root };
  const { request } = await appFixture(t, root, {
    pickDirectoryImpl: async () => mockResult
  });

  // 1. Successful pick of git repo
  const okRes = await request('/api/repos/pick', { method: 'POST' });
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.equal(okData.success, true);
  assert.equal(okData.path, fs.realpathSync(root));

  // 2. Canceled pick
  mockResult = { canceled: true };
  const cancelRes = await request('/api/repos/pick', { method: 'POST' });
  assert.equal(cancelRes.status, 200);
  const cancelData = await cancelRes.json();
  assert.equal(cancelData.success, true);
  assert.equal(cancelData.canceled, true);

  // 3. Pick non-git directory
  mockResult = { canceled: false, path: '/tmp' };
  const nonGitRes = await request('/api/repos/pick', { method: 'POST' });
  assert.equal(nonGitRes.status, 400);
  const nonGitData = await nonGitRes.json();
  assert.equal(nonGitData.success, false);
  assert.match(nonGitData.error, /不是有效的 Git 仓库/);

  // 4. Unsupported platform error
  const unsupportedError = new Error('not supported');
  unsupportedError.status = 501;
  const { request: unsupportedRequest } = await appFixture(t, root, {
    pickDirectoryImpl: async () => { throw unsupportedError; }
  });
  const unsuppRes = await unsupportedRequest('/api/repos/pick', { method: 'POST' });
  assert.equal(unsuppRes.status, 501);
  const unsuppData = await unsuppRes.json();
  assert.equal(unsuppData.unsupported, true);
});

test('HTTP stream emits a single completion and forwards cancellation signal', async t => {
  const { root, write, commit } = gitFixture(t); write('code.js', 'old\n'); const target = commit('first');
  let signal;
  const { request } = await appFixture(t, root, { fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n');
  } });
  await request('/api/repos');
  const response = await request('/api/mentor/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath: root, target }) });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal((body.match(/"type":"finished"/g) || []).length, 1);
  assert.equal(body.includes('"type":"done"'), false);
  assert.ok(signal instanceof AbortSignal);
});

test('closing the HTTP client aborts a pending upstream fetch', async t => {
  const { root, write, commit } = gitFixture(t); write('code.js', 'code\n'); const target = commit('first');
  let upstreamStarted, upstreamAborted;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  const aborted = new Promise(resolve => { upstreamAborted = resolve; });
  const { request } = await appFixture(t, root, { fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    upstreamStarted();
    options.signal.addEventListener('abort', () => { upstreamAborted(); reject(new DOMException('Aborted', 'AbortError')); });
  }) });
  await request('/api/repos');
  const controller = new AbortController();
  const pending = request('/api/mentor/analyze', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath: root, target }) }).then(response => response.text()).catch(() => {});
  await Promise.race([started, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('upstream request did not start')), 5000); timer.unref(); })]);
  controller.abort();
  await Promise.race([aborted, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('upstream cancellation did not arrive')), 2000); timer.unref(); })]);
  await pending;
});
