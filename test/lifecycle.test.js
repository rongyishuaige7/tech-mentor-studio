import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
