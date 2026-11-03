import { useState } from 'react';
import type * as React from 'react';
import { type LucideIcon } from 'lucide-react';
import { BOT_ICON_KEYS, isMediaRef } from '@pocketrocket/shared';
import { botIcon, iconGlyph } from '../../lib/botIcon';
import { useMediaUrl } from '../../lib/media';
import { Label, cn, radioKeyDown } from '../ui';
import { PictureUpload } from './PictureUpload';

const CELL = 'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
const ON = 'text-fg ring-2 ring-accent';

/**
 * `''` is Automatic. A new bot has no id yet, so its Automatic choice has no glyph or tint to show. A group chat passes
 * `automatic`, the mark it wears with no choice made. A picture picked here stays on offer while the dialog is open.
 */
export function BotIconPicker({ botId, value, onChange, label = 'Icon', hint = "Automatic picks one from the bot's ID", automatic }: {
  botId: string | null;
  value: string;
  onChange: (avatar: string) => void;
  label?: string;
  hint?: string;
  automatic?: LucideIcon;
}) {
  const derived = botId ? botIcon({ id: botId, avatar: '' }) : null;
  const AutoGlyph = automatic ?? derived?.Glyph;
  const fill = automatic ? 'var(--card2)' : derived?.tint ?? 'var(--card2)';
  const [picture, setPicture] = useState(isMediaRef(value) ? value : '');
  const src = useMediaUrl(picture);
  const groupId = label === 'Icon' ? 'bot-icon-label' : 'room-icon-label';
  const radio = (key: string, name: string) => ({
    type: 'button' as const,
    role: 'radio',
    'aria-checked': value === key,
    tabIndex: value === key ? 0 : -1,
    onClick: () => onChange(key),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => radioKeyDown(e, () => onChange(key)),
    title: name,
    'aria-label': name,
    style: { background: value === key ? fill : 'var(--card2)' },
  });
  return (
    <div className="mt-3">
      <Label id={groupId} hint={hint}>{label}</Label>
      <div role="radiogroup" aria-labelledby={groupId} className="flex flex-wrap gap-1.5">
        {picture && (
          <button {...radio(picture, 'Picture')} className={cn(CELL, 'w-8 overflow-hidden', value === picture && ON)}>
            {src && <img src={src} alt="" className="h-full w-full rounded-full object-cover" />}
          </button>
        )}
        <button {...radio('', 'Automatic')} className={cn(CELL, 'px-2.5 text-hint', value === '' && ON)}>
          {AutoGlyph && <AutoGlyph aria-hidden size={16} strokeWidth={1.75} />}Automatic
        </button>
        {BOT_ICON_KEYS.map((key) => {
          const Glyph = iconGlyph(key);
          return (
            <button key={key} {...radio(key, key[0].toUpperCase() + key.slice(1))} className={cn(CELL, 'w-8', value === key && ON)}>
              <Glyph aria-hidden size={16} strokeWidth={1.75} />
            </button>
          );
        })}
      </div>
      <div className="mt-2">
        <PictureUpload onUploaded={(ref) => { setPicture(ref); onChange(ref); }} />
      </div>
    </div>
  );
}
