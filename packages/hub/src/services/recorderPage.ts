import { SECRET_PLACEHOLDER } from '@pocketrocket/shared';

/**
 * What counts as a secret field (grok-bot-parity.md §2.8 step 3). One definition, used twice: inside the page
 * script (so a secret value never leaves the page) and again by the hub on every event it receives (so a page
 * that lies, or a script bug, still cannot put a value in the trace). Over-redacting is fine; a leak is not.
 */
export const SECRET_AUTOCOMPLETE_RE = /password|(^|\s)cc-|one-time-code/i;
export const SECRET_NAME_RE = /passw(or)?d|pwd|passcode|cvv|cvc|csc|card.?num|cc.?num|cc.?number|security.?code|one.?time|otp/i;

/** The element description the page script sends (never an input's value). */
export interface ElementDesc {
  tag?: string;
  type?: string;
  id?: string;
  name?: string;
  autocomplete?: string;
  role?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  selector?: string;
  /** The page script's own verdict. The hub ORs it with isSecretField; it can only add redaction. */
  secret?: boolean;
}

export function isSecretField(d: ElementDesc | undefined | null): boolean {
  if (!d) return false;
  if (d.secret) return true;
  const tag = String(d.tag ?? '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return false;
  if (String(d.type ?? '').toLowerCase() === 'password') return true;
  if (SECRET_AUTOCOMPLETE_RE.test(String(d.autocomplete ?? ''))) return true;
  return SECRET_NAME_RE.test(String(d.name ?? '') + ' ' + String(d.id ?? ''));
}

/** The CDP binding the page script reports through. It lives only in the recorder's isolated world. */
export const RECORDER_BINDING = '__prcRec';
/** Isolated world: shares the DOM with the page but not its JavaScript, so the page cannot see or call the binding. */
export const RECORDER_WORLD = 'prc-recorder';

/**
 * The script injected into every frame of the bot's browser while recording. Plain ES2017 in a string (it runs in
 * Chromium, not in Node). It reports clicks, typed values (on blur / Enter / change), special keys, submits and
 * focus changes; a value typed into a secret field is replaced with «secret» before it is sent.
 */
export const PAGE_SCRIPT = `(() => {
  if (window.__prcRecInstalled) return;
  window.__prcRecInstalled = true;
  const SECRET = ${JSON.stringify(SECRET_PLACEHOLDER)};
  const AC_RE = new RegExp(${JSON.stringify(SECRET_AUTOCOMPLETE_RE.source)}, 'i');
  const NAME_RE = new RegExp(${JSON.stringify(SECRET_NAME_RE.source)}, 'i');
  const send = (o) => { try { window.${RECORDER_BINDING}(JSON.stringify(o)); } catch (e) { /* recorder gone */ } };
  const attr = (el, a) => (el && el.getAttribute && el.getAttribute(a)) || '';
  const clip = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const isField = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const isSecret = (el) => {
    if (!isField(el)) return false;
    if (attr(el, 'type').toLowerCase() === 'password') return true;
    if (AC_RE.test(attr(el, 'autocomplete'))) return true;
    return NAME_RE.test(attr(el, 'name') + ' ' + (el.id || ''));
  };
  const editable = (el) => !!el && (isField(el) && !/^(button|submit|reset|checkbox|radio|file|image|hidden)$/i.test(attr(el, 'type')) || el.isContentEditable);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
  const q = (s) => '"' + String(s).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"';
  const stableId = (id) => !!id && !/\\d{4,}|^[a-f0-9-]{16,}$|:/i.test(id);
  const selector = (el) => {
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) { const v = attr(el, a); if (v) return '[' + a + '=' + q(v) + ']'; }
    const tag = el.tagName.toLowerCase();
    if (stableId(el.id)) return '#' + esc(el.id);
    if (attr(el, 'name')) return tag + '[name=' + q(attr(el, 'name')) + ']';
    if (attr(el, 'aria-label')) return tag + '[aria-label=' + q(attr(el, 'aria-label')) + ']';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 5) {
      if (cur !== el && stableId(cur.id)) { parts.unshift('#' + esc(cur.id)); break; }
      let p = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName);
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(p);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
  const role = (el) => {
    const r = attr(el, 'role');
    if (r) return r;
    if (el.tagName === 'INPUT') {
      const t = attr(el, 'type').toLowerCase();
      return t === 'checkbox' || t === 'radio' ? t : t === 'submit' || t === 'button' ? 'button' : 'textbox';
    }
    return IMPLICIT[el.tagName] || '';
  };
  const label = (el) => {
    const al = attr(el, 'aria-label');
    if (al) return al;
    const by = attr(el, 'aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' '); if (t.trim()) return t; }
    if (el.id) { try { const l = document.querySelector('label[for=' + q(el.id) + ']'); if (l) return l.textContent; } catch (e) { /* bad id */ } }
    const wrap = el.closest && el.closest('label');
    if (wrap && isField(el)) return wrap.textContent;
    return attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'alt');
  };
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const field = isField(el) || el.tagName === 'SELECT';
    return {
      tag: el.tagName.toLowerCase(), type: attr(el, 'type'), id: clip(el.id, 80), name: clip(attr(el, 'name'), 80),
      autocomplete: clip(attr(el, 'autocomplete'), 60), role: role(el), label: clip(label(el), 120),
      text: field ? '' : clip(el.innerText || el.textContent, 80), placeholder: clip(attr(el, 'placeholder'), 80),
      selector: clip(selector(el), 300), secret: isSecret(el),
    };
  };
  const target = (el) => (el && el.closest && el.closest('a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=option],[role=switch],[contenteditable=true],[onclick]')) || el;
  const valueOf = (el) => (el.isContentEditable ? el.innerText : el.value);
  const anyVisibleSecret = () => Array.prototype.some.call(document.querySelectorAll('input,textarea'), (el) => isSecret(el) && attr(el, 'type').toLowerCase() !== 'password' && !!el.value);
  const before = new WeakMap();
  const flush = (el) => {
    if (!editable(el) || !before.has(el)) return;
    const v = valueOf(el);
    if (v === before.get(el)) return;
    before.set(el, v);
    send({ t: 'type', el: desc(el), value: isSecret(el) ? SECRET : clip(v, 2000) });
  };
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (editable(el)) before.set(el, valueOf(el));
    send({ t: 'focus', el: desc(el) });
  }, true);
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    flush(el);
    send({ t: 'blur', secret: isSecret(el), visibleSecret: anyVisibleSecret() });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || editable(el)) return;
    const t = attr(el, 'type').toLowerCase();
    const v = t === 'checkbox' || t === 'radio' ? String(!!el.checked) : el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value;
    send({ t: 'change', el: desc(el), value: isSecret(el) ? SECRET : clip(v, 300) });
  }, true);
  const QUIET = /^(Shift|Control|Alt|Meta|CapsLock|Backspace|Delete|Unidentified|Dead|Process)$/;
  document.addEventListener('keydown', (e) => {
    const mods = (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.metaKey ? 'Meta+' : '');
    if (e.key === 'Enter' || e.key === 'Tab') flush(e.target);
    if (QUIET.test(e.key) || (e.key.length === 1 && !mods)) return;
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    send({ t: 'key', key: mods + k, el: desc(e.target) });
  }, true);
  document.addEventListener('click', (e) => {
    const el = target(e.target);
    send({ t: 'click', el: desc(el), x: Math.round(e.clientX), y: Math.round(e.clientY), visibleSecret: anyVisibleSecret() });
  }, true);
  document.addEventListener('submit', (e) => send({ t: 'submit', el: desc(e.target) }), true);
})();`;
