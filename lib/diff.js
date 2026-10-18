import { isSensitiveFile } from './security.js';

const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|Pipfile\.lock|poetry\.lock|\.DS_Store)$|\.(min\.(js|css)|bundle\.js|map|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|mp4|webm|zip|pyc|tar\.gz)$/i;
export const isNoiseFile = name => NOISE.test(name) || name.includes('__pycache__/');

export function decodeGitPath(value) {
  if (!value.startsWith('"')) return value.replace(/\t$/, '');
  const bytes = [];
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '"') break;
    if (value[i] !== '\\') {
      const point = value.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    } else {
      const octal = value.slice(i + 1).match(/^[0-7]{1,3}/);
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; }
      else {
        const escaped = value[++i];
        const replacements = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07' };
        bytes.push(...Buffer.from(replacements[escaped] || escaped || ''));
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function quoteGitPath(name) {
  return '"' + name.replace(/["\\\x00-\x1f\x7f]/g, char => {
    const escapes = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
    return escapes[char] || '\\' + char.charCodeAt(0).toString(8).padStart(3, '0');
  }) + '"';
}

// An unquoted header is ambiguous when a path contains " b/". Like git apply,
// prefer the split where both sides name the same path; renames and content
// changes are corrected later by their explicit rename/---/+++ lines.
function splitPlainHeader(header) {
  const length = (header.length - 5) / 2;
  if (Number.isInteger(length) && length > 0) {
    const name = header.slice(2, 2 + length);
    if (header === `a/${name} b/${name}`) return [name, name];
  }
  const match = header.match(/^a\/(.*?) b\/(.*)$/);
  return match ? [match[1], match[2]] : [];
}

export function parseDiffFiles(diffText) {
  if (!diffText) return [];
  const index = diffText.search(/^diff --git /m);
  if (index < 0) return [];
  return diffText.slice(index).split(/^diff --git /m).filter(Boolean).map(chunk => {
    const lines = chunk.split('\n');
    const header = lines[0];
    const quoted = header.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
    const plain = quoted ? [] : splitPlainHeader(header);
    let oldPath = quoted ? decodeGitPath(quoted[1]).slice(2) : plain[0];
    let filePath = quoted ? decodeGitPath(quoted[2]).slice(2) : plain[1];
    let additions = 0, deletions = 0, oldRemaining = 0, newRemaining = 0;
    let isLink = false;
    for (const line of lines.slice(1)) {
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) { oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1); continue; }
      if (oldRemaining || newRemaining) {
        if (line.startsWith('+')) { additions++; newRemaining--; }
        else if (line.startsWith('-')) { deletions++; oldRemaining--; }
        else if (line.startsWith(' ')) { oldRemaining--; newRemaining--; }
        continue;
      }
      if (line.startsWith('+++ ')) {
        const value = decodeGitPath(line.slice(4));
        if (value !== '/dev/null') filePath = value.startsWith('b/') ? value.slice(2) : value;
      } else if (line.startsWith('--- ')) {
        const value = decodeGitPath(line.slice(4));
        if (value !== '/dev/null') oldPath = value.startsWith('a/') ? value.slice(2) : value;
      } else if (line.startsWith('rename to ')) filePath = decodeGitPath(line.slice(10));
      else if (line.startsWith('rename from ')) oldPath = decodeGitPath(line.slice(12));
      else if (line.startsWith('copy to ')) filePath = decodeGitPath(line.slice(8));
      else if (line.startsWith('copy from ')) oldPath = decodeGitPath(line.slice(10));
      if (/^(new file mode|old mode|new mode|deleted file mode) 120000$/.test(line) || /^index [\da-f]+\.\.[\da-f]+ 120000$/.test(line)) isLink = true;
    }
    filePath ||= oldPath || 'unknown';
    const previousPath = oldPath && oldPath !== filePath ? oldPath : null;
    // Renaming or copying a sensitive file must not turn it into a normal file.
    // Classify both sides so a patch cannot leak the old contents under a new name.
    const sensitive = isSensitiveFile(filePath) || Boolean(previousPath && isSensitiveFile(previousPath));
    return {
      path: filePath, oldPath: previousPath,
      additions, deletions, isNoise: isNoiseFile(filePath), isSensitive: sensitive, isLink,
      patch: 'diff --git ' + chunk
    };
  });
}

export function newFilePatch(name, content, executable = false) {
  const lines = content.split('\n');
  const hasNewline = content.endsWith('\n');
  if (hasNewline || !content) lines.pop();
  const quotedA = quoteGitPath('a/' + name), quotedB = quoteGitPath('b/' + name);
  let patch = `diff --git ${quotedA} ${quotedB}\nnew file mode ${executable ? '100755' : '100644'}\n--- /dev/null\n+++ ${quotedB}\n`;
  if (lines.length) patch += `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') + '\n';
  if (content && !hasNewline) patch += '\\ No newline at end of file\n';
  return patch;
}

// Models cannot reliably count lines from hunk headers. Prefix each hunk line
// with its real line number: new-file numbers for "+" and " ", old-file for "-".
export function numberDiffLines(patch) {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  return patch.split('\n').map(line => {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      return line;
    }
    if (!oldRemaining && !newRemaining) return line;
    if (line.startsWith('+')) { newRemaining--; return `+${newLine++}|${line.slice(1)}`; }
    if (line.startsWith('-')) { oldRemaining--; return `-${oldLine++}|${line.slice(1)}`; }
    if (line.startsWith(' ')) { oldRemaining--; newRemaining--; oldLine++; return ` ${newLine++}|${line.slice(1)}`; }
    return line;
  }).join('\n');
}

export function getCleanDiffForMentor(files, focusFile = null, budget = 60000) {
  let selected = files.filter(file => !file.isSensitive && !file.isLink);
  if (focusFile) selected = selected.filter(file => file.path === focusFile);
  else {
    const code = selected.filter(file => !file.isNoise);
    if (code.length) selected = code;
  }
  const result = [];
  for (let i = 0; i < selected.length && budget > 100; i++) {
    const file = selected[i];
    const allowance = Math.max(100, Math.floor(budget / (selected.length - i)) - 100);
    let text = file.patch;
    if (text.length > allowance) {
      text = text.slice(0, allowance);
      const newline = text.lastIndexOf('\n');
      if (newline > allowance / 2) text = text.slice(0, newline);
      text += `\n# [${JSON.stringify(file.path)} 内容已截断；不能据此判断未展示的代码]\n`;
    }
    result.push(text); budget -= text.length + 1;
  }
  if (result.length < selected.length) result.push(`# [另有 ${selected.length - result.length} 个文件未展示]`);
  return result.join('\n');
}
