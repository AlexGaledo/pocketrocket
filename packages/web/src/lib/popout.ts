/**
 * Pop-out chat windows (U1): one small window per bot, showing that bot's chat without the sidebar or panels.
 *
 * Opening is a plain `window.open` to this same origin with `?popout=<botId>`. The desktop shell catches that in
 * Rust (on_new_window) and builds a `bot-<id>` window itself, so the page is granted no command for it. In a
 * browser the same call simply opens a small browser window. Nothing here uses the Tauri API.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PopoutRoute {
  botId: string;
  /** A room to show, when the opener named one. */
  roomId: string | null;
}

/** Reads `?popout=<botId>[&room=<roomId>]` or `#/popout/<botId>`; null for the normal app or an invalid id. */
export function parsePopout(search: string, hash: string): PopoutRoute | null {
  const q = new URLSearchParams(search);
  const fromHash = /^#\/popout\/([^/?#]+)/.exec(hash)?.[1];
  let botId = q.get('popout');
  if (botId === null && fromHash) {
    try { botId = decodeURIComponent(fromHash); } catch { return null; }
  }
  if (!botId || !ID.test(botId)) return null;
  const room = q.get('room');
  return { botId, roomId: room && ID.test(room) ? room : null };
}

export function currentPopout(): PopoutRoute | null {
  if (typeof location === 'undefined') return null;
  return parsePopout(location.search, location.hash);
}

export function popoutUrl(botId: string, roomId?: string | null): string {
  const q = new URLSearchParams({ popout: botId });
  if (roomId && ID.test(roomId)) q.set('room', roomId);
  return location.origin + '/?' + q.toString();
}

// The desktop shell denies the new window after opening its own, so window.open returns null there.
function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** Opens (or, on desktop, focuses) the bot's window. False when the id is unusable or the browser blocked it. */
export function openPopout(botId: string, roomId?: string | null): boolean {
  if (!ID.test(botId)) return false;
  try {
    return window.open(popoutUrl(botId, roomId), 'bot-' + botId, 'popup,width=460,height=720') !== null || isDesktopShell();
  } catch {
    return false;
  }
}
