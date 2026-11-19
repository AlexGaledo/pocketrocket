// The map's prompt bar (docs/specs/toki-ui.md, W8): one line to ask the project's lead for a change, with the boxes
// picked by "Ask about it" as removable chips above it. Enter sends an ordinary message to the project's room; the
// owner stays on the map and a toast says where it went.
import { forwardRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { Bot, Room } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { promptMessage, type PlacedNode } from '../../lib/mapLayout';
import { Chip, cn } from '../ui';

export const MapPrompt = forwardRef<HTMLInputElement, { lead: Bot; room: Room; picked: PlacedNode[]; onUnpick: (id: string) => void; onSent: () => void }>(
  function MapPrompt({ lead, room, picked, onUnpick, onSent }, ref) {
    const [text, setText] = useState('');
    const sendMessage = useStore((s) => s.sendMessage);
    const toast = useStore((s) => s.toast);
    const closePage = useStore((s) => s.closePage);
    const ready = text.trim().length > 0;
    const send = () => {
      if (!ready) return;
      sendMessage(promptMessage(lead.handle, text, picked.map((n) => n.label)));
      setText('');
      onSent();
      toast('Sent to # ' + room.name + '.', false, { action: { label: 'Open chat', run: closePage } });
    };
    return (
      <div data-map-ui className="pointer-events-none absolute inset-x-4 bottom-4 z-10 mx-auto flex max-w-[560px] flex-col gap-2">
        {picked.length > 0 && (
          <div className="pointer-events-auto flex flex-wrap gap-1.5" aria-label="Picked boxes" role="group">
            {picked.map((n) => <Chip key={n.id} className="bg-panel font-mono lowercase ring-1 ring-line" onRemove={() => onUnpick(n.id)} label={n.label}>{n.label}</Chip>)}
          </div>
        )}
        <form className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-panel pl-5 pr-1.5 shadow-[var(--shadow)] ring-1 ring-line focus-within:ring-2 focus-within:ring-accent" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Ask @' + lead.handle + ' to change the map…'}
            aria-label={'Ask @' + lead.handle + ' to change the map'}
            className="min-w-0 flex-1 bg-transparent text-ui text-fg placeholder:text-dim focus:outline-none max-sm:text-[16px]"
            maxLength={2000}
          />
          <button type="submit" aria-label="Send" disabled={!ready} className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel', ready ? 'bg-ink text-ink-fg' : 'bg-card2 text-dim')}>
            <ArrowUp size={16} aria-hidden />
          </button>
        </form>
      </div>
    );
  },
);
