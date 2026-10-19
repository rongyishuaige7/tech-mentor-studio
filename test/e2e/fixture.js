export async function fixture(page, options = {}) {
  const name = options.path || "x');window.__auditExecuted=1;//.js";
  const patch = options.patch || `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`;
  await page.route(/\/api\/repos(?:\?.*)?$/, route => route.fulfill({ json: { success: true, repos: [
    { id: 'fixture', name: 'Fixture', path: '/fixture', branch: 'main', dirtyCount: 0 }
  ] } }));
  await page.route('**/api/repos/fixture/commits', route => route.fulfill({ json: { success: true,
    commits: [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', msg: 'fixture', author: 'audit', relTime: 'now' }], presets: [], dirtyCount: 0
  } }));
  await page.route('**/api/repos/fixture/diff?*', route => route.fulfill({ json: { success: true,
    files: [{ path: name, patch, additions: 1, deletions: 1 }], diffText: patch, hasFacts: false
  } }));
  await page.route('**/api/models', route => route.fulfill({ json: { success: true, models: [{ id: 'test-model', name: 'Test Model' }] } }));
  await page.route('**/api/tokens/keeper-stats', route => route.fulfill({ json: { success: false } }));
}

