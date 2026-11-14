/**
 * Which hub events raise a desktop notification (U7) and what they say. The OS only shows one when the window is
 * unfocused (notify.ts checks), and bots, not the user, cause every event listed here, so the user's own actions
 * never notify. Preferences are per computer (the app's window, not a hub setting) and live in lib/persist.ts.
 */
import { canNotify, notify } from './notify';
import { getItem, setItem, versionedKey } from './persist';

const ENABLED_KEY = versionedKey('notify.enabled', 1);
const TEXT_KEY = versionedKey('notify.text', 1);

/** Master switch. Unset means on inside the desktop app and off anywhere else. */
export function notificationsEnabled(): boolean {
  if (!canNotify()) return false;
  const v = getItem(ENABLED_KEY);
  return v === null ? true : v === '1';
}
export function setNotificationsEnabled(on: boolean): void {
  setItem(ENABLED_KEY, on ? '1' : '0');
}
/** Whether a notification may carry a bot's words. Off unless the user chose it. */
export function notificationText(): boolean {
  return getItem(TEXT_KEY) === '1';
}
export function setNotificationText(on: boolean): void {
  setItem(TEXT_KEY, on ? '1' : '0');
}

export type NotifyEvent =
  | { kind: 'approval'; roomId: string; botName: string }
  | { kind: 'takeover'; roomId: string; botName: string; reason?: string }
  | { kind: 'turn'; roomId: string; botName: string; lastText?: string };

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Fire-and-forget. Resolves true when a notification was handed to the OS. */
export function notifyEvent(ev: NotifyEvent): Promise<boolean> {
  if (!notificationsEnabled()) return Promise.resolve(false);
  const detail = notificationText();
  const title = ev.kind === 'approval' ? ev.botName + ' needs your approval'
    : ev.kind === 'takeover' ? ev.botName + ' needs you on its screen'
    : ev.botName + ' finished';
  const body = ev.kind === 'takeover' ? ev.reason : ev.kind === 'turn' ? ev.lastText : undefined;
  return notify({ title, body: body ? clip(body) : title, roomId: ev.roomId, detail });
}
