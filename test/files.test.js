import test from 'node:test';
import assert from 'node:assert/strict';
import { gitFixture } from './git-helper.js';
import { listWorktreeFiles, readWorktreeFile } from '../lib/files.js';

test('the tree lists tracked and untracked files and skips dependencies', async t => {
  const { root, write, commit } = gitFixture(t);
  write('src/app.js', 'code\n');
  write('README.md', '# demo\n');
  write('node_modules/pkg/index.js', 'dep\n');
  write('.env', 'SECRET=1\n');
  commit('first');
  write('src/new.js', 'new\n');

  const { files, omitted } = await listWorktreeFiles(root);
  const paths = files.map(file => file.path);
  assert.ok(paths.includes('src/app.js'));
  assert.ok(paths.includes('src/new.js'));
  assert.ok(paths.includes('README.md'));
  assert.ok(!paths.includes('node_modules/pkg/index.js'));
  assert.ok(!paths.includes('.env'));
  assert.equal(files.find(file => file.path === 'src/new.js').tracked, false);
  assert.equal(files.find(file => file.path === 'src/app.js').tracked, true);
  assert.ok(omitted >= 2);
});

test('reading a file keeps the safety checks and counts lines', async t => {
  const { root, write, commit } = gitFixture(t);
  write('src/app.js', 'one\ntwo\n');
  write('bin.dat', 'a\0b');
  commit('first');

  const file = readWorktreeFile(root, 'src/app.js');
  assert.equal(file.lines, 2);
  assert.equal(file.text, 'one\ntwo\n');
  assert.throws(() => readWorktreeFile(root, '../outside.txt'), /超出|无效/);
  assert.throws(() => readWorktreeFile(root, '.env'), /敏感/);
  assert.throws(() => readWorktreeFile(root, 'bin.dat'), /二进制/);
  assert.throws(() => readWorktreeFile(root, 'src'), /非普通文件/);
});
