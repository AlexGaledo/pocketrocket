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
    return sessionStorage.getItem(TOKEN_KEY);
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
