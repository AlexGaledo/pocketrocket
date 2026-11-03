/**
 * Desktop auth bootstrap. When PocketRocket is launched by the desktop shell the URL is
 * http://127.0.0.1:7788/?desktop=1#token=<hex>. We stash the token + desktop flag in
 * sessionStorage (survives reloads within the tab, not across tabs/restarts) and strip the
 * hash so it never ends up in history or gets shared accidentally.
 *
 * This runs once, as a side effect of importing this module. Import it before any fetch()
 * or WebSocket connection is made (lib/api.ts and lib/ws.ts both do).
 */
const TOKEN_KEY = 'pocketrocket.token';
const DESKTOP_KEY = 'pocketrocket.desktop';

function boot() {
  try {
    const hash = location.hash;
    if (hash.startsWith('#token=')) {
      const token = decodeURIComponent(hash.slice('#token='.length));
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      history.replaceState(null, '', location.pathname + location.search);
    }
    const params = new URLSearchParams(location.search);
    if (params.get('desktop') === '1') sessionStorage.setItem(DESKTOP_KEY, '1');
  } catch {
    /* sessionStorage / history unavailable (e.g. sandboxed iframe) — fall back to no-auth */
  }
}
boot();

export function getToken(): string | null {
  try {
    // The hub token (desktop app, a pasted token) wins; otherwise this browser's paired-device token (P9).
    return sessionStorage.getItem(TOKEN_KEY) ?? getDeviceToken();
  } catch {
    return null;
  }
}

export function isDesktopMode(): boolean {
  try {
    return sessionStorage.getItem(DESKTOP_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The hub now always requires a token. When the API 401s or the WS upgrade is refused, the UI
 * shows a small "paste the hub token" panel. This is a tiny pub-sub outside the zustand store so
 * lib/api.ts and lib/ws.ts (which the store itself imports) can report failures without a cycle.
 */
type Listener = () => void;
let needsToken = false;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function reportAuthFailure(): void {
  // P9: a device token the hub refuses has been revoked (or the hub's data was reset). It never comes back,
  // so drop it; the token panel then says to pair again rather than to paste a hub token.
  if (!hasHubToken() && getDeviceToken()) {
    clearDeviceToken();
    unpaired = true;
  }
  if (needsToken) return;
  needsToken = true;
  emit();
}

export function clearAuthFailure(): void {
  if (!needsToken) return;
  needsToken = false;
  emit();
}

export function getNeedsToken(): boolean {
  return needsToken;
}

export function subscribeAuthFailure(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* sessionStorage unavailable */
  }
  clearAuthFailure();
}

// ---------------------------------------------------------------------------------------------------
// P9: paired devices. A phone scans the QR from the desktop's Settings › Devices, which opens
// `https://<hub>/#pair=<CODE>`. The code is one-time and short-lived; this browser trades it for a device
// token of its own, kept in localStorage (a phone app has to survive restarts) and never in a URL.
const DEVICE_KEY = 'pocketrocket.deviceToken';
let unpaired = false;
let pairError: string | null = null;

export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}
function clearDeviceToken(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage unavailable */
  }
}
function hasHubToken(): boolean {
  try {
    return !!sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
}

/** True when this page talks to the hub as a paired device (narrower rights than the hub token). */
export function isDevice(): boolean {
  return !hasHubToken() && !!getDeviceToken();
}
/** True once a device token was refused: the phone has been unpaired on the desktop. */
export function wasUnpaired(): boolean {
  return unpaired;
}
/** Why the last pairing attempt failed, for the token panel. */
export function getPairError(): string | null {
  return pairError;
}

/** A short, human name for this device from the user agent; editable later on the desktop. */
export function guessDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Windows/i.test(ua)) return 'Windows browser';
  if (/Macintosh/i.test(ua)) return 'Mac browser';
  if (/Linux/i.test(ua)) return 'Linux browser';
  return 'Phone';
}

/**
 * Redeem a pairing code. Resolves true when this browser now holds a device token. A wrong or expired code is
 * a 403 from the hub; the reason lands in `getPairError()`.
 */
export async function redeemPairingCode(code: string): Promise<boolean> {
  pairError = null;
  try {
    const r = await fetch('/api/devices/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: guessDeviceName() }),
      cache: 'no-store',
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!r.ok || !j.token) {
      pairError = r.status === 429
        ? 'Too many tries. Make a new code.'
        : j.error ?? "Code didn't work. Make a new one.";
      return false;
    }
    localStorage.setItem(DEVICE_KEY, j.token);
    unpaired = false;
    clearAuthFailure();
    return true;
  } catch {
    pairError = "Couldn't reach the server to pair.";
    return false;
  }
}

/**
 * Called once before the app connects (main.tsx). Takes `#pair=<CODE>` off the URL straight away, so the
 * code never sits in history, then redeems it. A failure shows in the token panel.
 */
export async function pairFromHash(): Promise<void> {
  let code: string | null = null;
  try {
    if (location.hash.startsWith('#pair=')) {
      code = decodeURIComponent(location.hash.slice('#pair='.length));
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch {
    return;
  }
  if (!code) return;
  if (!(await redeemPairingCode(code))) reportAuthFailure();
}
