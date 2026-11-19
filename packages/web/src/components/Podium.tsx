import { Pencil, Plus, Star } from 'lucide-react';
import { MAX_PODIUM_BOTS, type Bot } from '@pocketrocket/shared';
import { useStore } from '../store';
import { avatarStatus, type BotStatus } from '../lib/botStatus';
import { Avatar, cn } from './ui';

const TILE = 'flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 pb-1.5 pt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** The owner's main bots, large and always in reach, above the bot list. A paired phone can open them but not change them. */
export function Podium({ bots, statusOf, activeBotId, unreadOf, onOpen, canEdit }: {
  bots: Bot[];
  statusOf: (botId: string) => BotStatus;
  activeBotId: string | null;
  unreadOf: (botId: string) => number;
  onOpen: (botId: string) => void;
  canEdit: boolean;
}) {
  const openDialog = useStore((s) => s.openDialog);
  const personaBotId = useStore((s) => s.settings.personaBotId);
  const edit = () => openDialog({ kind: 'podium' });
  const empty = canEdit ? MAX_PODIUM_BOTS - bots.length : 0;
  if (!bots.length && !empty) return null;
  return (
    <section aria-label="Podium" className="group/podium relative mb-1 px-1.5">
      <ul className="grid grid-cols-3 gap-1">
        {bots.map((b) => {
          const unread = unreadOf(b.id);
          const active = b.id === activeBotId;
          return (
            <li key={b.id} className="min-w-0">
              <button
                className={cn(TILE, 'w-full hover:bg-hover', active && 'bg-active')}
                aria-current={active ? 'page' : undefined}
                title={b.title ? b.name + ' · ' + b.title : b.name}
                onClick={() => onOpen(b.id)}
              >
                <span className="relative">
                  <Avatar bot={b} {...avatarStatus(statusOf(b.id))} size={46} />
                  {b.id === personaBotId && <span title="Your assistant" className="absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-warn text-on-fill ring-2 ring-bg"><Star aria-hidden size={10} fill="currentColor" /></span>}
                  {unread > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg"><span className="sr-only">{unread} unread</span></span>}
                </span>
                <span className="w-full truncate text-center text-hint font-medium">{b.title ? b.name + ' · ' + b.title : b.name}</span>
              </button>
            </li>
          );
        })}
        {Array.from({ length: empty }, (_, i) => (
          <li key={i} className="min-w-0">
            <button className={cn(TILE, 'w-full text-dim hover:bg-hover hover:text-fg')} title="Choose a podium bot" onClick={edit}>
              <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full border border-dashed border-line"><Plus aria-hidden size={16} /></span>
              <span className="w-full truncate text-center text-hint">Add bot</span>
            </button>
          </li>
        ))}
      </ul>
      {canEdit && (
        <button
          className="absolute right-1.5 top-0 rounded-sm p-1 text-dim opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover/podium:opacity-100 [@media(hover:none)]:opacity-100"
          title="Edit podium"
          aria-label="Edit podium"
          onClick={edit}
        >
          <Pencil size={13} />
        </button>
      )}
    </section>
  );
}
