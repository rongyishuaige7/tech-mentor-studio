import fs from 'node:fs';
import vm from 'node:vm';

export function loadClient(fetcher) {
  const nodes = new Map();
  function node(id = '') {
    return {
      id, innerHTML: '', textContent: '', value: 'audit-model',
      options: [{ text: 'Audit Model' }], selectedIndex: 0,
      children: [], scrollTop: 0, scrollHeight: 0,
      dataset: {}, classList: {
        values: new Set(['hidden']),
        add(x) { this.values.add(x); }, remove(x) { this.values.delete(x); },
        contains(x) { return this.values.has(x); },
        toggle(x, force) {
          const on = force === undefined ? !this.values.has(x) : Boolean(force);
          if (on) this.values.add(x); else this.values.delete(x);
          return on;
        }
      },
      appendChild(child) { this.children.push(child); },
      insertAdjacentHTML(position, html) { this.innerHTML += html; },
      querySelectorAll() { return []; }, addEventListener() {}
    };
  }
  const document = {
    addEventListener() {}, querySelectorAll() { return []; }, createElement() { return node(); },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node(id));
      return nodes.get(id);
    }
  };
  const context = vm.createContext({
    document, fetch: (url, options) => url === '/api/session'
      ? Promise.resolve({ ok: true, json: async () => ({ token: 'test-session' }) })
      : fetcher(url, options), AbortController, TextDecoder, console,
    DOMPurify: { sanitize: x => x },
    marked: { parse: x => x }, lucide: { createIcons() {} }, hljs: {},
    localStorage: { getItem() { return null; }, setItem() {} }, setTimeout, clearTimeout, alert() {}, navigator: {}
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("modelsReady = true; activeRepo = { id: 'B', name: 'B', path: '/repo/B' }; activeTarget = 'HEAD';", context);
  return { context, nodes, get: expression => vm.runInContext(expression, context),
    run: code => vm.runInContext(code, context) };
}

export function eventResponse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

export const keeperResponse = () => Promise.resolve({ json: async () => ({ success: false }) });
