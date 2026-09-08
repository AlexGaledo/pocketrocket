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
