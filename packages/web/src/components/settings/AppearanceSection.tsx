/**
 * Settings › Appearance: theme (follow the computer, light, dark), font, and sound cues with previews.
 * Both apply the moment they change; the store saves them and rolls back if the save fails.
 * `readOnly` (a paired phone, which may not write hub settings): shown, not changeable; previews still play.
 */
import { useId } from 'react';
import { Volume2 } from 'lucide-react';
import type { Settings } from '@pocketrocket/shared';
import { useStore } from '../../store';
import { preview, type Cue } from '../../lib/sounds';
import { Button, Switch, cn } from '../ui';
import { Card, Group, SectionHeader } from './parts';

const THEMES: { id: Settings['theme']; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const FONTS: { id: Settings['font']; label: string; family: string }[] = [
  { id: 'google-sans', label: 'Google Sans', family: '"Google Sans Variable", sans-serif' },
  { id: 'figtree', label: 'Figtree', family: '"Figtree Variable", sans-serif' },
];

const CUES: { id: Cue; label: string }[] = [
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Reply arrives' },
  { id: 'approvalRequest', label: 'Approval needed' },
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
  { id: 'done', label: 'Turn done' },
  { id: 'error', label: 'Turn error' },
  { id: 'connected', label: 'Connected' },
];

export function AppearanceSection({ readOnly = false }: { readOnly?: boolean } = {}) {
  const theme = useStore((s) => s.settings.theme);
  const font = useStore((s) => s.settings.font);
  const sounds = useStore((s) => s.settings.sounds);
  const updateSettings = useStore((s) => s.updateSettings);
  const themeLabelId = useId();
  const fontLabelId = useId();
  const soundsLabelId = useId();
  const soundsHintId = useId();

  return (
    <>
      <SectionHeader title="Appearance" description={readOnly ? 'Change these on the desktop app.' : undefined} />

      <Group title="Theme" titleId={themeLabelId}>
        {/* A group of toggle buttons (aria-pressed), not tabs: picking one changes a setting, it doesn't swap a view. */}
        <div role="group" aria-labelledby={themeLabelId} className="flex gap-0.5 rounded-md bg-card2 p-0.5">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={theme === t.id}
              disabled={readOnly}
              className={cn(
                'flex-1 rounded-sm px-2 py-1.5 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default',
                theme === t.id ? 'bg-panel text-fg shadow-[var(--shadow-sm)]' : readOnly ? 'text-muted' : 'text-muted hover:text-fg',
              )}
              onClick={() => void updateSettings({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Group>

      <Group title="Font" titleId={fontLabelId}>
        <div role="group" aria-labelledby={fontLabelId} className="flex gap-0.5 rounded-md bg-card2 p-0.5">
          {FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={font === f.id}
              disabled={readOnly}
              style={{ fontFamily: f.family }}
              className={cn(
                'flex-1 rounded-sm px-2 py-1.5 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default',
                font === f.id ? 'bg-panel text-fg shadow-[var(--shadow-sm)]' : readOnly ? 'text-muted' : 'text-muted hover:text-fg',
              )}
              onClick={() => void updateSettings({ font: f.id })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Group>

      <Group>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div id={soundsLabelId} className="text-label">Sounds</div>
              <p id={soundsHintId} className="text-hint text-muted">Cues for replies, approvals, finished work.</p>
            </div>
            <Switch checked={sounds} disabled={readOnly} aria-labelledby={soundsLabelId} aria-describedby={soundsHintId} onChange={(next) => void updateSettings({ sounds: next })} />
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-hint text-muted">
              <Volume2 size={13} aria-hidden /> Preview
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CUES.map((c) => (
                <Button key={c.id} size="sm" onClick={() => preview(c.id)} aria-label={'Play the ' + c.label.toLowerCase() + ' sound'}>{c.label}</Button>
              ))}
            </div>
          </div>
        </Card>
      </Group>
    </>
  );
}
