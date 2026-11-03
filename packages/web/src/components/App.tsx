import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PanelLeftOpen, X } from 'lucide-react';
import { useStore } from '../store';
import { useMediaQuery } from '../lib/useMediaQuery';
import { reconnectWsNow } from '../lib/ws';
import { CHAT_RAIL_W, PANEL_INLINE_MIN, SIDEBAR_INLINE_MIN, applyPaneVars, paneLayout } from '../lib/panes';
import { selectScreenSize } from '../lib/screenView';
import { PaneSeparator } from './PaneSeparator';
import { Sidebar } from './Sidebar';
import { ChatPane } from './ChatPane';
import { RightPanel } from './RightPanel';
import { BotPage } from './BotPage';
import { AutomationsPage, UsagePage } from './FleetPages';
import { BotDialog } from './dialogs/BotDialog';
import { RoomDialog } from './dialogs/RoomDialog';
import { ProfileDialog } from './dialogs/ProfileDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { Onboarding } from './Onboarding';
import { TokenPrompt } from './TokenPrompt';
import { useFocusWake } from '../lib/focusWake';
import { Button, cn } from './ui';

/** Below these the sidebar becomes a drawer over the chat, and a screen the user opens covers the window. */
const SIDEBAR_QUERY = '(min-width: ' + SIDEBAR_INLINE_MIN + 'px)';
const PANEL_QUERY = '(min-width: ' + PANEL_INLINE_MIN + 'px)';

/** How long "Connecting to the hub" may show before it turns into a card that says what is wrong. */
const CONNECT_GRACE_MS = 5000;

export function App() {
  const screenSize = useStore(selectScreenSize);
  const page = useStore((s) => s.page);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const closePanel = useStore((s) => s.closePanel);
  const dialog = useStore((s) => s.dialog);
  const openDialog = useStore((s) => s.openDialog);
  const settings = useStore((s) => s.settings);
  const helloReceived = useStore((s) => s.helloReceived);
  const device = useStore((s) => s.device);
  // P9: a paired phone cannot write settings, so it never gets the first-run setup.
  const showOnboarding = helloReceived && settings.onboarded === false && !device;
  useFocusWake();
  // Side by side needs room: the panes' minimums plus the chat's must fit, or the panel's close button ends
  // up off-screen.
  const sidebarInline = useMediaQuery(SIDEBAR_QUERY);
  const panelInline = useMediaQuery(PANEL_QUERY);
  const focus = screenSize === 'focus';
  const covering = !panelInline && screenSize !== 'glance';

  // Pane widths are CSS variables, so a resize never re-renders the chat. A drag paints them itself until
  // release, so a store change arriving mid-drag (any streaming message) must not paint over it.
  useLayoutEffect(() => {
    let last = '';
    const apply = () => {
      if (document.body.dataset.paneDrag !== undefined) return;
      const w = paneLayout(window.innerWidth, useStore.getState());
      const key = w.sidebar + ':' + w.panel;
      if (key === last) return;
      last = key;
      applyPaneVars(w);
    };
    apply();
    window.addEventListener('resize', apply);
    const unsubscribe = useStore.subscribe(apply);
    return () => {
      window.removeEventListener('resize', apply);
      unsubscribe();
    };
  }, []);

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

  // The screen gets the room while the user drives it, and Hand back puts the sidebar back as it was. Written
  // to the store directly so it isn't saved as the user's preference.
  useEffect(() => {
    if (!focus) return;
    const was = useStore.getState().sidebarOpen;
    useStore.setState({ sidebarOpen: false });
    return () => useStore.setState({ sidebarOpen: was });
  }, [focus]);

  // Covering the chat, or driving: focus moves to the screen, and back to where it was afterwards.
  const screenRef = useRef<HTMLDivElement>(null);
  const takesFocus = covering || focus;
  useEffect(() => {
    if (!takesFocus) return;
    const before = document.activeElement as HTMLElement | null;
    screenRef.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, [takesFocus]);

  return (
    <div className="flex h-full w-full overflow-hidden pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      {!(sidebarOpen && sidebarInline) && (
        // Collapsed: a single button rather than a rail, so the chat gets the whole width back.
        <button
          className="ml-2 mt-3 flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-md text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title="Show bots (Ctrl+B)"
          aria-label="Show bots"
          aria-expanded={sidebarOpen}
          onClick={toggleSidebar}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      {/* The wrappers stay mounted while empty: they are what each separator's aria-controls points at. */}
      <div id="pane-sidebar" hidden={!(sidebarOpen && sidebarInline)} className="flex shrink-0" style={{ width: 'var(--sidebar-w)' }}>
        {sidebarOpen && sidebarInline && <Sidebar />}
      </div>
      {sidebarInline && <PaneSeparator pane="sidebar" label="Resize sidebar" controls="pane-sidebar" />}
      <main className={cn('@container panel relative flex min-w-0 flex-col overflow-hidden', focus && panelInline ? 'shrink-0 border-r border-line' : 'flex-1')} style={focus && panelInline ? { width: CHAT_RAIL_W } : undefined}>
        {/* Pages lie over the chat rather than replace it, so its draft and scroll position wait underneath. */}
        <div inert={!!page} className="flex min-h-0 flex-1 flex-col"><ChatPane /></div>
        {page && (
          <div className="@container panel absolute inset-0 flex flex-col">
            {page.kind === 'bot' ? <BotPage botId={page.botId} tab={page.tab} /> : page.kind === 'automations' ? <AutomationsPage /> : <UsagePage />}
          </div>
        )}
      </main>
      {panelInline && !focus && <PaneSeparator pane="panel" label="Resize screen" controls="pane-panel" />}
      {/* One element at every size, thumbnail included, with only its CSS changing. Moving an iframe in the DOM
          reloads it, which would spend a ticket and drop the noVNC connection on every change of size. */}
      <div
        id="pane-panel"
        ref={screenRef}
        tabIndex={-1}
        role={covering ? 'dialog' : undefined}
        aria-modal={covering || undefined}
        aria-label={covering ? 'Screen' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && covering && !focus) {
            e.stopPropagation();
            closePanel();
          }
        }}
        className={cn('flex focus:outline-none', covering ? 'fixed inset-0 z-30 bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]' : focus ? 'min-w-0 flex-1' : 'shrink-0')}
        style={covering || focus ? undefined : { width: 'var(--panel-w)' }}
      >
        <RightPanel inline={panelInline} />
      </div>

      {sidebarOpen && !sidebarInline && (
        <Drawer label="Bots and chats" onClose={() => setSidebarOpen(false)}>
          <Sidebar />
        </Drawer>
      )}

      <HubStatus />
      <Toasts />

      {dialog?.kind === 'bot' && <BotDialog bot={dialog.bot} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'room' && <RoomDialog room={dialog.room} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'profile' && <ProfileDialog onClose={() => openDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog section={dialog.section} onClose={() => openDialog(null)} />}

      {showOnboarding && <Onboarding />}
      <TokenPrompt />
    </div>
  );
}

/**
 * The sidebar laid over the chat on a narrow window: backdrop click or Escape closes it, focus moves in
 * on open and goes back to where it was on close. It sits under the dialogs (z-40/50) so a bot's settings
 * opened from inside the drawer still come up on top.
 */
function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
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
        // dialog only. React events bubble through portals, so a menu or dialog opened from in here still
        // reaches this handler; the DOM check is what tells them apart.
        onKeyDown={(e) => {
          if (e.key === 'Escape' && e.currentTarget.contains(e.target as Node)) {
            e.stopPropagation();
            onClose();
          }
        }}
        className="relative flex h-full w-[min(300px,100%)] max-w-full bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow-overlay)] focus:outline-none"
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
      <div role="status" className="fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-full bg-ink px-3.5 py-1.5 text-ui text-ink-fg shadow-[var(--shadow-overlay)]">
        Connecting…
      </div>
    );
  }

  const cause =
    issue?.kind === 'unreachable' ? (issue.detail ? issue.detail + ' ' : '') + 'Check that Homeroom is running.'
    : issue?.kind === 'rateLimited' ? 'Too many failed sign-ins. Retrying in ' + Math.ceil(issue.retryInMs / 1000) + 's.'
    : issue?.kind === 'refused' ? 'Connection refused. Reload this page.'
    : 'Still trying to connect.';
  return (
    <div role="alert" className="fixed left-1/2 top-4 z-[100] w-[360px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-panel p-4 shadow-[var(--shadow-overlay)] ring-1 ring-line">
      <div className="text-ui font-semibold">Can't reach Homeroom</div>
      <p className="mt-1 text-ui leading-relaxed text-muted">{cause}</p>
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
  // Hand back and Done are at the bottom right while the user drives, and an error toast stays until dismissed.
  const driving = useStore(selectScreenSize) === 'focus';
  return (
    <div role="status" aria-live="polite" className={cn('pointer-events-none fixed right-5 z-[100] flex max-w-[calc(100vw-2.5rem)] flex-col items-end gap-2', driving ? 'bottom-24' : 'bottom-5')}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-center gap-1 rounded-lg py-1 pl-3.5 pr-1 text-ui shadow-[var(--shadow-overlay)]',
            t.bad ? 'bg-bad text-on-fill' : t.warn ? 'bg-warn text-on-fill' : 'bg-ink text-ink-fg',
          )}
        >
          {t.action ? (
            <button
              className="rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
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
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm opacity-70 hover:bg-current/15 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
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
