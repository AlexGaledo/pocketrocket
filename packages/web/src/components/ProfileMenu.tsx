import { useRef } from 'react';
import { BarChart3, CalendarClock, ChevronsUpDown, FolderOpen, LogIn, LogOut, Moon, Settings, Sun, UserRound } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../lib/api';
import { resolveDark } from '../lib/theme';
import { Menu, MenuContent, MenuItem, MenuSeparator, UserAvatar, cn } from './ui';

/**
 * Bottom of the sidebar: who you are and whether the server is there, opening onto Automations, Usage, Settings, the shared
 * folder, the theme and the account. The account's email stays out of it, because this gets screen-shared.
 */
export function ProfileMenu({ onNavigate }: { onNavigate: () => void }) {
  const name = useStore((s) => s.settings.userName);
  const avatar = useStore((s) => s.settings.userAvatar);
  const theme = useStore((s) => s.settings.theme);
  const connected = useStore((s) => s.connected);
  const hubIssue = useStore((s) => s.hubIssue);
  const account = useStore((s) => s.account);
  // P9: a paired phone may not open the workspace, change settings or reach account routes (403).
  const device = useStore((s) => s.device);
  const panelBotId = useStore((s) => s.panelBotId);
  const openPage = useStore((s) => s.openPage);
  const openDialog = useStore((s) => s.openDialog);
  const updateSettings = useStore((s) => s.updateSettings);
  const applyAccountResponse = useStore((s) => s.applyAccountResponse);
  const toast = useStore((s) => s.toast);
  const dark = resolveDark(theme);
  const signedIn = !device && account.enabled && account.signedIn;
  const canSignIn = !device && account.enabled && !account.signedIn;
  const server = connected ? 'Server online' : hubIssue ? 'Server offline' : 'Connecting…';

  /**
   * The shared folder lives on whatever machine the hub runs on, so the hub is what opens it. On a server hub
   * that is the virtual desktop, and the toast says so rather than leaving the user staring at their own
   * unchanged screen waiting for a window that was never going to appear here.
   */
  const openWorkspace = async () => {
    try {
      // On a hub with per-bot computers the folder opens on the bot whose screen follows this chat (P1).
      const r = await api.openWorkspace(panelBotId);
      if (!r.ok) return toast(r.error ? "Couldn't open the shared folder: " + r.error : "Couldn't open the shared folder", true);
      const WHERE: Record<string, string> = {
        explorer: 'Shared folder opened in File Explorer',
        finder: 'Shared folder opened in Finder',
        screen: "Folder opened on the bot's screen.",
        'file-manager': 'Shared folder opened in your file manager',
      };
      toast(WHERE[r.where] ?? 'Shared folder opened');
    } catch (e) {
      toast("Couldn't open the shared folder: " + (e as Error).message, true);
    }
  };
  const signOut = async () => {
    try {
      applyAccountResponse(await api.account.signOut());
    } catch (e) {
      toast("Couldn't sign out: " + (e as Error).message, true);
    }
  };

  // An item acts once the menu has fully closed. Opening a dialog while this modal menu is still up leaves
  // the body with pointer-events: none after the dialog closes, and the whole app stops taking clicks.
  const pending = useRef<(() => void) | null>(null);
  const act = (fn: () => void) => () => { pending.current = fn; };
  const runPending = () => {
    const fn = pending.current;
    pending.current = null;
    fn?.();
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={'Menu for ' + name + '. ' + server}
        className="mx-2 mb-2 flex min-w-0 items-center gap-2.5 rounded-sm p-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-hover"
      >
        <UserAvatar name={name} avatar={avatar} size={30} />
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-ui font-medium">{name}</span>
          <span className={cn('block truncate text-hint', connected ? 'text-muted' : 'text-warn')}>{server}</span>
        </span>
        <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-dim" />
      </Menu.Trigger>
      <Menu.Portal>
        <MenuContent side="top" align="start" onCloseAutoFocus={runPending} className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[210px]">
          {/* A paired phone sees the picture but cannot change it (PUT /api/settings is refused). */}
          {!device && <MenuItem onSelect={act(() => openDialog({ kind: 'profile' }))}><UserRound size={16} aria-hidden />Edit profile</MenuItem>}
          <MenuItem onSelect={act(() => { onNavigate(); openPage({ kind: 'automations' }); })}><CalendarClock size={16} aria-hidden />Automations</MenuItem>
          <MenuItem onSelect={act(() => { onNavigate(); openPage({ kind: 'usage' }); })}><BarChart3 size={16} aria-hidden />Usage</MenuItem>
          <MenuItem onSelect={act(() => openDialog({ kind: 'settings' }))}><Settings size={16} aria-hidden />Settings</MenuItem>
          {!device && <MenuItem onSelect={act(() => void openWorkspace())}><FolderOpen size={16} aria-hidden />Open workspace</MenuItem>}
          {!device && (
            <MenuItem onSelect={act(() => void updateSettings({ theme: dark ? 'light' : 'dark' }))}>
              {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}{dark ? 'Light theme' : 'Dark theme'}
            </MenuItem>
          )}
          {(canSignIn || signedIn) && <MenuSeparator />}
          {canSignIn && <MenuItem onSelect={act(() => openDialog({ kind: 'settings', section: 'account' }))}><LogIn size={16} aria-hidden />Sign in</MenuItem>}
          {signedIn && <MenuItem onSelect={act(() => void signOut())}><LogOut size={16} aria-hidden />Sign out</MenuItem>}
        </MenuContent>
      </Menu.Portal>
    </Menu.Root>
  );
}
