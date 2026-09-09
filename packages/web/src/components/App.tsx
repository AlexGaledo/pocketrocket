import { useEffect } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { useStore } from '../store';
import { Sidebar } from './Sidebar';
import { ChatPane } from './ChatPane';
import { RightPanel } from './RightPanel';
import { BotDialog } from './dialogs/BotDialog';
import { RoomDialog } from './dialogs/RoomDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { Onboarding } from './Onboarding';
import { TokenPrompt } from './TokenPrompt';
import { cn } from './ui';

export function App() {
  const connected = useStore((s) => s.connected);
  const panelOpen = useStore((s) => s.panelOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const dialog = useStore((s) => s.dialog);
  const toasts = useStore((s) => s.toasts);
  const openDialog = useStore((s) => s.openDialog);
  const settings = useStore((s) => s.settings);
  const helloReceived = useStore((s) => s.helloReceived);
  const showOnboarding = helloReceived && settings.onboarded === false;

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

  return (
    <div className="flex h-full w-full gap-3 overflow-hidden p-3">
      {sidebarOpen ? (
        <Sidebar />
      ) : (
        // Collapsed: a single button rather than a rail, so the chat gets the whole width back.
        <button
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-full bg-panel text-muted shadow-[var(--shadow)] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          title="Show bots (Ctrl+B)"
          aria-label="Show bots"
          onClick={toggleSidebar}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      <main className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatPane />
      </main>
      {panelOpen && <RightPanel />}

      {!connected && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] text-ink-fg shadow-[var(--shadow-lg)]">
          Connecting to the hub
        </div>
      )}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cn('rounded-full px-3.5 py-2 text-[12.5px] shadow-[var(--shadow-lg)]', t.bad ? 'bg-bad text-white' : 'bg-ink text-ink-fg')}>
            {t.text}
          </div>
        ))}
      </div>

      {dialog?.kind === 'bot' && <BotDialog bot={dialog.bot} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'room' && <RoomDialog room={dialog.room} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'settings' && <SettingsDialog onClose={() => openDialog(null)} />}

      {showOnboarding && <Onboarding />}
      <TokenPrompt />
    </div>
  );
}
