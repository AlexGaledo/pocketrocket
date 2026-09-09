import { create } from 'zustand';
import type { Bot, BotState, Message, Room, ServerEvent, UsageTotals, Settings, SettingsPatch, ProvidersResponse } from '@pocketrocket/shared';
import { DEFAULT_SETTINGS, MODELS } from '@pocketrocket/shared';
import { api } from './lib/api';
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

interface State {
  connected: boolean;
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
  toasts: { id: number; text: string; bad?: boolean }[];
  settings: Settings;
  providers: ProvidersResponse | null;
  helloReceived: boolean;
  _playedConnectedSound: boolean;

  setConnected: (v: boolean) => void;
  updateSettings: (patch: SettingsPatch) => Promise<void>;
  fetchProviders: () => Promise<void>;
  applyEvent: (ev: ServerEvent) => void;
  setActiveRoom: (id: string | null) => void;
  loadMessages: (roomId: string) => Promise<void>;
  sendMessage: (text: string) => void;
  decide: (approvalId: string, decision: 'allow' | 'always' | 'deny') => void;
  interrupt: (turnId: string) => void;
  openPanel: (tab: PanelTab, botId?: string | null) => void;
  toggleSidebar: () => void;
  closePanel: () => void;
  openDialog: (d: State['dialog']) => void;
  toast: (text: string, bad?: boolean) => void;
  refresh: () => Promise<void>;
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  connected: false,
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
  panelOpen: localStorage.getItem('pocketrocket.panel') !== '0',
  sidebarOpen: localStorage.getItem('pocketrocket.sidebar') !== '0',
  panelTab: 'memory',
  panelBotId: null,
  dialog: null,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  providers: null,
  helloReceived: false,
  _playedConnectedSound: false,

  setConnected: (connected) => {
    const was = get().connected;
    set({ connected });
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
        setSoundsEnabled(settings.sounds);
        applyTheme(settings.theme);
        watchSystemTheme(() => get().settings.theme);
        void get().fetchProviders();
        const active = s.activeRoomId && ev.rooms.some((r) => r.id === s.activeRoomId) ? s.activeRoomId : (ev.rooms[0]?.id ?? null);
        get().setActiveRoom(active);
        return;
      }
      case 'settings.changed': {
        set({ settings: ev.settings });
        setSoundsEnabled(ev.settings.sounds);
        applyTheme(ev.settings.theme);
        return;
      }
      case 'providers.changed': {
        void get().fetchProviders();
        return;
      }
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
      case 'approval.request':
        play('approvalRequest');
        if (ev.roomId !== s.activeRoomId) get().toast('Approval needed in another room', true);
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
    localStorage.setItem('pocketrocket.panel', '1');
    set({ panelOpen: true, panelTab: tab, panelBotId: botId === undefined ? get().panelBotId : botId });
  },
  closePanel: () => {
    localStorage.setItem('pocketrocket.panel', '0');
    set({ panelOpen: false });
  },
  toggleSidebar: () => {
    const open = !get().sidebarOpen;
    localStorage.setItem('pocketrocket.sidebar', open ? '1' : '0');
    set({ sidebarOpen: open });
  },
  openDialog: (dialog) => set({ dialog }),
  toast: (text, bad) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, bad }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 4000);
  },
  refresh: async () => {
    const [bots, rooms] = await Promise.all([api.bots.list(), api.rooms.list()]);
    set({ bots, rooms });
  },

  updateSettings: async (patch) => {
    const prev = get().settings;
    const next = { ...prev, ...patch };
    set({ settings: next });
    setSoundsEnabled(next.sounds);
    if (patch.theme) applyTheme(next.theme);
    try {
      const saved = await api.settings.update(patch);
      set({ settings: saved });
      setSoundsEnabled(saved.sounds);
      applyTheme(saved.theme);
    } catch (e) {
      // Hub may not have the settings endpoint yet (parallel work-in-progress) — keep the
      // optimistic value locally rather than bouncing the UI back, but let the user know.
      console.warn('settings update did not persist:', (e as Error).message);
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
}));

export const selectActiveRoom = (s: State) => s.rooms.find((r) => r.id === s.activeRoomId) ?? null;
export const botById = (bots: Bot[], id: string | null | undefined) => (id ? bots.find((b) => b.id === id) : undefined);
