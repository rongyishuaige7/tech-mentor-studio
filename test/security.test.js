import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { localAccess, RepositoryRegistry, readRepoText } from '../lib/security.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  return { root, repo };
}

test('local access rejects hostile host, origin and fetch metadata', () => {
  const access = localAccess();
  for (const headers of [
    { host: 'attacker.invalid:3300' },
    { host: 'localhost:3300', origin: 'https://attacker.invalid' },
    { host: 'localhost:3300', 'sec-fetch-site': 'cross-site' }
  ]) {
    let next = false;
    const res = { status(code) { this.code = code; return this; }, json() {} };
    access.guard({ socket: { localPort: 3300 }, headers }, res, () => { next = true; });
    assert.equal(res.code, 403); assert.equal(next, false);
  }
});

test('API requires current in-memory local session token', () => {
  const access = localAccess(); let token;
  access.session({}, { setHeader() {}, json(data) { token = data.token; } });
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json() {} };
  access.authenticate({ headers: {} }, res, () => assert.fail('missing token accepted'));
  assert.equal(res.code, 401);
  let next = false;
  access.authenticate({ headers: { 'x-local-token': token } }, res, () => { next = true; });
  assert.equal(next, true);
});

test('repository IDs cannot be forged from arbitrary directories', async t => {
  const { repo } = fixture(t);
  const registry = new RepositoryRegistry();
  const record = await registry.register(repo);
  assert.equal(registry.resolve(record.id), fs.realpathSync(repo));
  assert.throws(() => registry.resolve(Buffer.from(repo).toString('base64url')), /未登记/);
  const child = path.join(repo, 'src'); fs.mkdirSync(child);
  await assert.rejects(registry.register(child), /根目录/);
});

test('file reads reject links, linked directories, traversal and sensitive names', t => {
  const { root, repo } = fixture(t);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'AUDIT_CANARY');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(repo, 'link.txt'));
  fs.symlinkSync(root, path.join(repo, 'linked-directory'));
  fs.writeFileSync(path.join(repo, '.env'), 'AUDIT_CANARY');
  for (const name of ['link.txt', 'linked-directory/outside.txt', '../outside.txt', '.env', '.git/config']) {
    assert.throws(() => readRepoText(repo, name));
  }
  fs.writeFileSync(path.join(repo, '普通文件.js'), 'safe code');
  assert.equal(readRepoText(repo, '普通文件.js'), 'safe code');
});

test('file reads enforce size and binary limits', t => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'binary'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(repo, 'large'), 'x'.repeat(100));
  assert.throws(() => readRepoText(repo, 'binary'), /二进制/);
  assert.throws(() => readRepoText(repo, 'large', 50), /上限/);
});
