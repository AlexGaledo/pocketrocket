import { ExternalLink } from 'lucide-react';
import type { Bot } from '@pocketrocket/shared';
import { openPopout } from '../lib/popout';

/** "Open this bot in its own window". A sibling of a bot row's buttons, with the same hover rules as the settings cog. */
export function PopoutButton({ bot, roomId }: { bot: Pick<Bot, 'id' | 'name'>; roomId?: string | null }) {
  return (
    <button
      className="mr-0.5 hidden shrink-0 rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg focus-visible:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:block group-focus-within:block [@media(hover:none)]:block"
      title="Pop out chat"
      aria-label={'Open ' + bot.name + ' in its own window'}
      onClick={() => openPopout(bot.id, roomId)}
    >
      <ExternalLink size={14} />
    </button>
  );
}
