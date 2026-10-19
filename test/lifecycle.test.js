import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { relayCompletion, requestLifecycle, readSSE } from '../lib/stream.js';
import { loadClient, eventResponse, keeperResponse } from './client-helper.js';

test('CPA completion forwards usage and exactly one terminal event', async () => {
  const events = [];
  const body = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n'
    + 'data: {"usage":{"total_tokens":12}}\n\n'
    + 'data: [DONE]\n\n';
  await relayCompletion(new Response(body), event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ['chunk', 'usage', 'finished']);
  assert.equal(events[0].text, '你好');
});

test('SSE accepts fragmented UTF-8 and multi-line data', async () => {
  const bytes = new TextEncoder().encode('data: 中\ndata: 文\n\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events = [];
  for await (const data of readSSE(stream)) events.push(data);
  assert.deepEqual(events, ['中\n文']);
});

test('incomplete upstream answer does not report success', async () => {
  await assert.rejects(relayCompletion(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {}), /中断/);
});

test('client disconnect aborts upstream lifecycle and removes its listener', () => {
  const res = new EventEmitter();
  const lifecycle = requestLifecycle(res, 1000);
  res.emit('close');
  assert.equal(lifecycle.signal.aborted, true);
  lifecycle.dispose();
  assert.equal(res.listenerCount('close'), 0);
});

test('both legacy terminal events store one answer and one set of follow-ups', async () => {
  const { context, nodes, get } = loadClient(url => url === '/api/mentor/analyze'
    ? Promise.resolve(eventResponse([{ type: 'chunk', text: 'answer' }, { type: 'done' }, { type: 'finished' }]))
    : keeperResponse());
  await context.startMentorAnalysis('walkthrough', '', true);
  assert.equal(get('conversationHistory.length'), 1);
  assert.equal(get('conversationHistory[0].content'), 'answer');
  assert.equal([...nodes.values()].find(node => node.id.startsWith('footer-')).children.length, 1);
});

test('error event terminates loading without saving a failed answer', async () => {
  const { context, nodes, get } = loadClient(() => Promise.resolve(eventResponse([{ type: 'error', message: 'unavailable' }])));
  await context.startMentorAnalysis('walkthrough', '', true);
  assert.equal(nodes.get('mentor-status-bar').classList.contains('hidden'), true);
  assert.equal(get('conversationHistory.length'), 0);
});

test('cleared session cannot be repopulated by an old response', async () => {
  let output;
  const stream = new ReadableStream({ start(controller) { output = controller; } });
  const { context, get } = loadClient(url => url === '/api/mentor/analyze'
    ? Promise.resolve(new Response(stream)) : keeperResponse());
  const pending = context.startMentorAnalysis('walkthrough', '', true);
  await new Promise(resolve => setImmediate(resolve));
  context.clearMentorSession();
  output.enqueue(new TextEncoder().encode('data: {"type":"finished"}\n\n'));
  output.close();
  await pending;
  assert.equal(get('conversationHistory.length'), 0);
});

test('old finally cannot erase the replacement request stop controller', async () => {
  const pending = [];
  const { context, get } = loadClient((url, options) => {
    if (url !== '/api/mentor/analyze') return keeperResponse();
    return new Promise((resolve, reject) => {
      pending.push({ resolve, signal: options.signal });
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  });
  const first = context.startMentorAnalysis('walkthrough');
  await new Promise(resolve => setImmediate(resolve));
  const second = context.startMentorAnalysis('anatomy');
  await first;
  assert.equal(get('currentAbortController !== null'), true);
  context.stopMentorAnalysis();
  await second;
  assert.equal(pending[1].signal.aborted, true);
});

test('out of order diff response cannot replace the current repository', async () => {
  const pending = [];
  const { context, get } = loadClient(() => new Promise(resolve => pending.push(resolve)));
  const first = context.fetchDiff('A', 'commitA');
  await new Promise(resolve => setImmediate(resolve));
  const second = context.fetchDiff('B', 'commitB');
  await new Promise(resolve => setImmediate(resolve));
  const response = file => ({ json: async () => ({ success: true, files: [{ path: file, patch: 'patch', additions: 1, deletions: 0 }], diffText: 'patch' }) });
  pending[1](response('B.js')); await second;
  pending[0](response('A.js')); await first;
  assert.equal(get('currentDiffFiles[0].path'), 'B.js');
});

test('diff renderer treats plus/minus prefixes inside hunks as code and numbers them', () => {
  const { context } = loadClient(keeperResponse);
  const html = context.renderFormattedDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2 +3 @@\n---old\n+++new\n');
  assert.match(html, /diff-line-del.*diff-num">2<.*---old/);
  assert.match(html, /diff-line-add.*diff-num">3<.*\+\+\+new/);
});

test('follow-up payload keeps the requested target instead of the resolved revision', async () => {
  const bodies = [];
  const { context } = loadClient((url, options) => {
    if (url === '/api/mentor/analyze') {
      bodies.push(JSON.parse(options.body));
      return Promise.resolve(eventResponse([
        { type: 'snapshot', snapshotId: 'snap', requestedTarget: 'HEAD', resolvedTarget: 'a'.repeat(40) },
        { type: 'chunk', text: 'answer' }, { type: 'finished' }
      ]));
    }
    return keeperResponse();
  });
  await context.startMentorAnalysis('walkthrough', '', true);
  await context.startMentorAnalysis('custom', 'why', false);
  assert.equal(bodies[0].target, 'HEAD');
  assert.equal(bodies[1].target, 'HEAD');
  assert.equal(bodies[1].snapshotId, 'snap');
  assert.equal(bodies[1].history.length, 1);
});

test('viewing another file keeps the conversation and its scope; switching target parks it', async () => {
  const bodies = [];
  const { context, get, nodes } = loadClient((url, options) => {
    if (url === '/api/mentor/analyze') {
      bodies.push(JSON.parse(options.body));
      return Promise.resolve(eventResponse([
        { type: 'snapshot', snapshotId: 'snap', requestedTarget: 'HEAD', resolvedTarget: 'HEAD' },
        { type: 'chunk', text: 'answer' }, { type: 'finished' }
      ]));
    }
    if (url.includes('/diff')) return Promise.resolve({ json: async () => ({ success: true, files: [], diffText: '' }) });
    return keeperResponse();
  });
  await context.startMentorAnalysis('walkthrough', '', true);
  context.setFocusFile('src/file.js');
  assert.equal(get('conversationHistory.length'), 1);
  assert.equal(get('mentorSnapshotId'), 'snap');
  assert.equal(nodes.get('mentor-scope-text').textContent, '讨论范围：全部文件');
  assert.equal(nodes.get('btn-scope-new').textContent, '针对 file.js 新开对话');
  await context.startMentorAnalysis('custom', 'why', false);
  assert.equal(bodies[1].focusFile, null);
  assert.equal(bodies[1].snapshotId, 'snap');

  context.selectTarget('other');
  assert.equal(get('conversationHistory.length'), 0);
  assert.equal(get('mentorSnapshotId'), null);
  context.selectTarget('HEAD');
  assert.equal(get('conversationHistory.length'), 3);
  assert.equal(get('mentorSnapshotId'), 'snap');
});

test('returning to a repository restores its target, viewed file and that target\'s conversation', async () => {
  const { context, get, run } = loadClient(url => {
    if (url === '/api/repos/B/commits') return Promise.resolve({ json: async () => ({
      success: true, presets: [], dirtyCount: 1,
      commits: [{ hash: 'C1', shortHash: 'C1', msg: 'one', author: 'T', relTime: 'now' }]
    }) });
    if (url.includes('/api/repos/B/diff')) return Promise.resolve({ json: async () => ({
      success: true, files: [{ path: 'file.js', patch: 'diff --git a/file.js b/file.js\n+code\n', additions: 1, deletions: 0 }],
      diffText: 'diff --git a/file.js b/file.js\n+code\n', statText: '1 个文件，+1 / -0'
    }) });
    return keeperResponse();
  });
  run("activeRepo = { id: 'A', name: 'A', path: '/repo/A' };"
    + "lastRepoView.set('B', { target: 'C1', viewFile: 'file.js' });"
    + "mentorSessions.set(sessionKey('B', 'C1'), { conversationHistory: [{ role: 'assistant', content: 'saved' }],"
    + " mentorSnapshotId: 'snap', mentorResolvedTarget: 'C1', mentorRequestedTarget: 'C1',"
    + " scopeFile: 'file.js', chatHtml: '<div>saved</div>' })");
  await context.selectRepo({ id: 'B', name: 'B', path: '/repo/B' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('activeTarget'), 'C1');
  assert.equal(get('currentFocusFile'), 'file.js');
  assert.equal(get('conversationHistory.length'), 1);
  assert.equal(get('mentorRequestedTarget'), 'C1');
  assert.equal(get('mentorScope.file'), 'file.js');
});

test('a snapshot that no longer matches the selection is dropped so the next request starts over', async () => {
  let calls = 0;
  const bodies = [];
  const { context, get } = loadClient((url, options) => {
    if (url !== '/api/mentor/analyze') return keeperResponse();
    calls++;
    bodies.push(JSON.parse(options.body));
    if (calls === 2) {
      return Promise.resolve(new Response(JSON.stringify({ success: false, error: '快照与当前选择不一致，请重新开始精读' }), {
        status: 409, headers: { 'Content-Type': 'application/json' }
      }));
    }
    return Promise.resolve(eventResponse([
      { type: 'snapshot', snapshotId: `snap-${calls}`, requestedTarget: 'HEAD', resolvedTarget: 'HEAD' },
      { type: 'chunk', text: 'answer' }, { type: 'finished' }
    ]));
  });
  await context.startMentorAnalysis('walkthrough', '', true);
  await context.startMentorAnalysis('custom', 'why', false);
  assert.equal(get('mentorSnapshotId'), null);
  assert.equal(get('mentorRequestedTarget'), null);
  await context.startMentorAnalysis('custom', 'again', false);
  assert.equal(bodies[2].snapshotId, null);
  assert.equal(bodies[2].history.length, 0);
});

test('a conversation about a file that disappeared ends with a visible notice', async () => {
  const { context, get, run, nodes } = loadClient(url => {
    if (url === '/api/repos/B/commits') return Promise.resolve({ json: async () => ({
      success: true, presets: [], dirtyCount: 1,
      commits: [{ hash: 'C1', shortHash: 'C1', msg: 'one', author: 'T', relTime: 'now' }]
    }) });
    if (url.includes('/api/repos/B/diff')) return Promise.resolve({ json: async () => ({
      success: true, files: [{ path: 'file.js', patch: 'diff --git a/file.js b/file.js\n+code\n', additions: 1, deletions: 0 }],
      diffText: 'diff --git a/file.js b/file.js\n+code\n', statText: '1 个文件，+1 / -0'
    }) });
    return keeperResponse();
  });
  run("activeRepo = { id: 'A', name: 'A', path: '/repo/A' };"
    + "lastRepoView.set('B', { target: 'C1', viewFile: 'gone.js' });"
    + "mentorSessions.set(sessionKey('B', 'C1'), { conversationHistory: [{ role: 'assistant', content: 'saved' }],"
    + " mentorSnapshotId: 'snap', mentorResolvedTarget: 'C1', mentorRequestedTarget: 'C1',"
    + " scopeFile: 'gone.js', chatHtml: '<div>saved</div>' })");
  await context.selectRepo({ id: 'B', name: 'B', path: '/repo/B' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('currentFocusFile'), null);
  assert.equal(get('conversationHistory.length'), 0);
  assert.equal(get('mentorSnapshotId'), null);
  assert.equal(get("mentorSessions.has(sessionKey('B', 'C1'))"), false);
  assert.match(nodes.get('mentor-undo-text').textContent, /gone\.js 已不在当前改动中/);
  assert.equal(nodes.get('btn-undo-clear').classList.contains('hidden'), true);
});

test('rapid chunks render once on completion without losing text', async () => {
  const { context, get } = loadClient(url => url === '/api/mentor/analyze'
    ? Promise.resolve(eventResponse([...Array.from({ length: 100 }, () => ({ type: 'chunk', text: 'part' })), { type: 'finished' }])) : keeperResponse());
  let renders = 0; context.marked.parse = text => { renders++; return text; };
  await context.startMentorAnalysis('walkthrough', '', true);
  assert.equal(renders, 1); assert.equal(get('conversationHistory[0].content'), 'part'.repeat(100));
});

test('empty and length-limited model replies cannot report success', async () => {
  await assert.rejects(relayCompletion(new Response('data: [DONE]\n\n'), () => {}), /没有返回/);
  await assert.rejects(relayCompletion(new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n'), () => {}), /未完成/);
});

const analyzeClient = respond => {
  const bodies = [];
  const client = loadClient((url, options) => {
    if (url !== '/api/mentor/analyze') return keeperResponse();
    bodies.push(JSON.parse(options.body));
    return Promise.resolve(respond(bodies.length, bodies.at(-1)));
  });
  return { ...client, bodies };
};
const answer = (snapshotId, instruction, extra = {}) => eventResponse([
  { type: 'snapshot', snapshotId, requestedTarget: 'HEAD', resolvedTarget: 'a'.repeat(40), instruction, ...extra },
  { type: 'chunk', text: `answer-${snapshotId}` }, { type: 'finished' }
]);

test('action turns record the instruction the server sent', async () => {
  const { context, get, bodies } = analyzeClient(call => answer('snap', call === 1 ? 'server walkthrough' : 'server drill'));
  await context.startMentorAnalysis('walkthrough', '', false);
  await context.triggerMentorAction('drill');
  assert.deepEqual(bodies.map(body => [body.mode, body.customPrompt, body.snapshotId]), [['walkthrough', '', null], ['drill', '', 'snap']]);
  assert.deepEqual(JSON.parse(get('JSON.stringify(conversationHistory.map(turn => turn.content))')),
    ['server walkthrough', 'answer-snap', 'server drill', 'answer-snap']);
});

test('long conversations send only whole recent rounds within the server budget', async () => {
  const { context, get, run, nodes, bodies } = analyzeClient(() => answer('snap', 'next'));
  run("mentorSnapshotId = 'snap'; mentorRequestedTarget = 'HEAD'; conversationHistory = [];"
    + "for (let i = 0; i < 4; i++) conversationHistory.push({ role: 'user', content: 'q' + i }, { role: 'assistant', content: 'x'.repeat(10000) });");
  await context.startMentorAnalysis('custom', 'next', false);
  const sent = bodies[0].history;
  assert.deepEqual(sent.map(turn => turn.content.slice(0, 2)), ['q2', 'xx', 'q3', 'xx']);
  assert.ok(sent.reduce((sum, turn) => sum + turn.content.length, 0) <= 24000);
  assert.equal(get('conversationHistory.length'), 10);
  assert.match(nodes.get('mentor-status-text').textContent, /最近 4 条/);
});

test('an expired snapshot is renewed in place and the conversation survives', async () => {
  const { context, get, nodes, bodies } = analyzeClient(call => call === 2
    ? new Response(JSON.stringify({ success: false, error: '分析快照已过期或被回收', code: 'snapshot-expired' }), { status: 409 })
    : answer(`snap-${call}`, call === 1 ? 'walk' : 'why', { renewed: call === 3 }));
  await context.startMentorAnalysis('walkthrough', '', false);
  await context.startMentorAnalysis('custom', 'why', false);
  assert.equal(bodies[1].snapshotId, 'snap-1');
  assert.equal(bodies[2].snapshotId, null); assert.equal(bodies[2].renewSnapshot, true);
  assert.deepEqual(bodies[2].history, bodies[1].history);
  assert.equal(get('mentorSnapshotId'), 'snap-3');
  assert.deepEqual(JSON.parse(get('JSON.stringify(conversationHistory.map(turn => turn.content))')), ['walk', 'answer-snap-1', 'why', 'answer-snap-3']);
  const footer = [...nodes.values()].filter(node => node.id.startsWith('footer-')).at(-1);
  assert.match(footer.children[0].textContent, /重新捕获/);
});

test('a session token rejected after a service restart is refreshed once', async () => {
  let calls = 0;
  const client = loadClient(() => Promise.resolve(++calls === 1
    ? new Response(JSON.stringify({ error: '本机会话已失效' }), { status: 401 })
    : Response.json({ success: true, models: [{ id: 'm', name: 'Model' }] })));
  await client.context.loadModels();
  assert.equal(calls, 2);
  assert.equal(client.get('modelsReady'), true);
});

test('a fresh analysis takes the viewed file as scope, and clearing it can be undone', async () => {
  const { context, get, nodes, bodies } = analyzeClient(call => answer(`snap-${call}`, `q${call}`));
  context.setFocusFile('src/a.js');
  await context.startMentorAnalysis('walkthrough', '', false);
  assert.equal(bodies[0].focusFile, 'src/a.js');
  assert.equal(nodes.get('mentor-scope-text').textContent, '讨论范围：a.js');

  context.clearCurrentMentorSession();
  assert.equal(get('conversationHistory.length'), 0);
  assert.equal(get("mentorSessions.has(sessionKey('B', 'HEAD'))"), false);
  assert.equal(nodes.get('btn-undo-clear').classList.contains('hidden'), false);
  context.undoClearMentorSession();
  assert.equal(get('conversationHistory.length'), 2);
  assert.equal(get('mentorSnapshotId'), 'snap-1');
  assert.equal(get('mentorScope.file'), 'src/a.js');
  assert.equal(get("mentorSessions.has(sessionKey('B', 'HEAD'))"), true);

  // An undo offered before a newer conversation started never replaces it.
  context.clearCurrentMentorSession();
  await context.startMentorAnalysis('walkthrough', '', false);
  context.undoClearMentorSession();
  assert.equal(get('mentorSnapshotId'), 'snap-2');
});

test('the first answer lists its evidence; follow-ups on the same snapshot do not repeat it', async () => {
  const evidence = { revision: 'working-tree', diff: { files: [{ path: 'src/a.js', truncated: false }], omitted: 2 },
    documents: [{ path: 'README.md', truncated: true, ranges: [[1, 80]] }],
    sources: [{ path: 'src/a.js', truncated: true, ranges: [[10, 40], [90, 95]] }],
    warnings: ['"x"：证据不可读取或已排除'], warningCount: 1 };
  const { context, nodes } = analyzeClient(call => answer('snap', `q${call}`, call === 1 ? { evidence } : {}));
  await context.startMentorAnalysis('walkthrough', '', false);
  await context.startMentorAnalysis('custom', 'why', false);
  const footers = [...nodes.values()].filter(node => node.id.startsWith('footer-'));
  const details = footer => footer.children.find(child => child.className === 'evidence-details');
  const first = details(footers[0]);
  assert.equal(first.children[0].textContent, '本次依据：Diff 1 个文件（另有 2 个未展示） · 文档 1 份 · 源码 1 个文件 · 2 处截断');
  const items = first.children.filter(child => child.children.length && !child.className).flatMap(ul => ul.children.map(li => li.textContent));
  assert.deepEqual(items, ['src/a.js', 'README.md（第 1-80 行，已截断）', 'src/a.js：第 10-40, 90-95 行', '"x"：证据不可读取或已排除']);
  assert.equal(details(footers[1]), undefined);
});

test('the client colors text with theme variables, not fixed palette shades', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.deepEqual(source.match(/\b(?:text|bg|border)-(?:slate|rose|emerald|amber|indigo)-\d+/g) ?? [], []);
});

test('the evidence summary says when content was not scanned or values were replaced', async () => {
  const base = { diff: { files: [], omitted: 0 }, documents: [], sources: [], warnings: [], warningCount: 0 };
  const footerOf = async extra => {
    const { context, nodes } = analyzeClient(() => answer('snap', 'q', extra));
    await context.startMentorAnalysis('walkthrough', '', false);
    return [...nodes.values()].find(node => node.id.startsWith('footer-'));
  };
  const summaryOf = async secretScan => (await footerOf({ evidence: { ...base, secretScan } }))
    .children.find(child => child.className === 'evidence-details').children[0].textContent;
  assert.match(await summaryOf({ available: false, redacted: 0, rules: [] }), / · 未做密钥扫描$/);
  assert.match(await summaryOf({ available: true, redacted: 2, rules: ['generic-api-key'] }), / · 2 个疑似密钥已替换$/);
  assert.doesNotMatch(await summaryOf({ available: true, redacted: 0, rules: [] }), /密钥/);
  const footer = await footerOf({ promptRedacted: 1 });
  assert.ok(footer.children.some(child => child.textContent === '本轮提问与历史中 1 个疑似密钥已替换后发送'));
});

test('code references resolve only to diff files, including paths run into Chinese prose', () => {
  const { context } = loadClient(keeperResponse);
  const paths = ['lib/mentor.js', 'public/app.js', 'test/app.js', '目录/中文.js'];
  const refs = text => JSON.parse(JSON.stringify(context.findCodeRefs(text, paths)));
  assert.deepEqual(refs('入口在 lib/mentor.js:41-52，端口:3300'),
    [{ start: 4, stop: 23, file: 'lib/mentor.js', line: 41, end: 52 }]);
  assert.equal(refs('mentor.js:7')[0].file, 'lib/mentor.js');
  assert.equal(refs('b/lib/mentor.js#L9')[0].line, 9);
  assert.deepEqual(refs('app.js:3 与 127.0.0.1:3300'), []);
  assert.deepEqual(refs('见目录/中文.js:2').map(ref => [ref.start, ref.file]), [[1, '目录/中文.js']]);
});

test('a cited line lands on its new-file row, a deleted row, or the nearest change', () => {
  const { context } = loadClient(keeperResponse);
  const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -10,4 +10,4 @@\n keep\n-old\n+new\n tail\n';
  const locate = (text, line) => JSON.parse(JSON.stringify(context.locateDiffLine(text, line)));
  assert.deepEqual(locate(patch, 11), { row: 6, exact: true });
  assert.deepEqual(locate(patch, 10), { row: 4, exact: true });
  assert.deepEqual(locate(patch, 40), { row: 7, exact: false });
  assert.deepEqual(locate('@@ -5,2 +5,0 @@\n-gone\n-also\n', 6), { row: 2, exact: true });
  assert.match(context.renderFormattedDiff(patch), /data-row="6"><span class="diff-num">11</);
});

test('selected diff rows become a question quoting file, real lines and code', () => {
  const { context, run } = loadClient(keeperResponse);
  const a = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -10,4 +10,4 @@\n keep\n-old\n+new\n tail\n';
  const b = 'diff --git a/b.js b/b.js\n@@ -1 +1 @@\n-x\n+y\n';
  context.__files = [{ path: 'a.js', patch: a }, { path: 'b.js', patch: b }];
  run('currentDiffFiles = __files; currentFocusFile = null;');
  assert.equal(context.selectionPrompt(5, 7), '关于 a.js:11-12：\n```diff\n-old\n+new\n tail\n```\n\n');
  assert.equal(context.selectionPrompt(7, 13),
    '关于 a.js:12：\n```diff\n tail\n```\n\n关于 b.js:1：\n```diff\n@@ -1 +1 @@\n-x\n+y\n```\n\n');
  run("currentFocusFile = 'b.js';");
  assert.match(context.selectionPrompt(2, 2), /^关于 b\.js（旧版本第 1 行）/);
  context.__files = [{ path: 'big.js', patch: '@@ -0,0 +1,300 @@\n' + Array.from({ length: 300 }, (_, i) => `+line${i}`).join('\n') }];
  run('currentDiffFiles = __files; currentFocusFile = null;');
  const quoted = context.selectionPrompt(0, 300);
  assert.equal(quoted.split('\n').filter(line => line.startsWith('+line')).length, 119);
  assert.match(quoted, /已截取/);
});
