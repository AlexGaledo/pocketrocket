// Runs before first paint so the page never flashes the wrong theme. A file, not an inline script,
// so the hub's CSP can keep script-src free of 'unsafe-inline'.
try {
  var f = localStorage.getItem('pocketrocket.font');
  if (f) document.documentElement.dataset.font = f;
  var t = localStorage.getItem('pocketrocket.theme');
  // A stored 'system' means the same as nothing stored: follow the OS.
  if (t === 'dark' || ((!t || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
