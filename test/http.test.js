import test from 'node:test';
import assert from 'node:assert/strict';
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
