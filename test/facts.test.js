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
