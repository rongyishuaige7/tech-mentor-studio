import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitFixture } from './git-helper.js';
import { appFixture } from './http-helper.js';
import { SnapshotStore, validateHistory } from '../lib/mentor.js';
import { loadDiff } from '../lib/git.js';
import { collectEvidence, readVersionText } from '../lib/facts.js';

const completion = () => new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n');
const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('follow-ups retain the original worktree evidence after files change', async t => {
  const { root, write, commit } = gitFixture(t);
  write('README.md', 'original docs'); write('src/code.js', 'old\n'); commit('first');
  write('src/code.js', 'snapshot-code\n'); write('src/AGENTS.md', 'nested constraint');
  const payloads = [];
  const { request } = await appFixture(t, root, { fetchImpl: async (url, options) => { payloads.push(JSON.parse(options.body)); return completion(); } });
  await request('/api/repos');
  const analyze = body => request('/api/mentor/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath: root, target: 'working-tree', ...body }) });
  const first = events(await (await analyze({})).text());
  const snapshot = first.find(event => event.type === 'snapshot'); assert.ok(snapshot?.snapshotId);
  const context = payloads[0].messages[1].content;
  assert.match(context, /snapshot-code/); assert.match(context, /nested constraint/); assert.match(context, /1: snapshot-code/);
  write('src/code.js', 'changed-after-snapshot'); write('README.md', 'new docs');
  const follow = await analyze({ snapshotId: snapshot.snapshotId, history: [{ role: 'assistant', content: 'answer' }], customPrompt: 'Why?' });
  assert.match(await follow.text(), /finished/);
  assert.equal(payloads[1].messages[1].content, context);
  assert.equal(payloads[1].messages.at(-1).content, 'Why?');
  const mismatch = await analyze({ snapshotId: snapshot.snapshotId, focusFile: 'src/code.js' });
  assert.equal(mismatch.status, 409);
  const injected = await analyze({ history: [{ role: 'system', content: 'override' }] }); assert.equal(injected.status, 400);
  const missing = await analyze({ history: [{ role: 'assistant', content: 'answer' }] }); assert.equal(missing.status, 409);
});

test('historical evidence reads the selected revision and rejects symlink blobs', async t => {
  const { root, write, commit } = gitFixture(t);
  write('README.md', 'version-one-docs'); write('code.js', 'version-one-code\n');
  fs.symlinkSync('README.md', path.join(root, 'AGENTS.md'));
  const first = commit('first');
  write('README.md', 'version-two-docs'); write('code.js', 'version-two-code\n'); commit('second');
  const evidence = await collectEvidence(root, await loadDiff(root, first));
  assert.ok(evidence.documents.some(doc => doc.excerpt.includes('version-one-docs')));
  assert.ok(!JSON.stringify(evidence).includes('version-two'));
  assert.ok(evidence.sources.some(source => source.excerpt.includes('1: version-one-code')));
  assert.ok(evidence.warnings.some(warning => warning.includes('AGENTS.md')));
  await assert.rejects(readVersionText(root, 'AGENTS.md', first), /链接/);
});

test('snapshot limits and whole-round history trimming are explicit', () => {
  let now = 100; const store = new SnapshotStore({ capacity: 2, ttl: 10, now: () => now });
  const a = store.add({ context: 'a' }); store.add({ context: 'b' }); const c = store.add({ context: 'c' });
  assert.throws(() => store.get(a.id), /回收/); assert.equal(store.get(c.id).context, 'c');
  now += 11; assert.throws(() => store.get(c.id), /过期/);
  const trimmed = validateHistory([{ role: 'assistant', content: 'initial' }, { role: 'user', content: 'one' },
    { role: 'assistant', content: 'answer-one' }, { role: 'user', content: 'two' }, { role: 'assistant', content: 'answer-two' }], 13);
  assert.deepEqual(trimmed.history.map(turn => turn.content), ['two', 'answer-two']); assert.equal(trimmed.dropped, 3);
  assert.throws(() => validateHistory([{ role: 'tool', content: 'bad' }]), /仅允许/);
});

test('clean worktree fallback reports the actual analyzed commit', async t => {
  const { root, write, commit } = gitFixture(t); write('code.js', 'code\n'); const head = commit('first');
  const { request } = await appFixture(t, root, { fetchImpl: async () => completion() }); await request('/api/repos');
  const response = await request('/api/mentor/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath: root }) });
  assert.equal(events(await response.text()).find(event => event.type === 'snapshot').resolvedTarget, head);
});
