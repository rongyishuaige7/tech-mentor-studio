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
  } catch {
    // Keep the document's default (dark) when storage or matchMedia is blocked.
  }
})();
