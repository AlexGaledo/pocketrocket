import { browserWsUrl, connectCdp, type CdpConnection } from './cdpClient.js';

/**
 * Types a saved secret into the bot's browser over the Chrome DevTools Protocol, without the secret ever being
 * returned to the caller or leaving the hub other than as the value of the one field (G4).
 *
 * Guards, all checked against the page as it is NOW (after any redirect, after the owner's approval):
 *  - the front tab is exactly one tab (visible); two visible tabs or none is refused rather than guessed at;
 *  - that tab's URL origin AND the page's own `location.origin` both equal the credential's origin, compared as
 *    exact strings: scheme, host and port. `null` (about:blank, data:, sandboxed frames) never matches;
 *  - the target is an <input> in the top document, of the right kind: a password goes only into type=password, a
 *    username never into a password field. An iframe, a textarea or a contenteditable is not a target;
 *  - the origin is checked once more inside the same JavaScript turn that sets the value, so a navigation cannot
 *    slip in between the check and the write.
 * The result carries a code, never the value or any page text.
 */
export type FillField = 'username' | 'password';
export type FillOutcome =
  | { ok: true }
  | { ok: false; reason: 'unreachable' | 'no_page' | 'ambiguous' | 'origin' | 'no_field' | 'failed'; pageOrigin?: string };

export interface FillRequest {
  cdpUrl: string;
  /** The credential's origin, exact. */
  origin: string;
  field: FillField;
  secret: string;
  /** Only check that the front tab is on `origin`; touch nothing. `secret` is ignored. */
  probe?: boolean;
  /** Tests hand in a fake. */
  connect?: (cdpUrl: string) => Promise<CdpConnection>;
}

const originOf = (url: unknown): string | null => {
  try {
    const o = new URL(String(url)).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
};

/** Runs in the page. Finds the field to fill and returns it (or null). Holds no secret. */
const FIND_FIELD = `function (field) {
  var BAD = ['checkbox','radio','button','submit','file','hidden','image','reset','range','color'];
  function usable(el) {
    if (!el || el.tagName !== 'INPUT' || el.disabled || el.readOnly) return false;
    var t = (el.type || 'text').toLowerCase();
    if (BAD.indexOf(t) >= 0) return false;
    var r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }
  var a = document.activeElement;
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(usable);
  if (field === 'password') {
    if (usable(a) && a.type === 'password') return a;
    return inputs.filter(function (i) { return i.type === 'password'; })[0] || null;
  }
  if (usable(a) && a.type !== 'password') return a;
  var plain = inputs.filter(function (i) { return i.type !== 'password'; });
  var named = plain.filter(function (i) { return /user|email|login/i.test((i.autocomplete || '') + ' ' + (i.name || '') + ' ' + (i.id || '')) || i.type === 'email'; });
  return named[0] || plain[0] || null;
}`;

/** Runs in the page with the element as `this`. Atomic: origin check, kind check, focus and write in one turn. */
const WRITE_FIELD = `function (expectedOrigin, field, value) {
  if (location.origin !== expectedOrigin) return 'origin';
  var t = (this.type || '').toLowerCase();
  if (this.tagName !== 'INPUT' || (field === 'password') !== (t === 'password')) return 'no_field';
  this.focus();
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return 'filled';
}`;

export async function fillActivePage(req: FillRequest): Promise<FillOutcome> {
  let conn: CdpConnection;
  try {
    const open = req.connect ?? (async (u: string) => connectCdp(await browserWsUrl(u)));
    conn = await open(req.cdpUrl);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  try {
    const { targetInfos } = (await conn.send('Target.getTargets')) as { targetInfos?: { targetId: string; type: string; url: string }[] };
    const pages = (targetInfos ?? []).filter((t) => t.type === 'page');
    if (!pages.length) return { ok: false, reason: 'no_page' };

    // The front tab: the one the browser reports as visible. Not guessed from the URL, or a background tab on the
    // right site would be filled while the bot is looking at another.
    const visible: { sessionId: string; url: string }[] = [];
    for (const p of pages) {
      const { sessionId } = (await conn.send('Target.attachToTarget', { targetId: p.targetId, flatten: true })) as { sessionId: string };
      const v = (await conn.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId)) as { result?: { value?: unknown } };
      if (v.result?.value === 'visible') visible.push({ sessionId, url: p.url });
    }
    if (visible.length !== 1) return { ok: false, reason: visible.length ? 'ambiguous' : 'no_page' };
    const { sessionId, url } = visible[0];

    const live = (await conn.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, sessionId)) as { result?: { value?: unknown } };
    const pageOrigin = typeof live.result?.value === 'string' && live.result.value !== 'null' ? live.result.value : null;
    const tabOrigin = originOf(url);
    if (pageOrigin !== req.origin || tabOrigin !== req.origin) {
      return { ok: false, reason: 'origin', pageOrigin: pageOrigin ?? tabOrigin ?? undefined };
    }

    if (req.probe) return { ok: true };

    const found = (await conn.send('Runtime.evaluate', { expression: '(' + FIND_FIELD + ')(' + JSON.stringify(req.field) + ')', returnByValue: false }, sessionId)) as { result?: { subtype?: string; objectId?: string } };
    if (found.result?.subtype !== 'node' || !found.result.objectId) return { ok: false, reason: 'no_field' };

    const done = (await conn.send('Runtime.callFunctionOn', {
      objectId: found.result.objectId,
      functionDeclaration: WRITE_FIELD,
      arguments: [{ value: req.origin }, { value: req.field }, { value: req.secret }],
      returnByValue: true,
    }, sessionId)) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (done.exceptionDetails) return { ok: false, reason: 'failed' };
    const code = done.result?.value;
    if (code === 'filled') return { ok: true };
    if (code === 'origin') return { ok: false, reason: 'origin' };
    return { ok: false, reason: code === 'no_field' ? 'no_field' : 'failed' };
  } catch {
    // The message may quote the expression we sent; say nothing but the fact.
    return { ok: false, reason: 'failed' };
  } finally {
    conn.close();
  }
}
