// Apply the saved theme before the first paint. This file is intentionally
// separate from app.js (which is deferred) so light-mode users do not get a
// dark flash while the DOM finishes loading.
(function () {
  try {
    const saved = localStorage.getItem('mentor-theme');
    const dark = saved ? saved === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.classList.toggle('dark', dark);
    const highlight = document.getElementById('highlight-theme');
    if (highlight) highlight.href = dark ? '/vendor/highlight.css' : '/vendor/highlight-light.css';
    // The panel width is applied here too, so a stored split does not flash the
    // default width before app.js runs. app.js re-clamps it against real widths.
    const stored = Number(localStorage.getItem('mentor-diff-width'));
    if (Number.isFinite(stored) && stored > 0) {
      const repos = window.innerWidth > 1450 ? 288 : 230;
      const max = Math.max(320, window.innerWidth - repos - 420);
      document.documentElement.style.setProperty('--diff-panel-width', `${Math.min(stored, max)}px`);
    }
  } catch {
    // Keep the document's default (dark) when storage or matchMedia is blocked.
  }
})();
