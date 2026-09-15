import { create } from 'zustand';
import type { Bot, BotState, Message, Room, ServerEvent, UsageTotals, Settings, SettingsPatch, ProvidersResponse, AccountState } from '@pocketrocket/shared';
import { DEFAULT_SETTINGS, MODELS, SIGNED_OUT } from '@pocketrocket/shared';
import { api, type AccountActionResponse } from './lib/api';
import { wsSend } from './lib/ws';
import { play, setSoundsEnabled } from './lib/sounds';
import { applyTheme, watchSystemTheme } from './lib/theme';
import { isDesktopMode } from './lib/auth';

export type PanelTab = 'screen' | 'memory' | 'skills' | 'routines' | 'usage';

interface Streaming { botId: string; roomId: string; text: string }

/** Providers list to fall back to when GET /api/providers 404s (hub not caught up yet) or errors. */
const FALLBACK_PROVIDERS: ProvidersResponse = {
  active: 'claude',
  providers: [
    {
      id: 'claude',
      label: 'Claude',
      blurb: 'Anthropic Claude via the Agent SDK. Subscription or API key.',
      authModes: ['subscription', 'apiKey'],
      secretKeys: [],
      permissions: 'full',
      maturity: 'verified',
      check: { ok: true, auth: 'unknown' },
      models: MODELS.map((m) => ({ id: m.id, label: m.label })),
    },
  ],
};

// turnId -> last time a 'receive' sound fired for that turn, so turn.end doesn't double it with 'done'.
const recentReceive = new Map<string, number>();

/** True when a response body is a full AccountState rather than a bare `{ ok }`. */
function isAccountState(v: unknown): v is AccountState {
  return typeof v === 'object' && v !== null && 'enabled' in v && 'signedIn' in v;
}

/**
 * Below these widths the side panels start closed, and opening or closing them is not remembered. The
 * saved choice is a desktop preference: closing a drawer on a phone-sized window must not hide the panel
 * the next time the app opens full screen. The panel query is wider than App's drawer breakpoint (lg)
 * because between the two the chat is left too narrow to read with the 340px panel beside it.
 */
export const NARROW_PANEL_QUERY = '(max-width: 1099px)';
export const NARROW_SIDEBAR_QUERY = '(max-width: 767px)';
function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export interface Toast {
  id: number;
  text: string;
  bad?: boolean;
  /** Makes the text a button that runs this (and dismisses the toast). */
  action?: { label: string; run: () => void };
  /** Stays until dismissed or removed by `key`, instead of fading after a few seconds. */
  sticky?: boolean;
  /** Lets code remove the toast later (e.g. once an approval is answered). */
  key?: string;
}
export type ToastOptions = Pick<Toast, 'action' | 'sticky' | 'key'>;

/** Why the live connection is down, as far as lib/ws.ts could tell. */
export type HubIssue =
  | { kind: 'unreachable'; detail?: string }
  | { kind: 'rateLimited'; retryInMs: number }
  | { kind: 'auth' }
  | { kind: 'refused' };

/** Toast key for an approval card, so it can be found by room (on opening it) or by approval (once answered). */
const approvalToastKey = (roomId: string, approvalId: string) => 'approval:' + roomId + ':' + approvalId;

/** The parts of Settings that live outside React: the sound engine and the `dark` class on <html>. */
function applyLocalSettings(s: Settings) {
  setSoundsEnabled(s.sounds);
  applyTheme(s.theme);
}

interface State {
  connected: boolean;
  /** When the connection last went down (or the page loaded without one); null while connected. */
  disconnectedAt: number | null;
  /** The diagnosed cause while disconnected; null until a probe has said anything. */
  hubIssue: HubIssue | null;
  bots: Bot[];
  rooms: Room[];
  botStates: Record<string, BotState>;
  activeRoomId: string | null;
  messages: Record<string, Message[]>;
  loaded: Record<string, boolean>;
  streaming: Record<string, Streaming>;
  unread: Record<string, number>;
  usage: Record<string, UsageTotals>;
  memory: Record<string, string>;
  panelOpen: boolean;
  /** Left sidebar. Same treatment as panelOpen: remembered per browser so a narrow screen stays narrow. */
  sidebarOpen: boolean;
  panelTab: PanelTab;
  panelBotId: string | null;
  dialog: { kind: 'bot'; bot: Bot | null } | { kind: 'room'; room: Room | null } | { kind: 'settings' } | null;
  toasts: Toast[];
  settings: Settings;
  providers: ProvidersResponse | null;
  /** Optional sign-in. SIGNED_OUT (enabled: false) until GET /api/account answers, and if it never does. */
  account: AccountState;
  /**
   * True once the hub's first `hello` has arrived, and from then on. Until then `bots` and `rooms` are
   * empty because nothing has loaded, not because there are none: gate every empty state on this.
   */
  helloReceived: boolean;
  _playedConnectedSound: boolean;

  setConnected: (v: boolean) => void;
  setHubIssue: (issue: HubIssue | null) => void;
  /**
   * Applies the patch at once, then saves it. If the save fails the touched keys go back to what they
   * were and a toast says why. Resolves true when the hub accepted the change.
   */
  updateSettings: (patch: SettingsPatch) => Promise<boolean>;
  fetchProviders: () => Promise<void>;
  fetchAccount: () => Promise<void>;
  /** Takes the answer of an account POST: a full AccountState is used as is, anything else triggers a refetch. */
  applyAccountResponse: (res: AccountActionResponse) => void;
  applyEvent: (ev: ServerEvent) => void;
  setActiveRoom: (id: string | null) => void;
  loadMessages: (roomId: string) => Promise<void>;
  sendMessage: (text: string) => void;
  decide: (approvalId: string, decision: 'allow' | 'always' | 'deny') => void;
  interrupt: (turnId: string) => void;
  openPanel: (tab: PanelTab, botId?: string | null) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  closePanel: () => void;
  openDialog: (d: State['dialog']) => void;
  toast: (text: string, bad?: boolean, opts?: ToastOptions) => void;
  /** Removes toasts by id, or every toast whose key starts with the given prefix. */
  dismissToast: (which: { id: number } | { keyPrefix: string }) => void;
  refresh: () => Promise<void>;
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  connected: false,
  disconnectedAt: Date.now(),
  hubIssue: null,
  bots: [],
  rooms: [],
  botStates: {},
  activeRoomId: localStorage.getItem('pocketrocket.activeRoom'),
  messages: {},
  loaded: {},
  streaming: {},
  unread: {},
  usage: {},
  memory: {},
  panelOpen: !matches(NARROW_PANEL_QUERY) && localStorage.getItem('pocketrocket.panel') !== '0',
  sidebarOpen: !matches(NARROW_SIDEBAR_QUERY) && localStorage.getItem('pocketrocket.sidebar') !== '0',
  panelTab: 'memory',
  panelBotId: null,
  dialog: null,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  providers: null,
  account: SIGNED_OUT,
  helloReceived: false,
  _playedConnectedSound: false,

  setConnected: (connected) => {
    const was = get().connected;
    if (connected) set({ connected, disconnectedAt: null, hubIssue: null });
    else if (was) set({ connected, disconnectedAt: Date.now() });
    if (connected && !was && isDesktopMode() && !get()._playedConnectedSound) {
      set({ _playedConnectedSound: true });
      play('connected');
    }
  },

  applyEvent: (ev) => {
    const s = get();
    switch (ev.type) {
      case 'hello': {
        const settings = ev.settings ?? DEFAULT_SETTINGS;
        set({ bots: ev.bots, rooms: ev.rooms, botStates: ev.botStates, loaded: {}, settings, helloReceived: true });
        applyLocalSettings(settings);
        watchSystemTheme(() => get().settings.theme);
        void get().fetchProviders();
        void get().fetchAccount();
        const active = s.activeRoomId && ev.rooms.some((r) => r.id === s.activeRoomId) ? s.activeRoomId : (ev.rooms[0]?.id ?? null);
        get().setActiveRoom(active);
        return;
      }
      case 'settings.changed': {
        set({ settings: ev.settings });
        applyLocalSettings(ev.settings);
        return;
      }
      case 'providers.changed': {
        void get().fetchProviders();
        return;
      }
      case 'account.changed':
        set({ account: ev.account });
        return;
      case 'bots.changed':
        set({ bots: ev.bots });
        return;
      case 'rooms.changed': {
        set({ rooms: ev.rooms });
        if (s.activeRoomId && !ev.rooms.some((r) => r.id === s.activeRoomId)) get().setActiveRoom(ev.rooms[0]?.id ?? null);
        return;
      }
      case 'message.new': {
        const m = ev.message;
        const list = s.messages[m.roomId] ?? [];
        if (list.some((x) => x.id === m.id)) return;
        const unread = { ...s.unread };
        if (m.roomId !== s.activeRoomId && m.authorType !== 'user' && (m.kind === 'text' || m.kind === 'approval')) unread[m.roomId] = (unread[m.roomId] ?? 0) + 1;
        // a bot text message replaces its in-flight stream buffer for that turn
        const streaming = { ...s.streaming };
        if (m.turnId && m.kind === 'text' && streaming[m.turnId]) streaming[m.turnId] = { ...streaming[m.turnId], text: '' };
        set({ messages: { ...s.messages, [m.roomId]: [...list, m] }, unread, streaming });
        if (m.authorType === 'bot' && m.kind === 'text') {
          if (m.turnId) recentReceive.set(m.turnId, Date.now());
          play('receive', { roomActive: m.roomId === s.activeRoomId });
        }
        return;
      }
      case 'message.update': {
        const list = s.messages[ev.roomId];
        if (!list) return;
        set({ messages: { ...s.messages, [ev.roomId]: list.map((m) => (m.id === ev.id ? { ...m, ...ev.patch } : m)) } });
        return;
      }
      case 'turn.start':
        set({ streaming: { ...s.streaming, [ev.turnId]: { botId: ev.botId, roomId: ev.roomId, text: '' } } });
        return;
      case 'turn.delta': {
        const cur = s.streaming[ev.turnId] ?? { botId: ev.botId, roomId: ev.roomId, text: '' };
        set({ streaming: { ...s.streaming, [ev.turnId]: { ...cur, text: cur.text + ev.text } } });
        return;
      }
      case 'turn.end': {
        const streaming = { ...s.streaming };
        delete streaming[ev.turnId];
        set({ streaming });
        const roomActive = ev.roomId === s.activeRoomId;
        if (ev.error) {
          play('error', { roomActive });
        } else {
          const lastReceive = recentReceive.get(ev.turnId);
          const doubleCounted = lastReceive !== undefined && Date.now() - lastReceive < 1500;
          if (!doubleCounted) play('done', { roomActive });
        }
        recentReceive.delete(ev.turnId);
        return;
      }
      case 'bot.state':
        set({ botStates: { ...s.botStates, [ev.botId]: ev.state } });
        return;
      case 'approval.request': {
        play('approvalRequest');
        if (ev.roomId === s.activeRoomId) return;
        // Named and clickable, and it stays: a toast that fades after four seconds is easy to miss while a
        // bot sits blocked in a room the user is not looking at.
        const bot = botById(s.bots, ev.botId);
        const room = s.rooms.find((r) => r.id === ev.roomId);
        const who = bot?.name ?? 'A bot';
        const where = room && room.kind === 'group' ? ' in ' + room.name : '';
        get().toast(who + ' needs your approval' + where, true, {
          sticky: true,
          key: approvalToastKey(ev.roomId, ev.approval.approvalId),
          action: { label: 'Open', run: () => get().setActiveRoom(ev.roomId) },
        });
        return;
      }
      case 'approval.resolved':
        // Answered somewhere (another window, a timeout): the reminder has nothing left to point at.
        set({ toasts: get().toasts.filter((t) => !t.key?.startsWith('approval:') || !t.key.endsWith(':' + ev.approvalId)) });
        return;
      case 'memory.updated':
        set({ memory: { ...s.memory, [ev.botId]: ev.text } });
        return;
      case 'usage.updated':
        set({ usage: { ...s.usage, [ev.botId + ':' + ev.roomId]: ev.totals } });
        return;
      case 'error':
        get().toast(ev.message, true);
        return;
      default:
        return;
    }
  },

  setActiveRoom: (id) => {
    if (id) localStorage.setItem('pocketrocket.activeRoom', id);
    const unread = { ...get().unread };
    if (id) delete unread[id];
    set({ activeRoomId: id, unread });
    // The room is on screen now, approval card included, so its reminders are done.
    if (id) get().dismissToast({ keyPrefix: 'approval:' + id + ':' });
    if (id && !get().loaded[id]) void get().loadMessages(id);
    const room = id ? get().rooms.find((r) => r.id === id) : null;
    if (room && room.kind === 'dm') set({ panelBotId: room.memberIds[0] });
    else if (room && (!get().panelBotId || !room.memberIds.includes(get().panelBotId!))) set({ panelBotId: room.memberIds[0] ?? null });
  },

  loadMessages: async (roomId) => {
    try {
      const msgs = await api.rooms.messages(roomId);
      const existing = get().messages[roomId] ?? [];
      const ids = new Set(msgs.map((m) => m.id));
      const merged = [...msgs, ...existing.filter((m) => !ids.has(m.id))].sort((a, b) => a.seq - b.seq);
      set({ messages: { ...get().messages, [roomId]: merged }, loaded: { ...get().loaded, [roomId]: true } });
    } catch (e) {
      get().toast('Failed to load messages: ' + (e as Error).message, true);
    }
  },

  sendMessage: (text) => {
    const roomId = get().activeRoomId;
    if (!roomId || !text.trim()) return;
    if (wsSend({ type: 'message.send', roomId, text })) play('send');
    else get().toast('Not connected', true);
  },
  decide: (approvalId, decision) => {
    wsSend({ type: 'approval.decide', approvalId, decision });
    play(decision === 'deny' ? 'deny' : 'approve');
  },
  interrupt: (turnId) => {
    wsSend({ type: 'turn.interrupt', turnId });
  },
  openPanel: (tab, botId) => {
    if (!matches(NARROW_PANEL_QUERY)) localStorage.setItem('pocketrocket.panel', '1');
    set({ panelOpen: true, panelTab: tab, panelBotId: botId === undefined ? get().panelBotId : botId });
  },
  closePanel: () => {
    if (!matches(NARROW_PANEL_QUERY)) localStorage.setItem('pocketrocket.panel', '0');
    set({ panelOpen: false });
  },
  toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
  setSidebarOpen: (open) => {
    if (!matches(NARROW_SIDEBAR_QUERY)) localStorage.setItem('pocketrocket.sidebar', open ? '1' : '0');
    set({ sidebarOpen: open });
  },
  openDialog: (dialog) => set({ dialog }),
  toast: (text, bad, opts) => {
    // A keyed toast replaces its earlier copy rather than stacking a duplicate.
    const id = ++toastSeq;
    const rest = opts?.key ? get().toasts.filter((t) => t.key !== opts.key) : get().toasts;
    set({ toasts: [...rest, { id, text, bad, ...opts }] });
    if (!opts?.sticky) setTimeout(() => get().dismissToast({ id }), 4000);
  },
  dismissToast: (which) => {
    const keep = 'id' in which
      ? (t: Toast) => t.id !== which.id
      : (t: Toast) => !t.key?.startsWith(which.keyPrefix);
    const toasts = get().toasts.filter(keep);
    if (toasts.length !== get().toasts.length) set({ toasts });
  },
  setHubIssue: (hubIssue) => set({ hubIssue }),
  refresh: async () => {
    const [bots, rooms] = await Promise.all([api.bots.list(), api.rooms.list()]);
    set({ bots, rooms });
  },

  updateSettings: async (patch) => {
    const prev = get().settings;
    // Optimistic: the control flips immediately instead of waiting a round trip.
    set({ settings: { ...prev, ...patch } });
    applyLocalSettings(get().settings);
    try {
      const saved = await api.settings.update(patch);
      set({ settings: saved });
      applyLocalSettings(saved);
      return true;
    } catch (e) {
      // Roll back only the keys this call changed, and only if they still hold our optimistic value:
      // a `settings.changed` from another window may have landed meanwhile and must not be undone.
      const current = get().settings;
      const undo = Object.fromEntries(
        (Object.keys(patch) as (keyof Settings)[])
          .filter((key) => current[key] === patch[key])
          .map((key) => [key, prev[key]]),
      ) as Partial<Settings>;
      set({ settings: { ...current, ...undo } });
      applyLocalSettings(get().settings);
      get().toast("Couldn't save that change: " + (e as Error).message, true);
      return false;
    }
  },

  fetchProviders: async () => {
    try {
      const providers = await api.providers.list();
      set({ providers });
    } catch {
      set({ providers: get().providers ?? FALLBACK_PROVIDERS });
    }
  },

  fetchAccount: async () => {
    try {
      const account = await api.account.get();
      set({ account: isAccountState(account) ? account : SIGNED_OUT });
    } catch {
      // No account endpoint on this hub (older build, or the backend is not wired up yet) or it errored:
      // behave exactly like a hub without accounts rather than showing a broken section.
      set({ account: SIGNED_OUT });
    }
  },

  applyAccountResponse: (res) => {
    if (isAccountState(res)) set({ account: res });
    else void get().fetchAccount();
  },
}));

export const selectActiveRoom = (s: State) => s.rooms.find((r) => r.id === s.activeRoomId) ?? null;
export const botById = (bots: Bot[], id: string | null | undefined) => (id ? bots.find((b) => b.id === id) : undefined);
