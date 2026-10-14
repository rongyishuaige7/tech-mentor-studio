import fs from 'node:fs';
import path from 'node:path';

function timeout(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 600000) throw new Error('超时配置必须为 1 到 600000 毫秒');
  return n;
}

export function getConfig(options, root) {
  const dataDir = options.dataDir || path.join(root, 'data');
  const proxyUrl = options.proxyUrl || process.env.PROXY_URL || 'http://127.0.0.1:8317/v1/chat/completions';
  const parsed = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('PROXY_URL 必须是无内嵌凭据的 HTTP 地址');
  const models = new URL(options.modelsUrl || process.env.MODELS_URL || proxyUrl);
  if (!options.modelsUrl && !process.env.MODELS_URL) models.pathname = parsed.pathname.replace(/\/chat\/completions\/?$/, '/models');
  if (!['http:', 'https:'].includes(models.protocol) || models.username || models.password) throw new Error('MODELS_URL 必须是无内嵌凭据的 HTTP 地址');
  const keyFile = path.join(dataDir, 'proxy-key');
  const proxyKey = Object.hasOwn(options, 'proxyKey') ? options.proxyKey
    : process.env.PROXY_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
  return {
    proxyUrl, proxyKey,
    modelsUrl: models.href,
    keeperPath: options.keeperPath || process.env.KEEPER_DB_PATH || '/opt/homebrew/var/cpa-usage-keeper/app.db',
    modelsTimeout: timeout(options.modelsTimeout ?? process.env.MODELS_TIMEOUT_MS, 5000),
    analysisTimeout: timeout(options.analysisTimeout ?? process.env.ANALYSIS_TIMEOUT_MS, 180000)
  };
}
