/**
 * Settings: a wide dialog with a section list on the left (a tab strip across the top in a narrow
 * window) — Account · Claude · Bots · Appearance · About. Each section lives in components/settings/.
 * The list is Radix Tabs, which brings arrow-key navigation, aria-selected and the tab/tabpanel wiring.
 * The last section opened is remembered until the page reloads.
 */
import { useCallback, useEffect, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Info, Palette, ShieldCheck, Sparkles, UserRound, type LucideIcon } from 'lucide-react';
import { useStore } from '../../store';
import { api, type HealthResponse } from '../../lib/api';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { DialogCloseButton, DialogShell, DialogTitle } from '../ui';
import { AccountSection } from '../settings/AccountSection';
import { ClaudeSection } from '../settings/ClaudeSection';
import { BotsSection } from '../settings/BotsSection';
import { AppearanceSection } from '../settings/AppearanceSection';
import { AboutSection } from '../settings/AboutSection';

type SectionId = 'account' | 'claude' | 'bots' | 'appearance' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'claude', label: 'Claude', icon: Sparkles },
  { id: 'bots', label: 'Bots', icon: ShieldCheck },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

/** Matches Tailwind's `sm` breakpoint, where the section list moves from the top to the left. */
const SIDE_NAV_QUERY = '(min-width: 640px)';

// Module scope rather than component state: the dialog unmounts when it closes, and the choice should
// outlive that. A reload starts again at Account, which is fine (no persistence wanted).
let lastSection: SectionId = 'account';

/** GET /api/health, shared by Bots (approvals lock) and About. Refetched when approvals change. */
function useHealth() {
  const approvals = useStore((s) => s.settings.approvals);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const refresh = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(refresh, [refresh, approvals]);
  return { health, refresh };
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>(lastSection);
  const sideNav = useMediaQuery(SIDE_NAV_QUERY);
  const { health, refresh: refreshHealth } = useHealth();

  // A small dot on "Claude" when it isn't ready, so the problem is visible from any section.
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.settings.provider);
  const list = providers?.providers ?? [];
  const active = list.find((p) => p.id === providerId) ?? list[0];
  const claudeNeedsAttention = !!active && !active.check.ok;

  const select = (value: string) => {
    lastSection = value as SectionId;
    setSection(value as SectionId);
  };

  return (
    <DialogShell open onOpenChange={(o) => !o && onClose()} className="flex h-[min(680px,calc(100dvh-1.5rem))] w-[880px] flex-col overflow-hidden">
      <TabsPrimitive.Root
        value={section}
        onValueChange={select}
        orientation={sideNav ? 'vertical' : 'horizontal'}
        className="flex min-h-0 flex-1 flex-col sm:flex-row"
      >
        <aside className="flex shrink-0 flex-col px-3 pt-4 sm:w-52 sm:border-r sm:border-line sm:bg-card2/30 sm:pb-3 sm:pt-6">
          <div className="flex items-center justify-between px-2 pb-2 sm:pb-4">
            <DialogTitle>Settings</DialogTitle>
            <div className="sm:hidden"><DialogCloseButton /></div>
          </div>
          <TabsPrimitive.List aria-label="Settings sections" className="-mx-3 flex gap-1 overflow-x-auto px-3 py-1 sm:mx-0 sm:flex-col sm:overflow-visible sm:px-0">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <TabsPrimitive.Trigger
                key={id}
                value={id}
                className="flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium text-muted hover:bg-card2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 data-[state=active]:bg-card2 data-[state=active]:text-fg sm:gap-2.5 sm:px-3 sm:py-2 sm:data-[state=active]:bg-panel sm:data-[state=active]:shadow-[var(--shadow)]"
              >
                {/* Icons only in the side list; the top strip needs the room to fit all five names. */}
                <Icon size={15} aria-hidden className="hidden shrink-0 sm:block" />
                {id === 'claude' && list.length > 1 ? 'Connection' : label}
                {id === 'claude' && claudeNeedsAttention && (
                  <>
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn sm:ml-auto" />
                    <span className="sr-only">(needs attention)</span>
                  </>
                )}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </aside>

        <div className="relative min-h-0 flex-1 border-t border-line sm:border-t-0">
          <div className="absolute right-4 top-4 z-10 hidden sm:block"><DialogCloseButton /></div>
          <div className="h-full overflow-y-auto">
            {/* tabIndex -1: every panel has its own controls to Tab into, so the panel itself needn't be a stop. */}
            <TabsPrimitive.Content value="account" tabIndex={-1} className={PANEL}><AccountSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="claude" tabIndex={-1} className={PANEL}><ClaudeSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="bots" tabIndex={-1} className={PANEL}><BotsSection health={health} onHealthStale={refreshHealth} /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="appearance" tabIndex={-1} className={PANEL}><AppearanceSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="about" tabIndex={-1} className={PANEL}><AboutSection health={health} /></TabsPrimitive.Content>
          </div>
        </div>
      </TabsPrimitive.Root>
    </DialogShell>
  );
}

/** Panel padding: roomier beside the side list, tighter under the top strip. */
const PANEL = 'px-5 py-5 focus:outline-none sm:px-8 sm:py-7';
