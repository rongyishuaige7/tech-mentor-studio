import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitFixture } from './git-helper.js';
import { appFixture } from './http-helper.js';
const execute = promisify(execFile);

test('launcher refuses an unrelated listener and leaves it serving requests', async t => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('unrelated-service'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(execute('bash', ['start.sh'], { env: { ...process.env, PORT: String(port), NO_BROWSER: '1' }, timeout: 10000 }), error => {
    assert.match(error.stderr, /未停止任何进程/); return true;
  });
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated-service');
});

test('launcher reuses a verified current project service', async t => {
  const { root } = gitFixture(t); const { base } = await appFixture(t, root);
  const { stdout } = await execute('bash', ['start.sh'], { env: { ...process.env, PORT: new URL(base).port, NO_BROWSER: '1' }, timeout: 10000 });
  assert.match(stdout, /复用当前项目服务/);
});

test('launcher refuses a previous backend version without stopping it', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/session' ? { token: 'fixture-only' }
      : { success: true, service: 'tech-mentor-studio', projectRoot: process.cwd(), fingerprint: 'previous-version' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(execute('bash', ['start.sh'], { env: { ...process.env, PORT: String(port), NO_BROWSER: '1' }, timeout: 10000 }), error => {
    assert.match(error.stderr, /旧版本占用/); return true;
  });
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.fingerprint, 'previous-version');
});
