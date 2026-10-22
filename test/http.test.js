import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { gitFixture, gitSpawnCounter } from './git-helper.js';
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

test('a repository scan starts at most three git processes per repository, two once verified', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-scan-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', ...args], { cwd });
  for (let i = 0; i < 4; i++) {
    const repo = path.join(parent, `repo${i}`); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.js'), 'a\n');
    if (i < 3) { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'first'); } // repo3 stays unborn
  }
  const { request } = await appFixture(t, parent, { dataDir: path.join(parent, '.mentor-data'), scanRoots: [parent] });
  const count = gitSpawnCounter(t);
  const first = await count(async () => (await request('/api/repos?refresh=1')).json());
  assert.equal(first.result.repos.length, 4);
  assert.ok(first.spawns <= 3 * 4, `first scan started ${first.spawns} git processes`);
  const second = await count(async () => (await request('/api/repos?refresh=1')).json());
  assert.ok(second.spawns <= 2 * 4, `second scan started ${second.spawns} git processes`);
  assert.deepEqual(second.result.repos.map(repo => repo.dirtyCount).sort(), [0, 0, 0, 1]);
  assert.ok(second.result.repos.filter(repo => repo.lastCommit).every(repo => repo.lastCommit.msg === 'first'));
});

test('concurrent refreshes share one scan, and a corrupt watchlist is reported without being rewritten', async t => {
  const { root } = gitFixture(t);
  const dataDir = path.join(root, '.git', 'mentor-test-data');
  const { request } = await appFixture(t, root, { dataDir });
  await request('/api/repos?refresh=1'); // registers and verifies the repository
  const count = gitSpawnCounter(t, { delay: 0.2 }); // a scan takes > 0.4 s, so the requests overlap
  const single = await count(async () => (await request('/api/repos?refresh=1')).json());
  const both = await count(() => Promise.all([1, 2].map(async () => (await request('/api/repos?refresh=1')).json())));
  assert.deepEqual(both.result.map(body => body.repos.length), [1, 1]);
  assert.equal(both.spawns, single.spawns, `two concurrent refreshes started ${both.spawns} git processes, one started ${single.spawns}`);
  fs.writeFileSync(path.join(dataDir, 'watchlist.json'), '{broken');
  const response = await request('/api/repos?refresh=1');
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /关注列表无法读取/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'watchlist.json'), 'utf8'), '{broken');
});

test('the diff response carries each patch once, in files', async t => {
  const { root, write, commit } = gitFixture(t); write('code.js', 'old\n'); commit('first'); write('code.js', 'new\n');
  const { request } = await appFixture(t, root);
  const { repos } = await (await request('/api/repos')).json();
  const diff = await (await request(`/api/repos/${repos[0].id}/diff?target=working-tree`)).json();
  assert.equal(Object.hasOwn(diff, 'diffText'), false);
  assert.match(diff.files[0].patch, /\+new/);
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

test('an unreadable scan root is skipped without hiding valid repositories', async t => {
  const { root, write } = gitFixture(t); write('README.md', '# test\n');
  const fileRoot = path.join(root, 'not-a-directory');
  fs.writeFileSync(fileRoot, 'not a directory\n');
  const { request } = await appFixture(t, root, { scanRoots: [fileRoot, root] });
  const data = await (await request('/api/repos')).json();
  assert.equal(data.success, true);
  assert.equal(data.repos.some(repo => repo.path === fs.realpathSync(root)), true);
});

test('configured credentials are redacted from repository and commit metadata', async t => {
  const { root, write, commit } = gitFixture(t);
  write('a.js', 'a\n'); commit('fixture-only appears in subject');
  const { request } = await appFixture(t, root);
  const repos = await (await request('/api/repos')).json();
  assert.equal(JSON.stringify(repos).includes('fixture-only'), false);
  assert.match(JSON.stringify(repos), /REDACTED/);
  const commits = await (await request(`/api/repos/${repos.repos[0].id}/commits`)).json();
  assert.equal(JSON.stringify(commits).includes('fixture-only'), false);
  assert.match(JSON.stringify(commits), /REDACTED/);
});

test('a directory picker that times out answers 504 instead of hanging', async t => {
  const { root } = gitFixture(t);
  const { request } = await appFixture(t, root, { pickTimeoutMs: 50, pickDirectoryImpl: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) });
  const response = await request('/api/repos/pick', { method: 'POST' });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /目录选择超时/);
});

test('the diff route serves a whole-project overview instead of a diff', async t => {
  const { root, write, commit } = gitFixture(t);
  write('package.json', JSON.stringify({ name: 'demo', main: 'server.js', dependencies: { express: '1.0.0' } }, null, 2));
  write('server.js', "import express from 'express';\napp.get('/api/health', (req, res) => res.end());\n");
  commit('first');
  const { request } = await appFixture(t, root);
  const repos = await (await request('/api/repos')).json();
  const response = await request(`/api/repos/${repos.repos[0].id}/diff?target=project`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.target, 'project');
  assert.equal(body.resolvedTarget.length, 40);
  assert.ok(body.project.stats.files >= 2);
  assert.match(body.project.tree, /server\.js/);
  assert.match(body.project.endpoints, /GET \/api\/health/);
  assert.deepEqual(body.project.deps, { express: '1.0.0' });
  assert.ok(Array.isArray(body.project.entryPoints) && body.project.entryPoints.includes('server.js'));
});

test('the file routes list the working tree and return file contents', async t => {
  const { root, write, commit } = gitFixture(t);
  write('src/app.js', 'const a = 1;\n');
  write('README.md', '# demo\n');
  commit('first');
  write('src/new.js', 'export const b = 2;\n');

  const { request } = await appFixture(t, root);
  const repos = await (await request('/api/repos')).json();
  const id = repos.repos[0].id;

  const tree = await (await request(`/api/repos/${id}/tree`)).json();
  assert.equal(tree.success, true);
  assert.ok(tree.files.some(file => file.path === 'src/new.js' && file.tracked === false));
  assert.ok(tree.files.some(file => file.path === 'src/app.js' && file.tracked === true));

  const file = await (await request(`/api/repos/${id}/file?path=src%2Fapp.js`)).json();
  assert.equal(file.success, true);
  assert.match(file.text, /const a = 1/);
  assert.equal(file.lines, 1);

  assert.equal((await request(`/api/repos/${id}/file?path=../secret`)).status, 400);
  assert.equal((await request(`/api/repos/${id}/file`)).status, 400);
});

test('adding a repository updates the scan cache instead of rescanning everything', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-add-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', ...args], { cwd });
  const makeRepo = name => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'first');
    return dir;
  };
  const first = makeRepo('first');
  const { request } = await appFixture(t, first, { scanRoots: [parent], dataDir: path.join(parent, '.data') });
  const initial = await (await request('/api/repos')).json();
  assert.deepEqual(initial.repos.map(repo => repo.name), ['first']);

  // A repository created after the scan is added through the route.
  const second = makeRepo('second');
  const added = await (await request('/api/repos/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetPath: second })
  })).json();
  assert.equal(added.success, true);
  assert.equal(added.repo.name, 'second');
  assert.equal(added.repo.branch, 'main');

  const count = gitSpawnCounter(t);
  const listed = await count(async () => (await request('/api/repos')).json());
  assert.equal(listed.spawns, 0, `a cache hit started ${listed.spawns} git processes`);
  assert.deepEqual(listed.result.repos.map(repo => repo.name).sort(), ['first', 'second']);
});
