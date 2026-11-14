/**
 * Local desktop notifications (U7). Only the PocketRocket desktop app can show one: the Tauri shell grants the
 * hub's page the notify command and nothing else (capabilities/hub-notify.json). In a plain browser or the PWA this
 * does nothing, because phones already get Web Push (push.ts). Nothing here is wired to an event yet.
 *
 * Content-free by default: the OS notification center keeps a history and shows on the lock screen, so a bot's
 * words never go in it. Pass `detail: true` only for a caller that has the user's explicit opt-in.
 */

type TauriGlobal = { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };

const DEFAULT_TITLE = 'PocketRocket';
const DEFAULT_BODY = 'A bot needs you';
/** At most one notification per room in this window, so a chatty bot does not flood the notification center. */
const COALESCE_MS = 10_000;
const lastByRoom = new Map<string, number>();

function tauriInvoke(): NonNullable<NonNullable<TauriGlobal['core']>['invoke']> | null {
  if (typeof window === 'undefined') return null;
  const invoke = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

/** True inside the PocketRocket desktop app, the only place notify() can do anything. */
export function canNotify(): boolean {
  return tauriInvoke() !== null;
}

export interface NotifyInput {
  title?: string;
  body?: string;
  /** Only used to coalesce repeats per room. The desktop plugin has no click handler, so it is not a deep link. */
  roomId?: string;
  /** Show `title` and `body` as given. Without it the generic wording is used, whatever was passed. */
  detail?: boolean;
}

/** Resolves true when a notification was handed to the OS, false for every reason it was not. Never throws. */
export async function notify(input: NotifyInput = {}): Promise<boolean> {
  try {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    // A window the user is looking at needs no notification; a hidden or minimized one reports no focus.
    if (typeof document !== 'undefined' && document.hasFocus()) return false;
    if (input.roomId) {
      const now = Date.now();
      const last = lastByRoom.get(input.roomId);
      if (last !== undefined && now - last < COALESCE_MS) return false;
      lastByRoom.set(input.roomId, now);
    }
    // Permission is always granted on desktop; asking costs nothing and a denied state is respected.
    if ((await invoke('plugin:notification|is_permission_granted')) === false) return false;
    const options = input.detail
      ? { title: input.title || DEFAULT_TITLE, body: input.body ?? DEFAULT_BODY }
      : { title: DEFAULT_TITLE, body: DEFAULT_BODY };
    await invoke('plugin:notification|notify', { options });
    return true;
  } catch {
    return false;
  }
}
