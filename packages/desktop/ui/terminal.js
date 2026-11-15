(async () => {
  const { invoke } = window.__TAURI__.core, { listen } = window.__TAURI__.event;
  const host = await invoke('term_host');
  document.getElementById('host').textContent = host ? 'ssh ' + host : '';
  const box = document.getElementById('term');
  if (!host) {
    box.innerHTML = '<div id="msg">No server is set up. Open Connection settings, choose server mode and enter the SSH host, then open this window again.</div>';
    document.getElementById('re').remove();
    return;
  }
  const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, fontFamily: 'Cascadia Mono, Consolas, monospace', theme: { background: '#0b0d10' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Clickable links, including ones wrapped over several lines. Opened by Rust in the default browser.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => {
    invoke('term_open_url', { url: uri }).catch((err) => term.write('\r\n\x1b[31m' + err + '\x1b[0m\r\n'));
  }));
  term.open(box);
  fit.fit();
  let current = 0, alive = false;

  // The webview blocks its own clipboard API, so copy and paste go through Rust.
  function copyText(text) { invoke('term_copy', { text }).catch(() => {}); }
  function pasteText() {
    invoke('term_paste').then((t) => { if (alive && t) invoke('term_write', { data: t }); }).catch(() => {});
  }
  // Select to copy (like most terminals), and right-click pastes.
  term.onSelectionChange(() => { if (term.hasSelection()) copyText(term.getSelection()); });
  box.addEventListener('contextmenu', (e) => { e.preventDefault(); pasteText(); });

  // Ctrl+C with a selection copies (otherwise it interrupts); Ctrl+V and Ctrl+Shift+V paste.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) { copyText(term.getSelection()); term.clearSelection(); return false; }
    if (k === 'v') { e.preventDefault(); pasteText(); return false; }
    return true;
  });
  term.onData((d) => { if (alive) invoke('term_write', { data: d }); });
  term.onResize(({ cols, rows }) => { if (alive) invoke('term_resize', { cols, rows }); });
  addEventListener('resize', () => fit.fit());
  new ResizeObserver(() => fit.fit()).observe(box);

  await listen('term-data', (e) => { const [id, text] = e.payload; if (id === current) term.write(text); });
  await listen('term-exit', (e) => {
    if (e.payload !== current) return;
    alive = false;
    term.write('\r\n\x1b[90m[session ended. Press Enter or Reconnect]\x1b[0m\r\n');
  });

  async function start() {
    term.reset();
    try {
      current = await invoke('term_open', { host, cols: term.cols, rows: term.rows });
      alive = true;
      term.focus();
    } catch (err) {
      alive = false;
      term.write('\x1b[31m' + String(err) + '\x1b[0m\r\n');
    }
  }
  document.getElementById('re').onclick = start;
  term.onKey(({ domEvent }) => { if (!alive && domEvent.key === 'Enter') start(); });
  addEventListener('beforeunload', () => invoke('term_close'));
  start();
})();
