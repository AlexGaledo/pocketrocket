import type { BotPreview } from '@pocketrocket/shared';
import { create } from 'zustand';
import type { Bot, BotState, Message, Room, ServerEvent, UsageTotals, Settings, SettingsPatch, ProvidersResponse, AccountState } from '@pocketrocket/shared';
import { DEFAULT_SETTINGS, MODELS, SIGNED_OUT } from '@pocketrocket/shared';
import type { KnowledgeStatus } from '@pocketrocket/shared';
import type { ControlStatus } from '@pocketrocket/shared';
import type { ComputerStatus, OpenApproval, RecorderStatus } from '@pocketrocket/shared';
import { api, MESSAGE_PAGE, type AccountActionResponse } from './lib/api';
import { wsSend } from './lib/ws';
import { play, setSoundsEnabled } from './lib/sounds';
import { applyFont, applyTheme, watchSystemTheme } from './lib/theme';
import { isDesktopMode, isDevice } from './lib/auth';
import { SIDEBAR_INLINE_MIN, readPaneWidths, writePaneWidth, type PaneId, type PaneWidths } from './lib/panes';
import type { SectionId } from './components/dialogs/SettingsDialog';

export type BotTab = 'memory' | 'skills' | 'automations' | 'computer';
/** What the main pane shows over the chat. Null is the chat. */
export type Page = { kind: 'bot'; botId: string; tab: BotTab } | { kind: 'automations' } | { kind: 'usage' };

interface Streaming { botId: string; roomId: string; text: string }

/** Providers list to fall back to when GET /api/providers 404s (hub not caught up yet) or errors. */
const FALLBACK_PROVIDERS: ProvidersResponse = {
  active: 'claude',
  providers: [
    {
      id: 'claude',
      label: 'Claude',
      blurb: 'Claude. Subscription or API key.',
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
// roomId -> when loadOlder may try again after a failed page fetch.
const olderRetryAt = new Map<string, number>();

/** True when a response body is a full AccountState rather than a bare `{ ok }`. */
function isAccountState(v: unknown): v is AccountState {
  return typeof v === 'object' && v !== null && 'enabled' in v && 'signedIn' in v;
}

/**
 * Below this width the sidebar starts closed, and opening or closing it is not remembered. The saved choice
 * is a desktop preference: closing a drawer on a phone-sized window must not hide the sidebar the next time
 * the app opens full screen. Same width as App's drawer rule, from lib/panes.ts.
 */
export const NARROW_SIDEBAR_QUERY = '(max-width: ' + (SIDEBAR_INLINE_MIN - 1) + 'px)';
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
  /** Stays until dismissed or removed by `key`, instead of fading after a few seconds. Errors always stay. */
  sticky?: boolean;
  /** The user has to act, nothing failed: warning color rather than the error red of `bad`. */
  warn?: boolean;
  /** Lets code remove the toast later (e.g. once an approval is answered). */
  key?: string;
}
export type ToastOptions = Pick<Toast, 'action' | 'sticky' | 'warn' | 'key'>;

/** Why the live connection is down, as far as lib/ws.ts could tell. */
export type HubIssue =
  | { kind: 'unreachable'; detail?: string }
  | { kind: 'rateLimited'; retryInMs: number }
  | { kind: 'auth' }
  | { kind: 'refused' };

/** Toast key for an approval card, so it can be found by room (on opening it) or by approval (once answered). */
/** The `filesRev` entry for one folder of one room. A room id holds no ':', so the key is unambiguous. */
export const filesRevKey = (roomId: string, folder: string) => roomId + ':' + folder;
const approvalToastKey =(roomId: string, approvalId: string) => 'approval:' + roomId + ':' + approvalId;

/** The parts of Settings that live outside React: the sound engine and the `dark` class on <html>. */
function applyLocalSettings(s: Settings) {
  setSoundsEnabled(s.sounds);
  applyTheme(s.theme);
  applyFont(s.font);
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
  /** Every card waiting for an answer: from `hello`, then kept current by approval events. */
  openApprovals: OpenApproval[];
  /** The last `computer.state` per bot. */
  computers: Record<string, ComputerStatus>;
  loaded: Record<string, boolean>;
  /** Per room: an older page is being fetched, or the transcript already reaches the room's first message. */
  history: Record<string, { loading: boolean; done: boolean }>;
  streaming: Record<string, Streaming>;
  unread: Record<string, number>;
  /** Each bot's latest message, for the sidebar. */
  previews: Record<string, BotPreview>;
  /** A search result being shown: the words to highlight in its chat, and the message to scroll to. */
  searchTarget: { roomId: string; seq: number; query: string } | null;
  usage: Record<string, UsageTotals>;
  /** P3: bumped on WS `routines.changed`; the Routines tab refetches when it moves. */
  routinesRev: number;
  /** P5: bumped on WS `triggers.changed` / `trigger.fired` / `integrations.changed`; the Triggers section refetches. */
  triggersRev: number;
  memory: Record<string, string>;
  /** The user asked to watch the screen (lib/screenView.ts). Not remembered: a fresh start is always the chat. */
  panelOpen: boolean;
  /** Left sidebar. Remembered per browser so a narrow screen stays narrow. */
  sidebarOpen: boolean;
  /** The widths asked for, per browser. lib/panes.ts works out what fits. */
  paneW: PaneWidths;
  /** The panel takes all the width the chat can spare; `paneW.panel` is what it goes back to. */
  panelExpanded: boolean;
  /** Whose screen the user chose in a group chat. lib/screenView.ts says whose actually shows. */
  panelBotId: string | null;
  /** What the right panel shows while open: the screen, or the room's files (components/files). */
  panelKind: 'screen' | 'files';
  /**
   * Files was opened over a screen the user was watching. That viewer stays mounted, hidden, so its noVNC
   * connection survives a look at the files; it is let go when the panel closes.
   */
  screenParked: boolean;
  /** Where Files should go next: a folder, and a file in it to preview. `seq` makes the same link work twice. */
  filesTarget: { roomId: string; path: string; file?: string; seq: number } | null;
  /** Bumped per `filesRevKey(roomId, folder)` on `files.changed`, so an open folder refetches. */
  filesRev: Record<string, number>;
  page: Page | null;
  dialog: { kind: 'bot'; bot: Bot | null } | { kind: 'room'; room: Room | null } | { kind: 'podium' } | { kind: 'search' } | { kind: 'profile' } | { kind: 'settings'; section?: SectionId } | null;
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
  /**
   * P9: this page is a paired device, so the hub refuses settings, bot/room edits, integrations and approval
   * rules (guard.ts DEVICE_ALLOW). Seeded from which token this browser holds, then set by the hub's `hello`.
   * The one flag the UI reads to hide what a device cannot do.
   */
  device: boolean;
  _playedConnectedSound: boolean;
  // ---- P7 ----
  /** Latest knowledge repo status from the `knowledge.status` event; null until one arrives. */
  knowledge: KnowledgeStatus | null;
  /** Bumped per bot on `voice.updated`, so the Memory tab refetches voice.md and its proposals. */
  voiceRev: Record<string, number>;
  // ---- P2 ----
  /** Who drives each bot's computer, from GET /api/control and `computer.control`. Missing = the bot (agent). */
  control: Record<string, ControlStatus>;
  /** Bumped on `policies.changed`, so the approval rule list refetches. */
  policiesRev: number;
  // ---- P6 ----
  /** Teach recordings per bot, from `recorder.state`. Missing = not recording (or not asked yet). */
  recorder: Record<string, RecorderStatus>;
  /** Bumped on `skills.changed`, so the Skills tab and an open version list refetch. */
  skillsRev: number;
  /** Bumped per bot on `training.changed`, so its Training section refetches. */
  trainingRev: Record<string, number>;

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
  openSearchHit: (roomId: string, seq: number, query: string) => void;
  loadMessages: (roomId: string) => Promise<void>;
  /** Prepends the page just before the oldest loaded message. No-op while one is loading or none are left. */
  loadOlder: (roomId: string) => Promise<void>;
  sendMessage: (text: string) => void;
  decide: (approvalId: string, decision: 'allow' | 'always' | 'deny') => void;
  interrupt: (turnId: string) => void;
  openScreen: (botId?: string | null) => void;
  /** Shows the active room's files in the right panel, optionally at a folder (and previewing a file in it). */
  openFiles: (at?: { path: string; file?: string }) => void;
  openPage: (page: Page) => void;
  closePage: () => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setPaneW: (pane: PaneId, width: number) => void;
  setPaneOpen: (pane: PaneId, open: boolean) => void;
  togglePanelExpanded: () => void;
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
  previews: {},
  searchTarget: null,
  openApprovals: [],
  computers: {},
  loaded: {},
  history: {},
  streaming: {},
  unread: {},
  usage: {},
  routinesRev: 0,
  triggersRev: 0,
  memory: {},
  panelOpen: false,
  sidebarOpen: !matches(NARROW_SIDEBAR_QUERY) && localStorage.getItem('pocketrocket.sidebar') !== '0',
  paneW: readPaneWidths(window.innerWidth),
  panelExpanded: false,
  panelBotId: null,
  panelKind: 'screen',
  screenParked: false,
  filesTarget: null,
  filesRev: {},
  page: null,
  dialog: null,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  providers: null,
  account: SIGNED_OUT,
  helloReceived: false,
  device: isDevice(),
  _playedConnectedSound: false,
  knowledge: null,
  voiceRev: {},
  control: {},
  policiesRev: 0,
  recorder: {},
  skillsRev: 0,
  trainingRev: {},

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
        set({ bots: ev.bots, rooms: ev.rooms, botStates: ev.botStates, loaded: {}, settings, helloReceived: true, device: ev.principal ? ev.principal === 'device' : s.device, openApprovals: ev.openApprovals ?? [] });
        applyLocalSettings(settings);
        watchSystemTheme(() => get().settings.theme);
        void get().fetchProviders();
        void get().fetchAccount();
        // Only decoration: a hub or a paired phone that refuses it just shows each bot's title instead.
        void api.previews().then((previews) => set({ previews })).catch(() => undefined);
        // P2: control states that are not the default (agent); older hubs answer 404, which leaves it empty.
        void api.control.list().then((l) => set({ control: Object.fromEntries(l.map((c) => [c.botId, c])) })).catch(() => undefined);
        const active = s.activeRoomId && ev.rooms.some((r) => r.id === s.activeRoomId) ? s.activeRoomId : (ev.rooms[0]?.id ?? null);
        get().setActiveRoom(active);
        return;
      }
      case 'computer.state':
        set({ computers: { ...s.computers, [ev.status.botId]: ev.status } });
        return;
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
        if (m.roomId !== s.activeRoomId && m.authorType !== 'user' && (m.kind === 'text' || m.kind === 'approval' || m.kind === 'takeover')) unread[m.roomId] = (unread[m.roomId] ?? 0) + 1;
        // a bot text message replaces its in-flight stream buffer for that turn
        const streaming = { ...s.streaming };
        if (m.turnId && m.kind === 'text' && streaming[m.turnId]) streaming[m.turnId] = { ...streaming[m.turnId], text: '' };
        set({ messages: { ...s.messages, [m.roomId]: [...list, m] }, unread, streaming });
        if (m.authorType === 'bot' && m.kind === 'text') {
          if (m.authorId && m.text) set({ previews: { ...get().previews, [m.authorId]: { text: m.text.slice(0, 200), at: m.createdAt } } });
          if (m.turnId) recentReceive.set(m.turnId, Date.now());
          play('receive', { roomActive: m.roomId === s.activeRoomId });
        }
        // P2: a bot asking for the user's hands is as urgent as an approval card.
        if (m.kind === 'takeover') {
          play('approvalRequest');
          if (m.roomId !== s.activeRoomId) {
            const bot = botById(s.bots, m.authorId);
            get().toast((bot?.name ?? 'A bot') + ' needs you on its screen', false, {
              sticky: true, warn: true, key: 'takeover:' + m.id, action: { label: 'Open', run: () => get().setActiveRoom(m.roomId) },
            });
          }
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
        set({ openApprovals: [...s.openApprovals.filter((a) => a.approvalId !== ev.approval.approvalId), { approvalId: ev.approval.approvalId, botId: ev.botId, roomId: ev.roomId }] });
        play('approvalRequest');
        if (ev.roomId === s.activeRoomId) return;
        // Named and clickable, and it stays: a toast that fades after four seconds is easy to miss while a
        // bot sits blocked in a room the user is not looking at.
        const bot = botById(s.bots, ev.botId);
        const room = s.rooms.find((r) => r.id === ev.roomId);
        const who = bot?.name ?? 'A bot';
        const where = room && room.kind === 'group' ? ' in ' + room.name : '';
        get().toast(who + ' needs your approval' + where, false, {
          sticky: true,
          warn: true,
          key: approvalToastKey(ev.roomId, ev.approval.approvalId),
          action: { label: 'Open', run: () => get().setActiveRoom(ev.roomId) },
        });
        return;
      }
      case 'approval.resolved':
        // Answered somewhere (another window, a timeout): the reminder has nothing left to point at.
        set({
          toasts: get().toasts.filter((t) => !t.key?.startsWith('approval:') || !t.key.endsWith(':' + ev.approvalId)),
          openApprovals: s.openApprovals.filter((a) => a.approvalId !== ev.approvalId),
        });
        return;
      case 'memory.updated':
        set({ memory: { ...s.memory, [ev.botId]: ev.text } });
        return;
      case 'usage.updated':
        set({ usage: { ...s.usage, [ev.botId + ':' + ev.roomId]: ev.totals } });
        return;
      // P3
      case 'routines.changed':
      case 'routine.fired':
        set({ routinesRev: s.routinesRev + 1 });
        return;
      case 'error':
        get().toast(ev.message, true);
        return;
      // ---- P7 ----
      case 'knowledge.status':
        set({ knowledge: ev.status });
        return;
      case 'voice.updated':
        set({ voiceRev: { ...s.voiceRev, [ev.botId]: (s.voiceRev[ev.botId] ?? 0) + 1 } });
        return;
      // ---- P5 ----
      case 'triggers.changed':
      case 'trigger.fired':
      case 'integrations.changed':
        set({ triggersRev: s.triggersRev + 1 });
        return;
      // ---- P2 ----
      case 'computer.control': {
        const was = s.control[ev.status.botId]?.takeover?.messageId;
        const toasts = was && !ev.status.takeover ? s.toasts.filter((t) => t.key !== 'takeover:' + was) : s.toasts;
        set({ control: { ...s.control, [ev.status.botId]: ev.status }, toasts });
        return;
      }
      case 'policies.changed':
        set({ policiesRev: s.policiesRev + 1 });
        return;
      // ---- P6 ----
      case 'recorder.state':
        set({ recorder: { ...s.recorder, [ev.status.botId]: ev.status } });
        return;
      case 'skills.changed':
        set({ skillsRev: s.skillsRev + 1 });
        return;
      case 'files.changed': {
        const key = filesRevKey(ev.roomId, ev.path);
        set({ filesRev: { ...s.filesRev, [key]: (s.filesRev[key] ?? 0) + 1 } });
        return;
      }
      case 'training.changed':
        set({ trainingRev: { ...s.trainingRev, [ev.botId]: (s.trainingRev[ev.botId] ?? 0) + 1 } });
        return;
      default:
        return;
    }
  },

  openSearchHit: (roomId, seq, query) => {
    set({ searchTarget: { roomId, seq, query } });
    get().setActiveRoom(roomId);
  },
  setActiveRoom: (id) => {
    if (id) localStorage.setItem('pocketrocket.activeRoom', id);
    const unread = { ...get().unread };
    if (id) delete unread[id];
    // Moving to another chat leaves a page. The same chat again (a reconnect's hello) must not.
    set({ activeRoomId: id, unread, page: id === get().activeRoomId ? get().page : null, searchTarget: get().searchTarget?.roomId === id ? get().searchTarget : null });
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
      // A reload after reconnect keeps older pages already fetched, so only a short newest page proves there is nothing more.
      const done = msgs.length < MESSAGE_PAGE || !!get().history[roomId]?.done;
      set({
        messages: { ...get().messages, [roomId]: merged },
        loaded: { ...get().loaded, [roomId]: true },
        history: { ...get().history, [roomId]: { loading: false, done } },
      });
    } catch (e) {
      get().toast('Failed to load messages: ' + (e as Error).message, true);
    }
  },

  loadOlder: async (roomId) => {
    const list = get().messages[roomId];
    const h = get().history[roomId];
    if (!get().loaded[roomId] || !list?.length || h?.loading || h?.done || Date.now() < (olderRetryAt.get(roomId) ?? 0)) return;
    const setHistory = (v: { loading: boolean; done: boolean }) => set({ history: { ...get().history, [roomId]: v } });
    setHistory({ loading: true, done: false });
    try {
      const older = await api.rooms.messages(roomId, list[0].seq);
      const current = get().messages[roomId] ?? [];
      const ids = new Set(current.map((m) => m.id));
      const merged = [...older.filter((m) => !ids.has(m.id)), ...current].sort((a, b) => a.seq - b.seq);
      set({ messages: { ...get().messages, [roomId]: merged } });
      setHistory({ loading: false, done: older.length < MESSAGE_PAGE });
    } catch (e) {
      setHistory({ loading: false, done: false });
      // Every scroll event near the top asks again, so hold off a few seconds instead of retrying (and toasting) at once.
      olderRetryAt.set(roomId, Date.now() + 5000);
      get().toast("Couldn't load earlier messages: " + (e as Error).message, true);
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
  openScreen: (botId) => set({ panelOpen: true, panelKind: 'screen', screenParked: false, panelBotId: botId === undefined ? get().panelBotId : botId }),
  openFiles: (at) => {
    const s = get();
    const roomId = s.activeRoomId;
    set({
      panelOpen: true,
      panelKind: 'files',
      // Expanded is a screen thing: files at 1200px wide would squeeze the chat for nothing.
      panelExpanded: s.panelKind === 'files' ? s.panelExpanded : false,
      screenParked: s.screenParked || (s.panelOpen && s.panelKind === 'screen'),
      filesTarget: at && roomId ? { roomId, path: at.path, file: at.file, seq: (s.filesTarget?.seq ?? 0) + 1 } : s.filesTarget,
    });
  },
  closePanel: () => set({ panelOpen: false, screenParked: false }),
  openPage: (page) => set({ page }),
  closePage: () => set({ page: null }),
  toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen),
  setSidebarOpen: (open) => {
    if (!matches(NARROW_SIDEBAR_QUERY)) localStorage.setItem('pocketrocket.sidebar', open ? '1' : '0');
    set({ sidebarOpen: open });
  },
  setPaneW: (pane, width) => {
    writePaneWidth(pane, width);
    set((s) => ({ paneW: { ...s.paneW, [pane]: width }, panelExpanded: pane === 'panel' ? false : s.panelExpanded }));
  },
  setPaneOpen: (pane, open) => {
    if (pane === 'sidebar') get().setSidebarOpen(open);
    else if (open) set({ panelOpen: true });
    else get().closePanel();
  },
  togglePanelExpanded: () => set((s) => ({ panelExpanded: !s.panelExpanded })),
  openDialog: (dialog) => set({ dialog }),
  toast: (text, bad, opts) => {
    // Errors now stay until dismissed, so the same one repeating (a retry loop, every send while offline) must not stack.
    if (bad && !opts?.key && get().toasts.some((t) => t.bad && t.text === text)) return;
    // A keyed toast replaces its earlier copy rather than stacking a duplicate.
    const id = ++toastSeq;
    const rest = opts?.key ? get().toasts.filter((t) => t.key !== opts.key) : get().toasts;
    set({ toasts: [...rest, { id, text, bad, ...opts }] });
    // An error has to survive being read, and may hold a reason the user needs: only the user clears it.
    if (!opts?.sticky && !bad) setTimeout(() => get().dismissToast({ id }), 4000);
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
