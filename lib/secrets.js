import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpError } from './security.js';

const execFileAsync = promisify(execFile);

// Scans text with `gitleaks stdin` and its default rules. It runs in an empty
// directory and ignores `gitleaks:allow`, so the analysed repository cannot
// exempt its own secrets through `.gitleaks.toml`, `.gitleaksignore` or inline
// comments. Findings stay in memory; the report is never written or logged.
// A missing gitleaks is reported as unavailable; any other failure stops the
// request, so nothing is sent unscanned by accident.
export function gitleaksScanner({ binary = 'gitleaks', timeoutMs = 10000 } = {}) {
  return async (text, { signal } = {}) => {
    const neutral = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-gitleaks-'));
    let stdout;
    try {
      const pending = execFileAsync(binary, ['stdin', '--no-banner', '--no-color', '--log-level', 'error', '--exit-code', '0',
        '--ignore-gitleaks-allow', '--report-format', 'json', '--report-path', '-'],
      { cwd: neutral, signal, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      pending.child.stdin.on('error', () => {});
      pending.child.stdin.end(text);
      ({ stdout } = await pending);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.code === 'ENOENT') return { available: false, findings: [] };
      throw httpError(502, error.killed ? '密钥扫描超时，未发送给模型' : '密钥扫描失败，未发送给模型');
    } finally {
      fs.rmSync(neutral, { recursive: true, force: true });
    }
    let report;
    try { report = JSON.parse(stdout || '[]'); } catch { report = null; }
    if (!Array.isArray(report)) throw httpError(502, '密钥扫描结果无法解析，未发送给模型');
    const findings = report.filter(finding => typeof finding?.Secret === 'string' && finding.Secret.length >= 6)
      .map(finding => ({ rule: String(finding.RuleID || '').replace(/[^\w.-]/g, '').slice(0, 60) || 'secret', secret: finding.Secret }));
    return { available: true, findings };
  };
}

// Replaces every occurrence of each flagged value, longest first so a value
// that contains another is replaced whole.
export function redactFindings(text, findings) {
  let result = text;
  for (const { rule, secret } of [...findings].sort((a, b) => b.secret.length - a.secret.length)) {
    result = result.split(secret).join(`[REDACTED:${rule}]`);
  }
  return result;
}
