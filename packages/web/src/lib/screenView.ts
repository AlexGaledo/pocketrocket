/**
 * Which bot's screen shows, and how big. Nobody picks a size: it follows what the user is doing.
 *
 *   glance  a small thumbnail over the chat while the bot is using its computer; nothing when it is not
 *   watch   split beside the chat, after the user asks to see the screen
 *   focus   full pane, while this browser has control
 *
 * The screen follows the chat. The one exception is a screen this browser holds, which stays up whatever chat is
 * open, because leaving it would strand a bot that cannot act until it gets its screen back. RightPanel warns then.
 */
import type { Bot, BotState, ControlStatus, Message, Room, ToolPayload } from '@pocketrocket/shared';

export type ScreenSize = 'glance' | 'watch' | 'focus';

/** This browser's id, sent as the control `holder` so the hub can say who took over. Not a secret. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem('prcrew.deviceId');
    if (!id) {
      id = 'web-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('prcrew.deviceId', id);
    }
    return id;
  } catch {
    return 'web';
  }
}

/**
 * True when control was taken from this browser. A bot's `request_takeover` also sets `user`, but with no holder,
 * and that must not throw the screen over whatever the user is doing: it stays a card until they say so. The
 * recorder is its own holder and the Done button is on the screen, so a recording counts.
 */
export function holdsScreen(c: ControlStatus | undefined): boolean {
  return c?.control === 'user' && (c.holder === 'recorder' || c.holder === deviceId());
}

export const hasComputer = (b: Bot | undefined) => !!b && (b.allowedTools.includes('Browser') || b.allowedTools.includes('Desktop'));

export const isComputerTool = (name: string) => name.startsWith('mcp__browser__') || name.startsWith('mcp__pocketrocket__desktop_');

export interface ScreenState {
  bots: Bot[];
  rooms: Room[];
  activeRoomId: string | null;
  panelBotId: string | null;
  panelOpen: boolean;
  control: Record<string, ControlStatus>;
  botStates: Record<string, BotState>;
  messages: Record<string, Message[]>;
  streaming: Record<string, unknown>;
}

const BUSY: readonly BotState[] = ['thinking', 'working', 'blocked', 'waiting'];

function hostOf(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url.includes('://') ? url : 'https://' + url).hostname;
  } catch {
    return '';
  }
}

/**
 * The thumbnail's caption while the bot's current turn in this chat is using its computer, else null. Null also
 * lets the computer go: no thumbnail means no viewer holding it awake.
 */
export function computerUse(botId: string, s: ScreenState): string | null {
  if (s.control[botId]?.takeover) return 'Waiting for you';
  const st = s.botStates[botId];
  const list = s.activeRoomId ? s.messages[s.activeRoomId] : undefined;
  if (!st || !BUSY.includes(st) || !list) return null;
  let turn: string | null | undefined;
  let open = false;
  let used = false;
  let site = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.authorId !== botId || m.kind !== 'tool') continue;
    const p = m.payload as ToolPayload;
    if (turn === undefined) {
      turn = m.turnId;
      open = !p.done;
    } else if (m.turnId !== turn) break;
    if (isComputerTool(p.name)) {
      used = true;
      site ||= hostOf((p.input as { url?: unknown } | null)?.url);
    }
  }
  if (!used || !(open || (turn && s.streaming[turn]))) return null;
  return site ? 'Browsing ' + site : 'Using its screen';
}

export function selectScreenBotId(s: ScreenState): string | null {
  const held = s.bots.filter((b) => holdsScreen(s.control[b.id]));
  if (held.length) return (held.find((b) => b.id === s.panelBotId) ?? held[0]).id;
  const room = s.rooms.find((r) => r.id === s.activeRoomId);
  if (!room) return s.panelBotId ?? s.bots[0]?.id ?? null;
  const picked = s.panelBotId && room.memberIds.includes(s.panelBotId) ? s.panelBotId : room.memberIds[0] ?? null;
  // A thumbnail in a group chat is for whoever is at their computer. A split stays on the one the user chose.
  if (room.kind === 'group' && !s.panelOpen && !(picked && computerUse(picked, s))) {
    return room.memberIds.find((id) => computerUse(id, s)) ?? picked;
  }
  return picked;
}

export function selectScreenSize(s: ScreenState): ScreenSize {
  const id = selectScreenBotId(s);
  if (id && holdsScreen(s.control[id])) return 'focus';
  return s.panelOpen ? 'watch' : 'glance';
}
