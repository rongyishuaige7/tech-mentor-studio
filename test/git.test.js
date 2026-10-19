import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitFixture } from './git-helper.js';
import { loadDiff, getCommits, getPresets, resolveTarget, runGit, getStatus } from '../lib/git.js';
import { decodeGitPath, parseDiffFiles, getCleanDiffForMentor, newFilePatch, numberDiffLines, generatedDir } from '../lib/diff.js';

test('unborn repository combines staged and untracked final working contents', async t => {
  const { root, git, write } = gitFixture(t);
  write('staged.js', 'staged\n'); git('add', 'staged.js'); write('staged.js', 'final\n');
  write('new-dir/中文.js', 'new\n');
  const data = await loadDiff(root, 'working-tree');
  assert.deepEqual(data.files.map(file => file.path).sort(), ['new-dir/中文.js', 'staged.js']);
  assert.equal(data.files.find(file => file.path === 'staged.js').patch.includes('+final'), true);
  assert.equal(data.files.find(file => file.path === 'staged.js').patch.includes('+staged'), false);
  assert.equal(data.statText, '2 个文件，+2 / -0');
  assert.equal(data.isCleanWorkingTree, false);
});

test('untracked nested and special filenames retain exact names and line counts', async t => {
  const { root, write, commit } = gitFixture(t); write('base', 'base\n'); commit('base');
  const names = ['目录/中文.js', 'space name.js', 'quote"name.js', 'back\\slash.js', 'new\nline.js'];
  for (const name of names) write(name, 'one\n');
  const data = await loadDiff(root);
  assert.deepEqual(data.files.map(file => file.path).sort(), names.sort());
  assert.ok(data.files.every(file => file.additions === 1));
});

test('root commit and rename metadata are parsed correctly', async t => {
  const { root, write, git, commit } = gitFixture(t);
  write('a b.js', 'one\n'); const first = commit('subject | containing separators');
  const rootDiff = await loadDiff(root, first);
  assert.equal(rootDiff.files[0].path, 'a b.js');
  git('mv', 'a b.js', '中文 "new".js'); const second = commit('rename');
  const data = await loadDiff(root, second);
  assert.equal(data.files[0].path, '中文 "new".js');
  assert.equal(data.files[0].oldPath, 'a b.js');
  const commits = await getCommits(root);
  assert.equal(commits[1].msg, 'subject | containing separators');
  assert.equal(commits[1].author, 'Fixture | Tester');
});

test('range presets require an existing ancestor and branch refs may contain slash', async t => {
  const { root, write, git, commit } = gitFixture(t);
  for (let i = 0; i < 3; i++) { write('code', String(i)); commit(String(i)); }
  assert.deepEqual(await getPresets(root), []);
  write('code', '3'); commit('3');
  assert.equal((await getPresets(root))[0].hash, 'range:HEAD~3..HEAD');
  git('branch', 'feature/中文');
  assert.match(await resolveTarget(root, 'feature/中文'), /^[0-9a-f]{40}$/);
  assert.equal((await loadDiff(root, 'range:HEAD~3..HEAD')).files.length, 1);
  await assert.rejects(resolveTarget(root, '--help'), /无效/);
});

test('hunk content beginning with plus or minus is counted as code', () => {
  const patch = 'commit header\ndiff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n---value\n+++value\n';
  const file = parseDiffFiles(patch)[0];
  assert.equal(file.additions, 1); assert.equal(file.deletions, 1);
  assert.equal(decodeGitPath('"\\344\\270\\255\\346\\226\\207.js"'), '中文.js');
});

test('new patches preserve empty files and final newline semantics', () => {
  assert.equal(parseDiffFiles(newFilePatch('empty', ''))[0].additions, 0);
  assert.equal(parseDiffFiles(newFilePatch('one', 'one\n'))[0].additions, 1);
  assert.ok(newFilePatch('one', 'one').includes('No newline at end of file'));
});

test('oversized first file retains code and later files with a truncation notice', () => {
  const files = [
    { path: 'big.js', patch: 'diff --git a/big.js b/big.js\n' + '+important\n'.repeat(10000) },
    { path: 'small.js', patch: 'diff --git a/small.js b/small.js\n+small-important\n' }
  ];
  const text = getCleanDiffForMentor(files);
  assert.ok(text.includes('+important')); assert.ok(text.includes('+small-important'));
  assert.ok(text.includes('截断')); assert.ok(text.length <= 60000);
  assert.ok(getCleanDiffForMentor([{ path: 'line.js', patch: '+LONG_CODE'.repeat(10000) }]).includes('+LONG_CODE'));
});

test('sensitive files and links are excluded without claiming a clean tree', async t => {
  const { root, write, commit } = gitFixture(t); write('base', 'base'); commit('base');
  write('.env', 'AUDIT_CANARY'); fs.symlinkSync('base', path.join(root, 'link'));
  const data = await loadDiff(root);
  assert.equal(data.files.length, 0); assert.equal(data.isCleanWorkingTree, false);
  assert.equal(data.warnings.length, 2); assert.equal(data.diffText.includes('AUDIT_CANARY'), false);
  assert.equal(getCleanDiffForMentor([{ path: '.env', isSensitive: true, patch: 'AUDIT_CANARY' }], '.env'), '');
});

test('sensitive paths stay excluded after rename in worktree and history', async t => {
  const { root, write, commit, git } = gitFixture(t);
  write('.env', 'TOKEN=hidden-value\n'); write('base.js', 'base\n');
  commit('base');
  git('mv', '.env', 'config.txt');
  fs.appendFileSync(path.join(root, 'config.txt'), 'PUBLIC=1\n');

  const working = await loadDiff(root);
  assert.equal(working.files.some(file => file.path === 'config.txt'), false);
  assert.equal(working.diffText.includes('TOKEN=hidden-value'), false);
  assert.ok(working.warnings.some(warning => warning.includes('.env') && warning.includes('config.txt')));

  const renamed = commit('rename secret');
  const historical = await loadDiff(root, renamed);
  assert.equal(historical.files.length, 0);
  assert.equal(historical.diffText.includes('TOKEN=hidden-value'), false);
  assert.ok(historical.warnings.some(warning => warning.includes('.env')));

  const [parsed] = parseDiffFiles('diff --git a/.env b/config.txt\n'
    + 'similarity index 80%\nrename from .env\nrename to config.txt\n'
    + '--- a/.env\n+++ b/config.txt\n@@ -1 +1 @@\n-SECRET=old\n+SECRET=new\n');
  assert.equal(parsed.oldPath, '.env');
  assert.equal(parsed.isSensitive, true);
});

test('configured external diff is not invoked and partial stdout remains an error', async t => {
  const { root, write, commit, git } = gitFixture(t); write('code', 'old\n'); const sha = commit('base');
  const marker = path.join(root, 'external-was-called');
  const script = path.join(root, 'external-script');
  fs.writeFileSync(script, '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(marker) + ',"called");\n');
  fs.chmodSync(script, 0o755); git('config', 'diff.external', script); write('code', 'new\n');
  const data = await loadDiff(root);
  assert.ok(data.diffText.includes('+new')); assert.equal(fs.existsSync(marker), false);
  await assert.rejects(runGit(['show', sha], root, { maxBuffer: 10 }), error => error.status === 413);
});

test('status rename paths are NUL-safe', async t => {
  const { root, write, commit, git } = gitFixture(t); write('old\nname', 'code'); commit('base');
  git('mv', 'old\nname', 'new\nname');
  const status = await getStatus(root);
  assert.equal(status[0].path, 'new\nname'); assert.equal(status[0].oldPath, 'old\nname');
});

test('modified tracked symlinks remain excluded in worktree and historical diffs', async t => {
  const { root, commit, git } = gitFixture(t);
  const link = path.join(root, 'link.txt');
  fs.symlinkSync('/fixture/first-target', link); commit('first-link');
  fs.unlinkSync(link); fs.symlinkSync('/fixture/second-target', link);
  const working = await loadDiff(root, 'working-tree');
  assert.equal(working.files.length, 0); assert.ok(working.warnings.length);
  const target = commit('modified-link');
  assert.equal((await loadDiff(root, target)).files.length, 0);
});

test('unquoted paths containing " b/" keep their name when no content lines follow', async t => {
  const { root, write, commit } = gitFixture(t);
  write('x b/y.js', 'a\n'); commit('base');
  fs.chmodSync(path.join(root, 'x b/y.js'), 0o755);
  assert.deepEqual((await loadDiff(root)).files.map(file => file.path), ['x b/y.js']);
  const [copied] = parseDiffFiles('diff --git a/src/a.js b/lib/a.js\nsimilarity index 100%\ncopy from src/a.js\ncopy to lib/a.js\n');
  assert.equal(copied.path, 'lib/a.js'); assert.equal(copied.oldPath, 'src/a.js');
});

test('untracked dependency and cache directories are counted, not read', async t => {
  const { root, write, commit } = gitFixture(t);
  write('base.js', 'base\n'); write('web/node_modules/tracked/index.js', 'tracked\n'); commit('base');
  fs.appendFileSync(path.join(root, 'web/node_modules/tracked/index.js'), 'more\n');
  for (let i = 0; i < 300; i++) write(`web/node_modules/pkg${i}/index.js`, 'module.exports = 1;\n');
  write('.venv/lib/site.py', 'x = 1\n'); write('src/real.js', 'real\n');
  // Reading this file would produce a per-file warning; skipping it must not.
  fs.chmodSync(path.join(root, 'web/node_modules/pkg0/index.js'), 0o000);
  const data = await loadDiff(root);
  assert.deepEqual(data.files.map(file => file.path).sort(), ['src/real.js', 'web/node_modules/tracked/index.js']);
  assert.equal(data.files.find(file => file.path.includes('tracked')).isNoise, true);
  assert.deepEqual(data.warnings, ['".venv/"：1 个依赖或缓存文件未读取', '"web/node_modules/"：300 个依赖或缓存文件未读取']);
  assert.equal(generatedDir('a/node_modules/b/node_modules/c.js'), 'a/node_modules/');
  assert.equal(generatedDir('src/venvironment/x.js'), null);
  assert.equal(generatedDir('build/out.js'), null);
});

test('the 8 MiB worktree limit still applies across many small untracked files', async t => {
  const { root, write, commit } = gitFixture(t);
  write('base.js', 'base\n'); commit('base');
  const content = ('x'.repeat(99) + '\n').repeat(2900);
  for (let i = 0; i < 30; i++) write(`gen/f${i}.txt`, content);
  await assert.rejects(loadDiff(root), error => error.status === 413);
});

test('mentor diff lines carry real new-file and old-file line numbers', () => {
  const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -10,4 +10,4 @@\n keep\n-old\n---minus\n+new\n+++plus\n tail\n\\ No newline at end of file\n';
  assert.equal(numberDiffLines(patch), 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -10,4 +10,4 @@\n'
    + ' 10|keep\n-11|old\n-12|--minus\n+11|new\n+12|++plus\n 13|tail\n\\ No newline at end of file\n');
});
