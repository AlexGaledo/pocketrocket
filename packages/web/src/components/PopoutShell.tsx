import { useEffect, useRef } from 'react';
import { useStore, botById } from '../store';
import { Avatar, ConfirmHost } from './ui';
import { ChatPane } from './ChatPane';
import { TokenPrompt } from './TokenPrompt';
import { STATUS_LABEL, avatarStatus, useBotStatus } from '../lib/botStatus';
import type { PopoutRoute } from '../lib/popout';

/**
 * A bot's chat on its own (U1): a slim header and the normal ChatPane, no sidebar, panels or dialogs. It shares
 * the store with the rest of the app, so the outbox, drafts and the hub's live events work the same as in the
 * main window. Closing the window only closes the window.
 */
export function PopoutShell({ route }: { route: PopoutRoute }) {
  const bots = useStore((s) => s.bots);
  const rooms = useStore((s) => s.rooms);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const helloReceived = useStore((s) => s.helloReceived);
  const connected = useStore((s) => s.connected);
  const hasConnected = useStore((s) => s.hasConnected);
  const { statusOf } = useBotStatus();
  const bot = botById(bots, route.botId);
  const picked = useRef(false);

  // Pick the chat once the hub has said which rooms exist: the named room, else the bot's own chat, else any
  // chat it is in. Set straight on the store (not setActiveRoom) so this window's choice is not saved as the
  // main window's last chat; loading its messages is the same call setActiveRoom makes.
  useEffect(() => {
    if (!helloReceived) return;
    const has = (id: string | null) => !!id && rooms.some((r) => r.id === id && r.memberIds.includes(route.botId));
    if (picked.current && has(activeRoomId)) return;
    const target =
      (route.roomId && has(route.roomId) ? route.roomId : null)
      ?? rooms.find((r) => r.kind === 'dm' && r.memberIds.includes(route.botId))?.id
      ?? rooms.find((r) => r.memberIds.includes(route.botId))?.id
      ?? null;
    picked.current = target !== null;
    if (target && target !== activeRoomId) {
      useStore.setState({ activeRoomId: target });
      if (!useStore.getState().loaded[target]) void useStore.getState().loadMessages(target);
    }
  }, [helloReceived, rooms, activeRoomId, route.botId, route.roomId]);

  useEffect(() => {
    document.title = (bot ? bot.name : 'Bot') + ' - PocketRocket';
  }, [bot]);

  const status = bot ? statusOf(bot.id) : null;
  return (
    <div className="flex h-dvh w-full flex-col overflow-clip bg-bg text-fg">
      {bot && status && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <Avatar bot={bot} {...avatarStatus(status)} size={30} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui font-semibold">{bot.name}</div>
            <div className="truncate text-hint text-muted">{STATUS_LABEL[status]}</div>
          </div>
        </div>
      )}
      {!connected && (
        <div role="status" className="shrink-0 bg-ink px-3 py-1 text-center text-ui text-ink-fg">
          {hasConnected ? 'Reconnecting…' : 'Connecting…'}
        </div>
      )}
      {helloReceived && !bot ? (
        <div className="flex flex-1 items-center justify-center p-6 text-ui text-muted">This bot no longer exists.</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col"><ChatPane /></div>
      )}
      <ConfirmHost />
      <TokenPrompt />
    </div>
  );
}
