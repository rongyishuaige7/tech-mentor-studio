import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, defaultConfigDir } from '../lib/config.js';

function dirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config'), dataDir = path.join(root, 'data');
  fs.mkdirSync(configDir); fs.mkdirSync(dataDir);
  const write = (dir, text, mode = 0o600) => fs.writeFileSync(path.join(dir, 'proxy-key'), text, { mode });
  return { root, configDir, dataDir, write };
}

// Each test file runs in its own process; still restore what the environment had.
function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = entries => { for (const [key, value] of Object.entries(entries)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  apply(values);
  t.after(() => apply(previous));
}

test('the proxy key comes from the environment, then the config directory, then the legacy data file', t => {
  const { root, configDir, dataDir, write } = dirs(t);
  withEnv(t, { PROXY_KEY: undefined });
  const config = () => getConfig({ configDir, dataDir }, root);
  assert.deepEqual([config().proxyKey, config().proxyKeySource], ['', 'none']);
  write(dataDir, 'legacy-value\n');
  assert.deepEqual([config().proxyKey, config().proxyKeySource, config().proxyKeyFile], ['legacy-value', 'legacy', path.join(dataDir, 'proxy-key')]);
  write(configDir, 'config-value\n');
  assert.deepEqual([config().proxyKey, config().proxyKeySource, config().proxyKeyFile], ['config-value', 'config', path.join(configDir, 'proxy-key')]);
  process.env.PROXY_KEY = 'env-value';
  assert.deepEqual([config().proxyKey, config().proxyKeySource], ['env-value', 'env']);
  assert.deepEqual([getConfig({ configDir, dataDir, proxyKey: 'option-value' }, root).proxyKeySource], ['option']);
});

test('an empty config file falls through, and a key file readable by others is flagged', t => {
  const { root, configDir, dataDir, write } = dirs(t);
  withEnv(t, { PROXY_KEY: undefined });
  write(configDir, '\n'); write(dataDir, 'legacy-value', 0o644);
  const config = getConfig({ configDir, dataDir }, root);
  assert.equal(config.proxyKeySource, 'legacy');
  assert.equal(config.proxyKeyLoose, true);
  write(configDir, 'config-value');
  assert.equal(getConfig({ configDir, dataDir }, root).proxyKeyLoose, false);
});

test('an empty timeout variable falls back to the default; an invalid one is rejected', t => {
  const { root, dataDir } = dirs(t);
  withEnv(t, { MODELS_TIMEOUT_MS: '', ANALYSIS_TIMEOUT_MS: '  ' });
  const config = getConfig({ dataDir, proxyKey: '' }, root);
  assert.deepEqual([config.modelsTimeout, config.analysisTimeout], [5000, 180000]);
  process.env.MODELS_TIMEOUT_MS = ' 2500 ';
  assert.equal(getConfig({ dataDir, proxyKey: '' }, root).modelsTimeout, 2500);
  for (const value of ['0', '-1', '1.5', 'abc', '600001']) {
    process.env.MODELS_TIMEOUT_MS = value;
    assert.throws(() => getConfig({ dataDir, proxyKey: '' }, root), /超时配置/, value);
  }
});

test('the models URL follows the proxy URL, and URLs with credentials are rejected', t => {
  const { root, dataDir } = dirs(t);
  withEnv(t, { PROXY_URL: undefined, MODELS_URL: undefined });
  const config = options => getConfig({ dataDir, proxyKey: '', ...options }, root);
  assert.equal(config().modelsUrl, 'http://127.0.0.1:8317/v1/models');
  assert.equal(config({ proxyUrl: 'https://proxy.example.invalid/api/v1/chat/completions/' }).modelsUrl, 'https://proxy.example.invalid/api/v1/models');
  assert.equal(config({ proxyUrl: 'http://127.0.0.1:9000/v1/chat/completions', modelsUrl: 'http://127.0.0.1:9001/list' }).modelsUrl, 'http://127.0.0.1:9001/list');
  process.env.PROXY_URL = 'http://127.0.0.1:9100/v1/chat/completions';
  assert.equal(config().modelsUrl, 'http://127.0.0.1:9100/v1/models');
  assert.throws(() => config({ proxyUrl: 'http://user:pass@127.0.0.1:8317/v1/chat/completions' }), /PROXY_URL/);
  assert.throws(() => config({ proxyUrl: 'file:///etc/hosts' }), /PROXY_URL/);
  assert.throws(() => config({ modelsUrl: 'http://user@127.0.0.1:8317/v1/models' }), /MODELS_URL/);
});

test('the default config directory follows an absolute XDG_CONFIG_HOME', () => {
  const home = path.join(os.homedir(), '.config', 'tech-mentor-studio');
  assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: '/x/config' }), '/x/config/tech-mentor-studio');
  assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: 'relative/config' }), home);
  assert.equal(defaultConfigDir({}), home);
});

test('the service warns with paths, never the key, while it reads the legacy file', async t => {
  const { root, configDir, dataDir, write } = dirs(t);
  withEnv(t, { PROXY_KEY: undefined });
  write(dataDir, 'legacy-secret-value');
  const warnings = [], original = console.warn;
  console.warn = message => warnings.push(String(message));
  t.after(() => { console.warn = original; });
  const { createApp } = await import('../server.js');
  createApp({ configDir, dataDir, scanRoots: [root], keeperPath: path.join(root, 'none.db') });
  assert.ok(warnings.some(message => message.includes(path.join(dataDir, 'proxy-key')) && message.includes('tech-mentor-studio/proxy-key')));
  assert.ok(warnings.every(message => !message.includes('legacy-secret-value')));
});
