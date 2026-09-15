import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PanelLeftOpen, X } from 'lucide-react';
import { useStore } from '../store';
import { useMediaQuery } from '../lib/useMediaQuery';
import { reconnectWsNow } from '../lib/ws';
import { Sidebar } from './Sidebar';
import { ChatPane } from './ChatPane';
import { RightPanel } from './RightPanel';
import { BotDialog } from './dialogs/BotDialog';
import { RoomDialog } from './dialogs/RoomDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { Onboarding } from './Onboarding';
import { TokenPrompt } from './TokenPrompt';
import { Button, cn } from './ui';

/** Tailwind's md and lg. Below these the sidebar and the right panel become drawers over the chat. */
const MD_QUERY = '(min-width: 768px)';
const LG_QUERY = '(min-width: 1024px)';

/** How long "Connecting to the hub" may show before it turns into a card that says what is wrong. */
const CONNECT_GRACE_MS = 5000;

export function App() {
  const panelOpen = useStore((s) => s.panelOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const closePanel = useStore((s) => s.closePanel);
  const dialog = useStore((s) => s.dialog);
  const openDialog = useStore((s) => s.openDialog);
  const settings = useStore((s) => s.settings);
  const helloReceived = useStore((s) => s.helloReceived);
  const showOnboarding = helloReceived && settings.onboarded === false;
  // Side by side needs room: at phone width a fixed 236px sidebar plus a 340px panel left the chat no
  // width at all and pushed the panel's close button off-screen.
  const sidebarInline = useMediaQuery(MD_QUERY);
  const panelInline = useMediaQuery(LG_QUERY);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+B mirrors the editor convention for showing and hiding a side panel.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        useStore.getState().toggleSidebar();
        return;
      }
      if (e.key === 'Escape' && dialog) openDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, openDialog]);

  // Shrinking the window past a breakpoint closes that side rather than dropping an open drawer over the
  // chat. Only on the change itself; the store already starts both closed on a narrow window.
  const wasInline = useRef({ sidebar: sidebarInline, panel: panelInline });
  useEffect(() => {
    const was = wasInline.current;
    if (was.sidebar && !sidebarInline && useStore.getState().sidebarOpen) setSidebarOpen(false);
    if (was.panel && !panelInline && useStore.getState().panelOpen) closePanel();
    wasInline.current = { sidebar: sidebarInline, panel: panelInline };
  }, [sidebarInline, panelInline, setSidebarOpen, closePanel]);

  return (
    <div className="flex h-full w-full gap-3 overflow-hidden p-3">
      {sidebarOpen && sidebarInline ? (
        <Sidebar />
      ) : (
        // Collapsed: a single button rather than a rail, so the chat gets the whole width back.
        <button
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-full bg-panel text-muted shadow-[var(--shadow)] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          title="Show bots (Ctrl+B)"
          aria-label="Show bots"
          aria-expanded={sidebarOpen}
          onClick={toggleSidebar}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      <main className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatPane />
      </main>
      {panelOpen && panelInline && <RightPanel />}

      {sidebarOpen && !sidebarInline && (
        <Drawer side="left" label="Bots and chats" onClose={() => setSidebarOpen(false)}>
          <Sidebar />
        </Drawer>
      )}
      {panelOpen && !panelInline && (
        <Drawer side="right" label="Side panel" onClose={closePanel}>
          <RightPanel />
        </Drawer>
      )}

      <HubStatus />
      <Toasts />

      {dialog?.kind === 'bot' && <BotDialog bot={dialog.bot} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'room' && <RoomDialog room={dialog.room} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog onClose={() => openDialog(null)} />}

      {showOnboarding && <Onboarding />}
      <TokenPrompt />
    </div>
  );
}

/**
 * A side panel laid over the chat on a narrow window: backdrop click or Escape closes it, focus moves in
 * on open and goes back to where it was on close. It sits under the dialogs (z-40/50) so a bot's settings
 * opened from inside the drawer still come up on top.
 */
function Drawer({ side, label, onClose, children }: { side: 'left' | 'right'; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-30 flex" role="dialog" aria-modal="true" aria-label={label}>
      <div aria-hidden className="absolute inset-0 bg-black/30 backdrop-blur-[2px] dark:bg-black/60" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        // On the panel rather than window: Escape inside a dialog opened over the drawer must close that
        // dialog only, and the dialog is portaled outside this subtree.
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        className={cn('relative flex h-full max-w-full bg-bg p-3 shadow-[var(--shadow-lg)] focus:outline-none', side === 'right' && 'ml-auto')}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * "Connecting to the hub" for the first few seconds, then a card with the likely cause and a Retry. Hidden
 * when the cause is a rejected token, since the token panel is already asking for one.
 */
function HubStatus() {
  const connected = useStore((s) => s.connected);
  const disconnectedAt = useStore((s) => s.disconnectedAt);
  const issue = useStore((s) => s.hubIssue);
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (connected || disconnectedAt === null) return;
    const timer = setTimeout(() => setLate(true), Math.max(0, disconnectedAt + CONNECT_GRACE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [connected, disconnectedAt]);

  if (connected || issue?.kind === 'auth') return null;
  if (!late) {
    return (
      <div role="status" className="fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] text-ink-fg shadow-[var(--shadow-lg)]">
        Connecting to the hub…
      </div>
    );
  }

  const cause =
    issue?.kind === 'unreachable' ? (issue.detail ? issue.detail + ' ' : '') + 'Check that PocketRocket is running.'
    : issue?.kind === 'rateLimited' ? 'The hub is pausing connections after too many failed sign-in attempts. Trying again in about ' + Math.ceil(issue.retryInMs / 1000) + ' seconds.'
    : issue?.kind === 'refused' ? 'The hub is running but refused the live connection. Reloading the page usually fixes this.'
    : 'Still trying to connect.';
  return (
    <div role="alert" className="fixed left-1/2 top-4 z-[100] w-[360px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl bg-panel p-4 shadow-[var(--shadow-lg)] ring-1 ring-line">
      <div className="text-[13.5px] font-semibold">Can't reach the hub</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{cause}</p>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="primary" onClick={reconnectWsNow}>Retry</Button>
      </div>
    </div>
  );
}

/**
 * Above the onboarding overlay and dialogs, so an error during setup is never hidden behind the blur. The
 * container is the live region; pointer-events stay on for the toasts themselves so a modal's inert body
 * does not swallow the dismiss button.
 */
function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[100] flex max-w-[calc(100vw-2.5rem)] flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-center gap-1 rounded-[18px] py-1 pl-3.5 pr-1 text-[12.5px] shadow-[var(--shadow-lg)]',
            t.bad ? 'bg-bad text-white' : 'bg-ink text-ink-fg',
          )}
        >
          {t.action ? (
            <button
              className="rounded-full py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
              onClick={() => {
                dismissToast({ id: t.id });
                t.action!.run();
              }}
            >
              {t.text} <span className="font-semibold underline underline-offset-2">{t.action.label}</span>
            </button>
          ) : (
            <span className="py-1">{t.text}</span>
          )}
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full opacity-70 hover:bg-current/15 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismissToast({ id: t.id })}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
