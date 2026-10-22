import test from 'node:test';
import assert from 'node:assert/strict';
import { gitFixture } from './git-helper.js';
import { collectProjectEvidence, renderProjectTree, selectProjectSources, buildImportGraph, listProjectFiles } from '../lib/project.js';

function demoRepo(t) {
  const fixture = gitFixture(t);
  const { write, commit } = fixture;
  write('package.json', JSON.stringify({
    name: 'demo', main: 'server.js', scripts: { start: 'node server.js' },
    dependencies: { express: '^4.21.2' }, devDependencies: { tap: '1.0.0' }
  }, null, 2));
  write('server.js', [
    "import express from 'express';",
    "import { helper } from './lib/helper.js';",
    'const app = express();',
    "app.get('/api/health', (req, res) => res.json({ ok: helper() }));",
    ''
  ].join('\n'));
  write('lib/helper.js', "import { util } from './util.js';\nexport const helper = () => util();\n");
  write('lib/util.js', 'export const util = () => 1;\n');
  write('lib/unrelated.js', 'export const unrelated = () => 3;\n');
  write('README.md', '# demo\n');
  write('docs/arch.md', 'architecture notes\n');
  write('test/helper.test.js', "import { util } from '../lib/util.js';\n");
  commit('first');
  // A later commit that touches one unrelated file must not narrow the evidence.
  write('lib/unrelated.js', 'export const unrelated = () => 4;\n');
  commit('second');
  return fixture;
}

test('project evidence covers the whole repository, not the latest commit', async t => {
  const { root, git } = demoRepo(t);
  const evidence = await collectProjectEvidence(root);
  assert.equal(evidence.revision, git('rev-parse', 'HEAD').trim());
  assert.match(evidence.tree, /server\.js/);
  assert.match(evidence.tree, /lib\/ \(3\)/);
  assert.match(evidence.deps, /express/);
  assert.match(evidence.imports, /lib\/util\.js ← \d+ 个模块/);
  assert.match(evidence.imports, /lib\/helper\.js -> lib\/util\.js/);
  assert.match(evidence.endpoints, /GET \/api\/health {2}server\.js:4/);
  assert.ok(evidence.documents.some(doc => doc.path === 'README.md'));
  assert.ok(evidence.documents.some(doc => doc.path === 'docs/arch.md'));
  // util.js never appears in the latest commit, yet it is part of the project.
  assert.ok(evidence.sources.some(source => source.path === 'lib/util.js'));
  assert.ok(evidence.sources.some(source => source.path === 'server.js'));
});

test('project evidence excludes dependency directories and sensitive files', async t => {
  const { root, write, commit } = demoRepo(t);
  write('node_modules/pkg/index.js', 'module.exports = "DEPENDENCY-MARKER";\n');
  write('.env', 'SECRET-MARKER=1\n');
  commit('third');
  const evidence = await collectProjectEvidence(root);
  const all = JSON.stringify(evidence);
  assert.ok(!evidence.tree.includes('node_modules'));
  assert.ok(!all.includes('DEPENDENCY-MARKER'));
  assert.ok(!all.includes('SECRET-MARKER'));
  assert.ok(evidence.warnings.some(warning => /未计入清单/.test(warning)));
});

test('the tree listing stops at its budget and says what it dropped', () => {
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `src/deep/file-${i}.js`, size: 100 + i }));
  const tree = renderProjectTree(files, { limit: 400 });
  assert.match(tree, /^src\/deep\/ \(200\)$/m);
  assert.match(tree, /其余 \d+ 个文件未列出/);
  assert.ok(tree.length < 600);
});

test('sources prefer entry points and the modules others depend on', async t => {
  const { root } = demoRepo(t);
  const { files } = await listProjectFiles(root, 'HEAD');
  const graph = await buildImportGraph(root, 'HEAD', files);
  const sources = selectProjectSources(files, graph, '{"main":"server.js"}');
  assert.equal(sources[0], 'server.js');
  assert.ok(sources.includes('lib/util.js'), sources.join(','));
  assert.ok(sources.includes('lib/helper.js'), sources.join(','));
  assert.ok(sources.length <= 16);
});
