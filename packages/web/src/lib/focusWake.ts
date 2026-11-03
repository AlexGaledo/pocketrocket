// Selecting a bot wakes its computer once the user has settled on it, and keeps it up while the app stays open on it.
import { useEffect } from 'react';
import { botById, useStore } from '../store';
import { api } from './api';
import { hasComputer, selectScreenBotId } from './screenView';

/** Long enough that clicking through bots starts nothing. */
export const FOCUS_WAKE_MS = 1500;
/** Shorter than the idle stop, so the bot in front of the user is not put to sleep under them. */
const KEEP_UP_MS = 5 * 60_000;

/** Not on a paired phone: there, only opening a bot's screen wakes it (RightPanel). */
export function useFocusWake() {
  const botId = useStore(selectScreenBotId);
  const wanted = useStore((s) => hasComputer(botById(s.bots, botId)));
  const on = useStore((s) => s.connected && !s.device);
  useEffect(() => {
    if (!on || !botId || !wanted) return;
    const wake = () => {
      if (document.visibilityState === 'visible') void api.computers.wake(botId, { auto: true }).catch(() => undefined);
    };
    const settle = setTimeout(wake, FOCUS_WAKE_MS);
    const keepUp = setInterval(wake, KEEP_UP_MS);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearTimeout(settle);
      clearInterval(keepUp);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [on, botId, wanted]);
}
