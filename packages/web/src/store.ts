import { create } from 'zustand';
import type { Bot, BotState, Message, Room, ServerEvent, UsageTotals } from '@pocketrocket/shared';
import { api } from './lib/api';
import { wsSend } from './lib/ws';

export type PanelTab = 'screen' | 'memory' | 'skills' | 'routines' | 'usage';

interface Streaming { botId: string; roomId: string; text: string }

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
  panelTab: PanelTab;
  panelBotId: string | null;
  dialog: { kind: 'bot'; bot: Bot | null } | { kind: 'room'; room: Room | null } | null;
  toasts: { id: number; text: string; bad?: boolean }[];

  setConnected: (v: boolean) => void;
  applyEvent: (ev: ServerEvent) => void;
  setActiveRoom: (id: string | null) => void;
  loadMessages: (roomId: string) => Promise<void>;
  sendMessage: (text: string) => void;
  decide: (approvalId: string, decision: 'allow' | 'always' | 'deny') => void;
  interrupt: (turnId: string) => void;
  openPanel: (tab: PanelTab, botId?: string | null) => void;
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
  panelTab: 'memory',
  panelBotId: null,
  dialog: null,
  toasts: [],

  setConnected: (connected) => set({ connected }),

  applyEvent: (ev) => {
    const s = get();
    switch (ev.type) {
      case 'hello': {
        set({ bots: ev.bots, rooms: ev.rooms, botStates: ev.botStates, loaded: {} });
        const active = s.activeRoomId && ev.rooms.some((r) => r.id === s.activeRoomId) ? s.activeRoomId : (ev.rooms[0]?.id ?? null);
        get().setActiveRoom(active);
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
        return;
      }
      case 'bot.state':
        set({ botStates: { ...s.botStates, [ev.botId]: ev.state } });
        return;
      case 'approval.request':
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
    if (!wsSend({ type: 'message.send', roomId, text })) get().toast('Not connected', true);
  },
  decide: (approvalId, decision) => {
    wsSend({ type: 'approval.decide', approvalId, decision });
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
}));

export const selectActiveRoom = (s: State) => s.rooms.find((r) => r.id === s.activeRoomId) ?? null;
export const botById = (bots: Bot[], id: string | null | undefined) => (id ? bots.find((b) => b.id === id) : undefined);
