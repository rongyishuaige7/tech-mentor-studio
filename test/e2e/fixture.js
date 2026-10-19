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
    files: [{ path: name, patch, additions: 1, deletions: 1 }], hasFacts: false
  } }));
  await page.route('**/api/models', route => route.fulfill({ json: { success: true, models: [{ id: 'test-model', name: 'Test Model' }] } }));
  await page.route('**/api/tokens/keeper-stats', route => route.fulfill({ json: { success: false } }));
}

// WCAG contrast ratios for the theme tokens used by small text, plus the first
// rendered Mermaid message against its container, in the current theme.
export async function contrastReport(page) {
  return page.evaluate(() => {
    const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const luminance = color => {
      const [r, g, b] = rgb(color).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; };
    const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const pairs = [['--text-muted', '--bg-header'], ['--text-muted', '--bg-bubble-assistant'], ['--text-muted', '--bg-bubble-user'],
      ['--text-muted', '--code-block-header'], ['--text-muted', '--bg-diff-content'], ['--diff-hunk-text', '--bg-diff-content'],
      ['--diff-del-text', '--bg-bubble-assistant'], ['--diff-del-text', '--bg-panel-repos']];
    const report = Object.fromEntries(pairs.map(([fg, bg]) => [`${fg} on ${bg}`, ratio(token(fg), token(bg))]));
    const box = document.querySelector('.mermaid svg')?.closest('.mermaid');
    const text = box?.querySelector('.messageText');
    if (text) report['mermaid message text'] = ratio(getComputedStyle(text).fill, getComputedStyle(box).backgroundColor);
    return report;
  });
}

