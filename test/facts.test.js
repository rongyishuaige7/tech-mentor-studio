import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitFixture, gitSpawnCounter } from './git-helper.js';
import { loadDiff } from '../lib/git.js';
import { collectEvidence, hasProjectFacts, readVersionTexts } from '../lib/facts.js';

test('historical evidence for many files reads with a fixed number of git processes', async t => {
  const { root, write, commit } = gitFixture(t);
  write('README.md', '# demo\n'); write('package.json', '{}\n');
  const names = [];
  for (let d = 0; d < 8; d++) for (let f = 0; f < 5; f++) {
    const name = `src/m${d}/f${f}.js`; names.push(name); write(name, `export const v = ${d * 10 + f};\n`);
  }
  commit('base');
  for (const name of names) fs.appendFileSync(path.join(root, name), 'export const changed = true;\n');
  const sha = commit('change 40 files');
  const diff = await loadDiff(root, sha);
  const count = gitSpawnCounter(t);

  const evidence = await count(() => collectEvidence(root, diff, null));
  assert.equal(evidence.result.sources.length, 40);
  assert.ok(evidence.result.sources.every(source => source.excerpt.includes('changed = true')));
  assert.ok(evidence.result.documents.some(doc => doc.path === 'README.md'));
  assert.ok(evidence.spawns <= 2, `collectEvidence started ${evidence.spawns} git processes`);

  const facts = await count(() => hasProjectFacts(root, diff));
  assert.equal(facts.result, true);
  assert.ok(facts.spawns <= 2, `hasProjectFacts started ${facts.spawns} git processes`);
});

test('one batch keeps each file\'s outcome for special names, links, oversized, binary and missing files', async t => {
  const { root, write, commit } = gitFixture(t);
  const special = ['目录/中文 "名".js', 'space name.js', 'new\nline.js', 'back\\slash.js'];
  for (const name of special) write(name, `content of ${JSON.stringify(name)}\n`);
  write('big.txt', 'x'.repeat(600000));
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
  fs.symlinkSync('space name.js', path.join(root, 'link.js'));
  write('same-a.txt', 'same\n'); write('same-b.txt', 'same\n');
  const sha = commit('fixtures');
  const results = await readVersionTexts(root,
    [...special, 'big.txt', 'bin.dat', 'link.js', 'gone.js', '.env', '../x', 'same-a.txt', 'same-b.txt'], sha);
  for (const name of special) assert.equal(results.get(name).text, `content of ${JSON.stringify(name)}\n`);
  assert.match(results.get('big.txt').error.message, /上限/);
  assert.match(results.get('bin.dat').error.message, /二进制/);
  assert.match(results.get('link.js').error.message, /链接/);
  assert.equal(results.get('gone.js').error.code, 'ENOENT');
  assert.match(results.get('.env').error.message, /无效/);
  assert.match(results.get('../x').error.message, /无效/);
  assert.equal(results.get('same-a.txt').text, 'same\n');
  assert.equal(results.get('same-b.txt').text, 'same\n');
});

test('a focused file is shown whole when it fits, otherwise every hunk with the widest context that fits', async t => {
  const { root, write, commit } = gitFixture(t);
  const body = n => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';
  write('small.js', body(400)); write('big.js', body(3000)); commit('base');
  const small = body(400).split('\n'); small[199] = 'const line200 = "changed";'; write('small.js', small.join('\n'));
  const big = body(3000).split('\n');
  big[99] = 'const line100 = "changed";';
  for (let i = 999; i < 1199; i++) big[i] = `const line${i + 1} = "block";`;
  big[2499] = 'const line2500 = "changed";';
  write('big.js', big.join('\n'));
  const diff = await loadDiff(root);
  const smallView = (await collectEvidence(root, diff, 'small.js')).sources[0];
  assert.equal(smallView.truncated, false);
  assert.deepEqual(smallView.ranges, [[1, 400]]);
  const bigView = (await collectEvidence(root, diff, 'big.js')).sources[0];
  assert.equal(bigView.truncated, true);
  assert.ok(bigView.excerpt.length <= 20000);
  for (const line of [100, 1000, 1199, 2500]) {
    assert.ok(bigView.ranges.some(([start, end]) => start <= line && line <= end), `line ${line} not shown`);
  }
  assert.match(bigView.excerpt, /\n…\n/);
});

test('documents share the budget instead of being cut at 100 lines', async t => {
  const { root, write } = gitFixture(t);
  write('README.md', Array.from({ length: 104 }, (_, i) => `README line ${i + 1}`).join('\n') + '\n');
  write('code.js', 'x\n');
  const readme = (await collectEvidence(root, await loadDiff(root))).documents.find(doc => doc.path === 'README.md');
  assert.equal(readme.truncated, false);
  assert.deepEqual(readme.ranges, [[1, 104]]);
  assert.match(readme.excerpt, /^104: README line 104$/m);
});

test('several changed files share the source budget, each keeping its hunk', async t => {
  const { root, write, commit } = gitFixture(t);
  const body = Array.from({ length: 200 }, (_, i) => `export const value${i + 1} = ${i + 1}; // filler text`).join('\n') + '\n';
  for (let i = 0; i < 30; i++) write(`src/f${i}.js`, body);
  commit('base');
  for (let i = 0; i < 30; i++) {
    const lines = body.split('\n'); lines[100] = `export const value101 = 'changed in ${i}';`;
    write(`src/f${i}.js`, lines.join('\n'));
  }
  const evidence = await collectEvidence(root, await loadDiff(root));
  assert.ok(evidence.sources.length >= 10, `only ${evidence.sources.length} files shown`);
  assert.ok(evidence.sources.every(source => source.excerpt.includes('changed in')));
  assert.ok(evidence.sources.reduce((sum, source) => sum + source.excerpt.length, 0) <= 20000);
});

test('project facts ignore whitespace-only documents in both worktree and history', async t => {
  const { root, write, commit } = gitFixture(t);
  write('README.md', '  \n\n'); write('code.js', 'a\n');
  const sha = commit('blank docs');
  assert.equal(await hasProjectFacts(root, await loadDiff(root, sha)), false);
  write('code.js', 'b\n');
  assert.equal(await hasProjectFacts(root, await loadDiff(root)), false);
  write('AGENTS.md', 'rules\n');
  assert.equal(await hasProjectFacts(root, await loadDiff(root)), true);
});
