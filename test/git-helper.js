import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function gitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture | Tester', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  const commit = message => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD').trim(); };
  return { root, git, write, commit };
}

// Counts git processes started while `fn` runs, through a PATH shim. Each test
// file runs in its own process and its tests run in order, so the PATH change
// cannot reach other tests. `delay` (seconds) slows every git process, so
// overlapping requests reliably overlap.
export function gitSpawnCounter(t, { delay = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-git-shim-'));
  const log = path.join(dir, 'calls.log'); fs.writeFileSync(log, '');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const pause = delay ? `sleep ${Number(delay)}\n` : '';
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho x >> '${log}'\n${pause}exec '${real}' "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  return async fn => {
    const before = calls();
    const result = await fn();
    return { result, spawns: calls() - before };
  };
}
