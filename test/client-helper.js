import fs from 'node:fs';
import vm from 'node:vm';

export function loadClient(fetcher) {
  const nodes = new Map();
  function node(id = '') {
    return {
      id, innerHTML: '', textContent: '', value: 'audit-model',
      options: [{ text: 'Audit Model' }], selectedIndex: 0,
      children: [], scrollTop: 0, scrollHeight: 0,
      classList: {
        values: new Set(['hidden']),
        add(x) { this.values.add(x); }, remove(x) { this.values.delete(x); },
        contains(x) { return this.values.has(x); }
      },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return []; }, addEventListener() {}
    };
  }
  const document = {
    addEventListener() {}, createElement() { return node(); },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node(id));
      return nodes.get(id);
    }
  };
  const context = vm.createContext({
    document, fetch: fetcher, AbortController, TextDecoder, console,
    marked: { parse: x => x }, lucide: { createIcons() {} }, hljs: {},
    setTimeout, clearTimeout, alert() {}, navigator: {}
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("activeRepo = { id: 'B', name: 'B', path: '/repo/B' }; activeTarget = 'HEAD';", context);
  return { context, nodes, get: expression => vm.runInContext(expression, context) };
}

export function eventResponse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

export const keeperResponse = () => Promise.resolve({ json: async () => ({ success: false }) });
