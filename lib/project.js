import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpError, isSensitiveFile } from './security.js';
import { generatedDir } from './diff.js';
import { readVersionTexts, documentExcerpt } from './facts.js';
import { getStatus } from './git.js';

const execFileAsync = promisify(execFile);

// `git grep` exits 1 when nothing matches; that is an empty result, not a
// failure. Everything else keeps the same error contract as lib/git.js.
async function gitText(args, cwd, { signal, maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, signal, timeout: 15000, maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' }
    });
    return stdout;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code === 1 && !String(error.stderr || '').trim()) return '';
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw httpError(413, '项目清单超过 8 MiB 上限');
    if (error.killed) throw httpError(504, 'Git 操作超时，请稍后重试');
    throw httpError(400, 'Git 操作失败，请检查仓库状态');
  }
}

const CODE_FILE = /\.(m?js|cjs|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs|swift)$/;
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];
const ROOT_DOCS = ['README.md', 'AGENTS.md', 'CLAUDE.md'];
const SOURCE_BUDGET = 60000, DOC_BUDGET = 18000, TREE_BUDGET = 12000, DEP_BUDGET = 6000;
const SOURCE_LIMIT = 16, SOURCE_FLOOR = 1500, DOC_FLOOR = 2000;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//;

export async function projectHead(repo, options) {
  const sha = (await gitText(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], repo, options)).trim();
  if (!sha) throw httpError(400, '仓库还没有提交，无法生成项目快照');
  const branch = (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], repo, options)).trim();
  return { sha, branch: branch === 'HEAD' ? '' : branch };
}

// One `ls-tree -r -l` lists every tracked blob with its size, so the inventory
// costs a single git process. Dependency and cache directories, links and
// sensitive files never reach the model.
export async function listProjectFiles(repo, revision, options) {
  const output = await gitText(['ls-tree', '-r', '-l', '-z', revision], repo, options);
  const files = [];
  let omitted = 0;
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, , size] = record.slice(0, tab).trim().split(/\s+/);
    const name = record.slice(tab + 1);
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || isSensitiveFile(name) || generatedDir(name)) { omitted++; continue; }
    files.push({ path: name, size: Number(size) || 0 });
  }
  return { files, omitted };
}

const formatSize = bytes => bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}k` : `${(bytes / 1048576).toFixed(1)}M`;

// Directory-grouped listing with sizes: enough for the model to see the module
// layout and where the weight sits, bounded so a huge repository still fits.
export function renderProjectTree(files, { limit = TREE_BUDGET } = {}) {
  const groups = new Map();
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const dir = path.posix.dirname(file.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  const lines = [];
  let used = 0, shown = 0;
  for (const [dir, entries] of groups) {
    const head = `${dir === '.' ? './' : `${dir}/`} (${entries.length})`;
    if (used + head.length + 1 > limit) break;
    lines.push(head); used += head.length + 1;
    for (const entry of entries) {
      const line = `  ${path.posix.basename(entry.path)} ${formatSize(entry.size)}`;
      if (used + line.length + 1 > limit) break;
      lines.push(line); used += line.length + 1; shown++;
    }
  }
  const rest = files.length - shown;
  if (rest > 0) lines.push(`… 其余 ${rest} 个文件未列出`);
  return lines.join('\n');
}

// Relative import/require edges plus the packages a project actually uses.
// Edges that leave the repository are kept as external dependencies instead.
export async function buildImportGraph(repo, revision, files, options) {
  const present = new Set(files.map(file => file.path));
  const output = await gitText(['grep', '-n', '-I', '-E', "from ['\"]|require\\(|import\\(|import ['\"]", revision, '--', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.py'], repo, options);
  const edges = [], external = new Map();
  let truncated = false;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const rest = line.slice(line.indexOf(':') + 1);
    const match = rest.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const [, from, , text] = match;
    const specifier = (text.match(/from\s+['"]([^'"]+)['"]/) || text.match(/require\(\s*['"]([^'"]+)['"]\s*\)/) || text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/) || text.match(/import\s+['"]([^'"]+)['"]/))?.[1];
    // Python imports are bare module names; only the package is recorded, and
    // relative imports are left out rather than guessed at.
    const python = !specifier && from.endsWith('.py')
      ? (text.match(/^\s*from\s+([\w.]+)\s+import\b/) || text.match(/^\s*import\s+([\w.]+)/))?.[1] : null;
    if (python) {
      if (!python.startsWith('.')) external.set(python.split('.')[0], (external.get(python.split('.')[0]) || 0) + 1);
      continue;
    }
    if (!specifier) continue;
    if (specifier.startsWith('.')) {
      const dir = path.posix.dirname(from);
      let target = path.posix.normalize(path.posix.join(dir, specifier));
      if (!path.posix.extname(target)) {
        const candidate = ['.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.ts'].map(ext => target + ext).find(name => present.has(name));
        if (candidate) target = candidate;
      }
      if (!present.has(target)) continue;
      if (edges.length >= 600) { truncated = true; break; }
      edges.push({ from, to: target });
    } else if (!specifier.startsWith('/') && !specifier.startsWith('node:')) {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (name && name !== '.' && name !== '..') external.set(name, (external.get(name) || 0) + 1);
    }
  }
  const inDegree = new Map();
  for (const edge of edges) inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  // Test helpers are imported a lot but they describe the harness, not the runtime.
  const hubs = [...inDegree].filter(([file]) => !TEST_PATH.test(file))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([file, count]) => ({ path: file, count }));
  const packages = [...external].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 30).map(([name, count]) => ({ name, count }));
  return { edges, hubs, packages, truncated };
}

export function renderImports(graph, { limit = 20000 } = {}) {
  const lines = [];
  if (graph.hubs.length) {
    lines.push('被依赖最多的模块：');
    for (const hub of graph.hubs) lines.push(`  ${hub.path} ← ${hub.count} 个模块`);
  }
  if (graph.packages.length) {
    lines.push('外部依赖（按引用文件数）：');
    lines.push(`  ${graph.packages.map(item => `${item.name}(${item.count})`).join(', ')}`);
  }
  lines.push('模块引用边：');
  let used = lines.join('\n').length;
  let shown = 0;
  for (const edge of graph.edges) {
    const line = `  ${edge.from} -> ${edge.to}`;
    if (used + line.length + 1 > limit) break;
    lines.push(line); used += line.length + 1; shown++;
  }
  if (shown < graph.edges.length) lines.push(`… 其余 ${graph.edges.length - shown} 条引用边未列出`);
  return lines.join('\n');
}

const ROUTE_LINE = /\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/;
const CALL_LINE = /(?:apiFetch|fetch)\(\s*['"`]([^'"`]*\/api\/[^'"`]*)['"`]/;

// HTTP surface in one pass: routes the server registers and API paths the
// client calls. This is the skeleton of the request data path.
export async function collectEndpoints(repo, revision, options) {
  const globs = ['*.js', '*.mjs', '*.cjs', '*.ts'];
  const [server, client] = await Promise.all([
    gitText(['grep', '-n', '-I', '-E', '\\.(get|post|put|patch|delete)\\(\\s*[\'"`]/', revision, '--', ...globs], repo, options),
    gitText(['grep', '-n', '-I', '-E', '(apiFetch|fetch)\\(\\s*[\'"`][^\'"`]*/api/', revision, '--', ...globs], repo, options)
  ]);
  const parse = (output, kind) => output.split('\n').filter(Boolean).flatMap(line => {
    const rest = line.slice(line.indexOf(':') + 1);
    const match = rest.match(/^(.+?):(\d+):(.*)$/);
    if (!match) return [];
    const [, file, number, text] = match;
    // A test that calls a route says nothing about the runtime surface.
    if (TEST_PATH.test(file)) return [];
    const route = kind === 'server' ? text.match(ROUTE_LINE) : text.match(CALL_LINE);
    if (!route) return [];
    const routePath = route[kind === 'server' ? 2 : 1].replace(/\$\{.*$/, '…');
    return [kind === 'server'
      ? { kind, method: route[1].toUpperCase(), route: routePath, file, line: Number(number) }
      : { kind, method: 'CALL', route: routePath, file, line: Number(number) }];
  });
  const endpoints = [...parse(server, 'server'), ...parse(client, 'client')];
  return { endpoints: endpoints.slice(0, 120), truncated: endpoints.length > 120 };
}

export function renderEndpoints(endpoints) {
  const lines = ['服务端路由：'];
  for (const item of endpoints.filter(entry => entry.kind === 'server')) lines.push(`  ${item.method} ${item.route}  ${item.file}:${item.line}`);
  const calls = endpoints.filter(entry => entry.kind === 'client');
  if (calls.length) {
    lines.push('前端调用：');
    for (const item of calls) lines.push(`  ${item.route}  ${item.file}:${item.line}`);
  }
  return lines.join('\n');
}

function parseManifest(text) {
  try {
    const pkg = JSON.parse(text);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return { pkg, deps };
  } catch { return { pkg: {}, deps: {} }; }
}

function entryPointsFor(files, manifestText) {
  const present = new Set(files.map(file => file.path));
  const names = [];
  const { pkg } = parseManifest(manifestText);
  const bin = pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : [pkg.bin];
  for (const value of [pkg.main, pkg.module, ...bin, ...Object.values(pkg.scripts || {})]) {
    if (typeof value !== 'string') continue;
    const match = value.match(/[\w./@-]+\.(?:m?js|cjs|ts|py|go|rs)/);
    if (match && present.has(match[0])) names.push(match[0]);
  }
  for (const name of ['server.js', 'app.js', 'index.js', 'main.js', 'src/index.js', 'src/main.js', 'index.html', 'main.py', 'app.py', 'cmd/main.go']) {
    if (present.has(name)) names.push(name);
  }
  return [...new Set(names)];
}

// Sources are chosen by role — entry points, the modules others depend on, and
// the largest module of each top-level directory — not by what a commit touched.
export function selectProjectSources(files, graph, manifestText, { limit = SOURCE_LIMIT } = {}) {
  const bySize = [...files].sort((a, b) => b.size - a.size);
  const code = new Map(bySize.filter(file => CODE_FILE.test(file.path)).map(file => [file.path, file]));
  const picked = [];
  const add = name => { if (code.has(name) && !picked.includes(name)) picked.push(name); };
  for (const name of entryPointsFor(files, manifestText)) add(name);
  // Test helpers can be hubs; they still describe the harness, not the runtime.
  for (const hub of graph.hubs) if (!TEST_PATH.test(hub.path)) add(hub.path);
  const perDir = new Map();
  for (const file of [...code.values()].sort((a, b) => b.size - a.size)) {
    const dir = file.path.includes('/') ? file.path.split('/')[0] : '.';
    const count = perDir.get(dir) || 0;
    if (count >= 2) continue;
    perDir.set(dir, count + 1);
    add(file.path);
  }
  return picked.slice(0, limit);
}

async function readTexts(repo, names, revision, options) {
  const results = await readVersionTexts(repo, names, revision, options);
  return name => results.get(name)?.text;
}

// Light overview for the middle panel: no file contents beyond the manifest.
export async function buildProjectOverview(repo, options = {}) {
  const { sha, branch } = await projectHead(repo, options);
  const { files, omitted } = await listProjectFiles(repo, sha, options);
  const { endpoints } = await collectEndpoints(repo, sha, options);
  const dirty = (await getStatus(repo, options)).length;
  const text = await readTexts(repo, MANIFESTS, sha, options);
  const manifest = MANIFESTS.find(name => text(name) !== undefined);
  const { deps } = parseManifest(manifest === 'package.json' ? text('package.json') : '');
  const graph = await buildImportGraph(repo, sha, files, options);
  const documents = files.filter(file => /^(README|AGENTS|CLAUDE)\.md$/.test(file.path) || /^docs\/.*\.md$/.test(file.path));
  return {
    revision: sha, branch, files, omitted, endpoints, graph, documents, manifest, deps,
    entryPoints: entryPointsFor(files, manifest === 'package.json' ? text('package.json') : ''),
    stats: {
      files: files.length, omitted,
      codeFiles: files.filter(file => CODE_FILE.test(file.path)).length,
      directories: new Set(files.map(file => path.posix.dirname(file.path))).size,
      edges: graph.edges.length, endpoints: endpoints.length,
      documents: documents.length, dirty
    }
  };
}

export function renderDependencies(manifest, deps, graph) {
  const lines = [];
  if (manifest) lines.push(`清单：${manifest}`);
  const entries = Object.entries(deps);
  if (entries.length) lines.push(`依赖：${entries.map(([name, version]) => `${name} ${version}`).join(', ')}`);
  const used = graph.packages.filter(item => deps[item.name]);
  if (used.length) lines.push(`代码中实际引用：${used.map(item => `${item.name}(${item.count})`).join(', ')}`);
  return lines.join('\n');
}

// The whole-project evidence a walkthrough needs: inventory, stack, dependency
// graph, HTTP surface, docs and role-selected sources.
export async function collectProjectEvidence(repo, options = {}) {
  const overview = await buildProjectOverview(repo, options);
  const { revision, files, graph } = overview;
  const warnings = [];
  if (overview.omitted) warnings.push(`${overview.omitted} 个依赖、缓存、符号链接或敏感文件未计入清单`);
  if (overview.stats.dirty) warnings.push(`工作区有 ${overview.stats.dirty} 个未提交改动，本次项目快照读取 HEAD ${revision.slice(0, 8)}，未提交内容未计入`);
  if (graph.truncated) warnings.push('模块引用边超过 600 条，仅保留前 600 条');
  if (overview.endpoints.length >= 120) warnings.push('HTTP 端点超过 120 个，仅保留前 120 个');

  const manifestText = overview.manifest ? (await readTexts(repo, [overview.manifest], revision, options))(overview.manifest) : undefined;
  const deps = renderDependencies(overview.manifest, overview.deps, graph);

  const docNames = [...ROOT_DOCS, ...overview.documents.filter(file => file.path.startsWith('docs/')).sort((a, b) => b.size - a.size).map(file => file.path)].slice(0, 8);
  const sourceNames = selectProjectSources(files, graph, manifestText || '');
  if (!sourceNames.length) warnings.push('没有可读取的源码文件，证据仅含清单与文档');
  const text = await readTexts(repo, [...docNames, ...sourceNames], revision, options);

  const documents = [];
  let docBudget = DOC_BUDGET;
  for (let i = 0; i < docNames.length; i++) {
    const body = text(docNames[i]);
    if (body === undefined) continue;
    if (docBudget < 200) { warnings.push('项目文档达到预算，部分文档未展示'); break; }
    const limit = Math.min(docBudget, Math.max(DOC_FLOOR, Math.floor(docBudget / (docNames.length - i))));
    const view = documentExcerpt(body, limit);
    documents.push({ path: docNames[i], ...view });
    docBudget -= view.excerpt.length;
  }

  const sources = [];
  let sourceBudget = SOURCE_BUDGET;
  const available = sourceNames.filter(name => text(name) !== undefined);
  for (let i = 0; i < available.length; i++) {
    if (sourceBudget < 200) { warnings.push('源码片段达到预算，部分文件未展示'); break; }
    const limit = Math.min(sourceBudget, Math.max(SOURCE_FLOOR, Math.floor(sourceBudget / (available.length - i))));
    const view = documentExcerpt(text(available[i]), limit);
    sources.push({ path: available[i], ...view });
    sourceBudget -= view.excerpt.length;
  }

  return {
    revision, branch: overview.branch, stats: overview.stats,
    tree: renderProjectTree(files),
    deps, imports: renderImports(graph), endpoints: renderEndpoints(overview.endpoints),
    documents, sources, warnings,
    hubs: graph.hubs, entryPoints: overview.entryPoints
  };
}
