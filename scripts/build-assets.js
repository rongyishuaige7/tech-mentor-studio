import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = path.join(root, 'public/vendor');
fs.mkdirSync(vendor, { recursive: true });
const assets = {
  'dompurify/dist/purify.min.js': 'purify.js',
  'marked/lib/marked.umd.js': 'marked.js',
  'lucide/dist/umd/lucide.min.js': 'lucide.js',
  'highlight.js/styles/github-dark.min.css': 'highlight.css',
  'highlight.js/styles/github.min.css': 'highlight-light.css'
};
for (const [source, name] of Object.entries(assets)) {
  fs.copyFileSync(path.join(root, 'node_modules', source), path.join(vendor, name));
}
await build({
  stdin: { contents: "import hljs from 'highlight.js/lib/common'; window.hljs = hljs;", resolveDir: root },
  bundle: true, minify: true, platform: 'browser', outfile: path.join(vendor, 'highlight.js')
});
await build({
  stdin: { contents: "import mermaid from 'mermaid'; window.mermaid = mermaid;", resolveDir: root },
  bundle: true, minify: true, platform: 'browser', outfile: path.join(vendor, 'mermaid.js')
});
const compiler = await compile(fs.readFileSync(path.join(root, 'assets/tailwind.css'), 'utf8'), {
  base: path.join(root, 'assets'), onDependency() {}
});
const scanner = new Scanner({ sources: compiler.sources });
fs.writeFileSync(path.join(vendor, 'tailwind.css'), compiler.build(scanner.scan()));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(vendor, 'versions.json'), JSON.stringify({ dependencies: manifest.dependencies, build: 'local' }, null, 2));
