import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function timeout(value, fallback) {
  // An exported but empty variable (MODELS_TIMEOUT_MS=) means unset, not 0.
  const n = Number(typeof value === 'string' && !value.trim() ? fallback : value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 600000) throw new Error('超时配置必须为 1 到 600000 毫秒');
  return n;
}

// The key lives outside the project by default: a project on an iCloud-synced
// Desktop uploads files under data/ even at mode 600.
export function defaultConfigDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
  return path.join(base, 'tech-mentor-studio');
}

function readKeyFile(file) {
  if (!fs.existsSync(file)) return null;
  return { key: fs.readFileSync(file, 'utf8').trim(), loose: Boolean(fs.statSync(file).mode & 0o077) };
}

export function getConfig(options, root) {
  const dataDir = options.dataDir || path.join(root, 'data');
  const proxyUrl = options.proxyUrl || process.env.PROXY_URL || 'http://127.0.0.1:8317/v1/chat/completions';
  const parsed = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('PROXY_URL 必须是无内嵌凭据的 HTTP 地址');
  const models = new URL(options.modelsUrl || process.env.MODELS_URL || proxyUrl);
  if (!options.modelsUrl && !process.env.MODELS_URL) models.pathname = parsed.pathname.replace(/\/chat\/completions\/?$/, '/models');
  if (!['http:', 'https:'].includes(models.protocol) || models.username || models.password) throw new Error('MODELS_URL 必须是无内嵌凭据的 HTTP 地址');
  // Order: explicit option (tests), PROXY_KEY, the config directory, then the
  // legacy data/proxy-key. Only the source and path are reported, never the key.
  let proxyKey = '', proxyKeySource = 'none', proxyKeyFile = null, proxyKeyLoose = false;
  if (Object.hasOwn(options, 'proxyKey')) { proxyKey = options.proxyKey; proxyKeySource = 'option'; }
  else if (process.env.PROXY_KEY) { proxyKey = process.env.PROXY_KEY; proxyKeySource = 'env'; }
  else {
    const candidates = [['config', path.join(options.configDir || defaultConfigDir(), 'proxy-key')], ['legacy', path.join(dataDir, 'proxy-key')]];
    for (const [source, file] of candidates) {
      const found = readKeyFile(file);
      if (found?.key) { ({ key: proxyKey, loose: proxyKeyLoose } = found); proxyKeySource = source; proxyKeyFile = file; break; }
    }
  }
  return {
    proxyUrl, proxyKey, proxyKeySource, proxyKeyFile, proxyKeyLoose,
    modelsUrl: models.href,
    keeperPath: options.keeperPath || process.env.KEEPER_DB_PATH || '/opt/homebrew/var/cpa-usage-keeper/app.db',
    modelsTimeout: timeout(options.modelsTimeout ?? process.env.MODELS_TIMEOUT_MS, 5000),
    analysisTimeout: timeout(options.analysisTimeout ?? process.env.ANALYSIS_TIMEOUT_MS, 180000)
  };
}
