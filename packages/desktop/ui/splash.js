  const T = window.__TAURI__;
  const invoke = (cmd, args) => T ? T.core.invoke(cmd, args) : Promise.reject(new Error('not in tauri'));
  const $ = (id) => document.getElementById(id);
  const MODES = ['local', 'remote', 'attach'];
  const cards = { local: $('card-local'), remote: $('card-remote'), attach: $('card-attach') };

  let cfg = { mode: 'local', sshHost: '', port: 7788, hubDir: null };
  let selectedMode = cfg.mode;
  let lastStatus = null;
  let busy = false;
  // Once a connection is set up the other modes stay folded away behind "Change", so day to day the page
  // only shows where the bots run. First run always shows every option.
  let pickerOpen = false;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const c of children || []) if (c != null) n.append(c);
    return n;
  }
  function errText(e) { return (e && e.message) || String(e); }
  function showActionError(msg) {
    $('action-error').textContent = msg || '';
    $('action-error').hidden = !msg;
  }

  // ---- validation ----
  function portValue() {
    const raw = $('port-input').value.trim();
    const n = Number(raw);
    return raw !== '' && Number.isInteger(n) ? n : NaN;
  }
  function portError() {
    const n = portValue();
    return n >= 1024 && n <= 65535 ? '' : 'Use a whole number from 1024 to 65535.';
  }
  function hostError(h) {
    if (!h) return 'Enter the SSH host: a Host alias from ~/.ssh/config, or user@server.';
    if (h.startsWith('-')) return 'An SSH host can’t start with "-".';
    if (/\s/.test(h)) return 'An SSH host can’t contain spaces.';
    return '';
  }
  function setFieldError(input, box, msg) {
    box.textContent = msg;
    box.hidden = !msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function isDirty() {
    if (selectedMode !== cfg.mode) return true;
    if (selectedMode === 'remote' && $('host-input').value.trim() !== (cfg.sshHost || '')) return true;
    if (portValue() !== cfg.port) return true;
    return false;
  }

  function renderIndicator(mode) {
    const slot = cards[mode].querySelector('.mode-indicator');
    const firstRun = lastStatus && lastStatus.firstRun;
    if (mode === cfg.mode && !firstRun) {
      slot.innerHTML = '<span class="check-badge">✓</span><span class="pill-active">Active</span>';
    } else if (mode === selectedMode) {
      slot.innerHTML = '<span class="ring-badge"></span>';
    } else {
      slot.innerHTML = '';
    }
  }

  function render() {
    const s = lastStatus || {};
    const showPicker = !!s.firstRun || pickerOpen;
    for (const mode of MODES) {
      const card = cards[mode];
      const selected = mode === selectedMode;
      card.hidden = !showPicker && mode !== cfg.mode;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-checked', String(selected));
      card.tabIndex = selected ? 0 : -1;
      renderIndicator(mode);
    }
    $('advanced-label').hidden = !showPicker;
    $('fields-remote').hidden = !showPicker || selectedMode !== 'remote';
    $('fields-port').hidden = !showPicker;
    const change = $('change');
    change.hidden = !!s.firstRun || !lastStatus;
    change.textContent = pickerOpen ? 'Cancel' : 'Change';
    change.setAttribute('aria-expanded', String(pickerOpen));
    $('datadir-line').hidden = !(selectedMode === 'local' && s.dataDir);
    if (s.dataDir) $('datadir-value').textContent = s.dataDir;
    $('hubdir-line').hidden = !cfg.hubDir;
    if (cfg.hubDir) $('hubdir-value').textContent = cfg.hubDir;
    $('intro').hidden = !s.firstRun;

    const hostMsg = selectedMode === 'remote' ? hostError($('host-input').value.trim()) : '';
    const portMsg = portError();
    // only complain about a host once there is something typed, or on save
    setFieldError($('host-input'), $('host-error'), $('host-input').dataset.touched ? hostMsg : '');
    setFieldError($('port-input'), $('port-error'), portMsg);

    const dirty = isDirty();
    const connected = !!s.connected;
    const save = $('save');
    save.textContent = s.firstRun && !dirty ? 'Start' : 'Save and connect';
    save.disabled = busy || !(dirty || s.firstRun) || !!hostMsg || !!portMsg;
    save.hidden = !showPicker || (connected && !dirty);
    save.classList.toggle('primary', !(connected && !dirty));
    $('back').hidden = !connected;
    $('back').classList.toggle('primary', !dirty);

    const retry = $('retry');
    retry.hidden = !!s.firstRun;
    retry.textContent = connected ? (s.mode === 'local' ? 'Restart hub' : 'Reconnect') : 'Retry';
    $('find').hidden = !showPicker || !$('discover').hidden;
  }

  $('change').onclick = () => {
    pickerOpen = !pickerOpen;
    if (!pickerOpen) {
      // Cancel: drop any unsaved edits
      selectedMode = cfg.mode;
      $('host-input').value = cfg.sshHost || '';
      $('host-input').dataset.touched = '';
      $('port-input').value = cfg.port || 7788;
      closeDiscover();
    }
    render();
    if (pickerOpen) cards[selectedMode].focus();
  };

  function selectMode(mode, focus) {
    selectedMode = mode;
    render();
    if (mode === 'remote') loadHosts();
    if (focus) cards[mode].focus();
  }

  for (const mode of MODES) {
    const card = cards[mode];
    card.addEventListener('click', () => selectMode(mode, false));
    card.addEventListener('keydown', (e) => {
      const idx = MODES.indexOf(mode);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); selectMode(MODES[(idx + 1) % MODES.length], true); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); selectMode(MODES[(idx - 1 + MODES.length) % MODES.length], true); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMode(mode, false); }
    });
  }
  $('host-input').addEventListener('input', () => { $('host-input').dataset.touched = '1'; render(); });
  $('port-input').addEventListener('input', render);
  $('tray-input').addEventListener('change', (e) => {
    invoke('set_close_to_tray', { on: e.target.checked }).catch((err) => showActionError(errText(err)));
  });

  async function loadCfg() {
    try { cfg = await invoke('get_config'); }
    catch { cfg = { mode: 'local', sshHost: '', port: 7788, hubDir: null }; }
    selectedMode = cfg.mode;
    $('host-input').value = cfg.sshHost || '';
    $('port-input').value = cfg.port || 7788;
    // P9: the effective close behaviour (the mode's default until it is chosen here or in the tray).
    invoke('get_close_to_tray').then((on) => { $('tray-input').checked = !!on; }, () => { $('tray-input').closest('label').hidden = true; });
    render();
  }

  function statusMessage(s) {
    if (s.connected) return 'Connected';
    if (s.error) return 'Could not connect';
    if (s.firstRun) return 'Not started yet';
    const base = s.mode === 'local' ? (s.childRunning ? 'Starting the hub' : 'Launching')
      : s.mode === 'remote' ? (s.childRunning ? 'Tunnel up, waiting for the hub' : 'Opening tunnel')
      : 'Looking for a hub';
    return [base, s.runtime, s.elapsedSecs != null ? s.elapsedSecs + 's' : null].filter(Boolean).join(' · ');
  }

  // ---- Claude account lines ----
  const PLAN_NAMES = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise', free: 'Claude Free' };
  function planName(p) {
    if (!p) return 'Claude';
    const k = String(p).toLowerCase();
    return PLAN_NAMES[k] || ('Claude ' + k.charAt(0).toUpperCase() + k.slice(1));
  }
  function setClaudeLine(node, tone, text) {
    node.hidden = !text;
    node.className = 'claude-line' + (tone ? ' ' + tone : '');
    node.lastElementChild.textContent = text || '';
  }
  let localClaudeAsked = false;
  async function loadLocalClaude() {
    if (localClaudeAsked) return;
    localClaudeAsked = true;
    try {
      const c = await invoke('scan_local_claude');
      if (!c.installed) setClaudeLine($('local-claude'), 'warn', 'Claude Code not installed');
      else if (c.loggedIn === false) setClaudeLine($('local-claude'), 'warn', 'Claude Code installed, not signed in: run claude in a terminal');
      else if (c.loggedIn) setClaudeLine($('local-claude'), 'ok', [planName(c.plan), c.email].filter(Boolean).join(' · '));
      else setClaudeLine($('local-claude'), '', 'Claude Code ' + (c.version || 'installed'));
    } catch { /* not in the app */ }
  }
  let remoteClaudeFor = null;
  async function loadRemoteClaude(s) {
    const key = s.sshHost + ':' + s.port;
    if (remoteClaudeFor === key) return;
    remoteClaudeFor = key;
    try {
      const c = await invoke('remote_claude_status');
      if (!c) { remoteClaudeFor = null; return; }
      const where = 'On ' + s.sshHost + ': ';
      if (c.ok) setClaudeLine($('remote-claude'), 'ok', where + [planName(c.plan), c.account].filter(Boolean).join(' · '));
      else setClaudeLine($('remote-claude'), 'warn', where + (c.error || 'Claude Code is not ready'));
    } catch (e) {
      setClaudeLine($('remote-claude'), 'warn', 'Couldn’t ask the server about Claude: ' + errText(e));
    }
  }

  async function poll() {
    try {
      const s = await invoke('get_status');
      lastStatus = s;
      const dot = $('dot');
      dot.className = 'dot' + (s.connected ? ' ok' : s.error ? ' bad' : s.firstRun ? ' idle' : '');
      $('status-text').textContent = statusMessage(s);
      if (s.error) {
        $('err-panel').hidden = false;
        $('err-text').textContent = s.error;
        const canLog = s.mode === 'local' && !s.portHasHub && s.errorKind == null;
        $('err-log').hidden = !canLog;
        $('err-attach').hidden = !s.portHasHub;
        $('err-actions').hidden = !canLog && !s.portHasHub;
      } else {
        $('err-panel').hidden = true;
      }
      if (s.firstRun || s.connected || s.error) loadLocalClaude();
      if (s.firstRun && !discoverOpenedOnce) openDiscover();
      if (s.connected && s.mode === 'remote') loadRemoteClaude(s);
      else if (!s.connected) { remoteClaudeFor = null; setClaudeLine($('remote-claude'), '', ''); }
      render();
    } catch {
      $('dot').className = 'dot';
      $('status-text').textContent = 'Not running inside the desktop app.';
    }
  }

  // ---- actions ----
  async function saveConfig(config) {
    busy = true; render(); showActionError('');
    try {
      await invoke('save_config', { config });
      $('host-input').dataset.touched = '';
      closeDiscover();
      pickerOpen = false;
      await loadCfg();
      await poll();
    } catch (e) {
      showActionError(errText(e));
    } finally {
      busy = false; render();
    }
  }

  $('save').onclick = () => {
    const sshHost = $('host-input').value.trim();
    if (selectedMode === 'remote') {
      $('host-input').dataset.touched = '1';
      if (hostError(sshHost)) { render(); $('host-input').focus(); return; }
    }
    if (portError()) { render(); $('port-input').focus(); return; }
    saveConfig({ mode: selectedMode, sshHost, port: portValue(), hubDir: cfg.hubDir || null });
  };
  $('retry').onclick = () => {
    const s = lastStatus || {};
    if (s.connected && s.mode === 'local' && !window.confirm('Restart the hub on this PC? Bots that are working right now will stop.')) return;
    showActionError('');
    invoke('retry').catch((e) => showActionError(errText(e)));
  };
  $('back').onclick = () => { invoke('open_hub').catch((e) => showActionError(errText(e))); };
  $('err-log').onclick = () => { invoke('open_log').catch((e) => showActionError(errText(e))); };
  $('err-attach').onclick = () => saveConfig({ mode: 'attach', sshHost: cfg.sshHost || '', port: cfg.port, hubDir: cfg.hubDir || null });

  // ---- find my servers ----
  let hostList = null;
  let hostsPromise = null;
  let discoverOpenedOnce = false;
  const results = new Map(); // alias -> ScanResult
  const pending = new Set(); // aliases being scanned
  const fingerprints = new Map(); // alias -> { lines } | { error }

  function loadHosts() {
    if (!hostsPromise) {
      hostsPromise = invoke('list_ssh_hosts').then((l) => {
        hostList = l;
        const dl = $('host-aliases');
        dl.replaceChildren(...l.hosts.flatMap((h) => [h.alias, ...h.also]).map((a) => el('option', { value: a })));
        renderHosts();
        return l;
      }).catch((e) => { hostList = { hosts: [], error: errText(e) }; renderHosts(); });
    }
    return hostsPromise;
  }

  function openDiscover() {
    discoverOpenedOnce = true;
    $('discover').hidden = false;
    loadHosts();
    loadLocalClaude();
    renderHosts();
    render();
  }
  function closeDiscover() {
    $('discover').hidden = true;
    render();
  }
  $('find').onclick = () => { openDiscover(); $('discover-title').scrollIntoView({ block: 'nearest' }); $('discover-close').focus(); };
  $('discover-close').onclick = () => { closeDiscover(); $('find').focus(); };

  const KIND = {
    running: ['Running', 'ok'],
    stopped: ['Installed, not running', 'warn'],
    none: ['No PocketRocket', ''],
    hostKeyUnknown: ['New host key', 'warn'],
    hostKeyChanged: ['Host key changed', 'bad'],
    needsKey: ['Needs your SSH key', 'warn'],
    unreachable: ['Unreachable', ''],
  };

  function checkedAliases() {
    return [...document.querySelectorAll('#hosts input[type=checkbox]:checked')].map((c) => c.value);
  }

  function renderHosts() {
    const ul = $('hosts');
    const checked = new Set(checkedAliases());
    const focusedId = document.activeElement && ul.contains(document.activeElement) ? document.activeElement.id : null;
    ul.replaceChildren();
    if (!hostList) {
      ul.append(el('li', { className: 'result', textContent: 'Reading ~/.ssh/config…' }));
    } else if (hostList.error) {
      ul.append(el('li', { className: 'result bad', textContent: 'Couldn’t read your SSH config: ' + hostList.error }));
    } else if (!hostList.hosts.length) {
      ul.append(el('li', { className: 'result', textContent: hostList.configFound
        ? 'No Host entries in ~/.ssh/config. Type a host under Server over SSH instead.'
        : 'No ~/.ssh/config on this PC. Type a host under Server over SSH instead.' }));
    }
    for (const h of (hostList && hostList.hosts) || []) ul.append(renderHost(h, checked));
    if (focusedId && $(focusedId)) $(focusedId).focus();
    const n = checkedAliases().length;
    $('scan').disabled = n === 0 || pending.size > 0;
    $('scan').textContent = pending.size ? 'Scanning…' : n > 1 ? 'Scan ' + n : 'Scan';
    $('scan-note').textContent = pending.size ? pending.size + ' left' : '';
  }

  function renderHost(h, checked) {
    const id = 'host-' + h.alias.replace(/[^a-zA-Z0-9_-]/g, '_');
    const box = el('input', { type: 'checkbox', id, value: h.alias, checked: checked.has(h.alias) });
    box.addEventListener('change', renderHosts);
    const target = (h.user ? h.user + '@' : '') + h.hostname + (h.port !== 22 ? ':' + h.port : '');
    const meta = [target, h.also.length ? 'also ' + h.also.join(', ') : null, h.proxy ? 'via jump host' : null].filter(Boolean).join(' · ');
    const label = el('label', { htmlFor: id }, [
      el('div', { className: 'host-name', textContent: h.alias }),
      el('div', { className: 'host-meta', textContent: meta, title: meta }),
    ]);
    const li = el('li', { className: 'host' }, [el('div', { className: 'host-row' }, [box, label])]);
    if (pending.has(h.alias)) {
      li.append(el('div', { className: 'result', textContent: 'Checking…' }));
    } else if (results.has(h.alias)) {
      li.append(renderResult(results.get(h.alias)));
    }
    return li;
  }

  function renderResult(r) {
    const [label, tone] = KIND[r.kind] || [r.kind, ''];
    const wrap = el('div', { className: 'result' + (r.kind === 'hostKeyChanged' ? ' bad' : '') });
    wrap.append(el('span', { className: 'badge ' + tone, textContent: label }), r.detail);
    if (r.kind === 'running' && r.versionMatches === false) {
      wrap.append(el('div', { textContent: 'Different version from this app: redeploy the server (scripts/deploy.sh) when you can.' }));
    }
    if (r.claude && (r.kind === 'running' || r.kind === 'stopped')) {
      const c = r.claude;
      wrap.append(el('div', { textContent: c.loggedIn === false
        ? 'Claude on the server: not signed in'
        : 'Claude on the server: ' + [planName(c.plan), c.email].filter(Boolean).join(' · ') }));
    }
    if (r.agy && (r.kind === 'running' || r.kind === 'stopped')) {
      wrap.append(el('div', { textContent: 'Gemini CLI (agy) on the server: installed' }));
    }
    const actions = el('div', { className: 'result-actions' });
    if (r.kind === 'running') {
      actions.append(button('Use this server', true, () => saveConfig({ mode: 'remote', sshHost: r.alias, port: portError() ? 7788 : portValue(), hubDir: cfg.hubDir || null })));
    }
    if (r.kind === 'hostKeyUnknown') {
      const fp = fingerprints.get(r.alias);
      if (!fp) {
        actions.append(button('Show fingerprint', false, () => showFingerprint(r.alias)));
      } else if (fp.loading) {
        actions.append(el('span', { textContent: 'Asking the server for its key…' }));
      } else if (fp.error) {
        wrap.append(el('div', { className: 'fp', textContent: fp.error }));
      } else {
        const box = el('div', { className: 'fp' }, [
          el('div', { textContent: 'Compare with the fingerprint your hosting provider shows (or run ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the server). Only trust it if it matches.' }),
          ...fp.lines.map((l) => el('code', { textContent: l })),
        ]);
        wrap.append(box);
        actions.append(
          button('It matches, trust and scan', true, () => { fingerprints.delete(r.alias); scan([r.alias], true); }),
          button('Cancel', false, () => { fingerprints.delete(r.alias); renderHosts(); }),
        );
      }
    }
    if (r.kind === 'unreachable' || r.kind === 'needsKey' || r.kind === 'stopped') {
      actions.append(button('Retry', false, () => scan([r.alias], false)));
    }
    if (actions.childElementCount) wrap.append(actions);
    return wrap;
  }

  function button(text, primary, onclick) {
    const b = el('button', { className: 'btn small' + (primary ? ' primary' : ''), textContent: text, type: 'button' });
    b.onclick = onclick;
    return b;
  }

  async function showFingerprint(alias) {
    fingerprints.set(alias, { loading: true });
    renderHosts();
    try {
      const fp = await invoke('ssh_host_fingerprint', { alias });
      fingerprints.set(alias, { lines: fp.lines });
    } catch (e) {
      fingerprints.set(alias, { error: errText(e) });
    }
    renderHosts();
  }

  async function scan(aliases, acceptNew) {
    for (const a of aliases) { pending.add(a); results.delete(a); }
    renderHosts();
    try {
      const all = await invoke('scan_ssh_hosts', { aliases, acceptNew: !!acceptNew });
      for (const r of all) { results.set(r.alias, r); pending.delete(r.alias); }
    } catch (e) {
      for (const a of aliases) {
        pending.delete(a);
        results.set(a, { alias: a, kind: 'unreachable', detail: errText(e) });
      }
    }
    renderHosts();
  }
  $('scan').onclick = () => scan(checkedAliases(), false);

  if (T && T.event) {
    T.event.listen('ssh-scan-result', (ev) => {
      const r = ev.payload;
      if (!r || !pending.has(r.alias)) return;
      pending.delete(r.alias);
      results.set(r.alias, r);
      renderHosts();
    });
  }

  loadCfg();
  poll();
  setInterval(poll, 1000);
