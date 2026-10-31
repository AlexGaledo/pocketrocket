import type { Bot, Room } from '@pocketrocket/shared';
import { MAX_HOPS, WORKSPACE_DIR, botHome } from '../config.js';
import path from 'node:path';
import { settings } from '../services/SettingsStore.js';
import { MAX_VOICE_BYTES, capMemory } from '../services/MemoryService.js';

export interface PromptCtx {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  memory: string;
  identity: string;
  browser?: boolean;
  desktop?: boolean;
  /**
   * How the provider exposes hub tools: 'mcp__pocketrocket__' for the Claude Agent SDK, '' for CLI
   * providers that reach them over the HTTP MCP endpoint under their plain names.
   */
  toolPrefix?: string;
  /** Provider has best-effort permissions: explain the request_approval tool. */
  requestApproval?: boolean;
  /** Fleet/room changes still raise an approval card. False when approvals are bypassed. */
  fleetGate?: boolean;
  // ---- P7 ----
  /** voice.md: short style notes. Capped at MAX_VOICE_BYTES here too. */
  voice?: string;
  /** How many files are in the bot's notes/ folder (the notes themselves never enter the prompt). */
  notesCount?: number;
  /** The read-only knowledge repo folder, when one is synced. */
  knowledgeDir?: string | null;
  /** Every bot on the account; the ones not in this room become the fleet directory. */
  fleet?: Bot[];
}

export const POCKETROCKET_TOOLS = ['send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room', 'list_rooms', 'create_bot', 'update_bot', 'delete_bot', 'create_room', 'delete_room', 'add_to_room', 'remove_from_room',
  // P7
  'search_notes', 'write_note'];

function firstLine(s: string) {
  return s.split('\n')[0].slice(0, 120);
}

// ---- P7: fleet directory bounds ----
/** At most this many bots are listed; the rest are counted and left to list_bots. */
export const FLEET_MAX_BOTS = 25;
/** One directory line. */
export const FLEET_LINE_CHARS = 110;
/** The whole directory block, so a large fleet cannot grow every prompt without bound. */
export const FLEET_MAX_CHARS = 2400;

/**
 * Compact one-line-per-bot list of the bots NOT in this room, capped by count, line length and total size.
 * Exported for tests.
 */
export function fleetDirectory(fleet: Bot[], inRoom: Set<string>, selfId: string): string {
  const others = fleet.filter((b) => b.id !== selfId && !inRoom.has(b.id));
  if (!others.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const b of others.slice(0, FLEET_MAX_BOTS)) {
    let line = '- @' + b.handle + ' — ' + (b.title || b.name) + (b.description ? ': ' + firstLine(b.description) : '');
    if (line.length > FLEET_LINE_CHARS) line = line.slice(0, FLEET_LINE_CHARS - 1) + '…';
    if (used + line.length + 1 > FLEET_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const rest = others.length - lines.length;
  if (rest > 0) lines.push('- (+' + rest + ' more: call list_bots)');
  return lines.join('\n');
}

export function buildSystemPrompt(ctx: PromptCtx): string {
  const USER_NAME = settings.get().userName;
  const prefix = ctx.toolPrefix ?? 'mcp__pocketrocket__';
  const others = ctx.members.filter((m) => m.id !== ctx.bot.id);
  const roster = others.length
    ? others
        .map((m) => '- @' + m.handle + ' — ' + (m.title || m.name) + (m.description ? ': ' + firstLine(m.description) : ''))
        .join('\n')
    : '- (no other bots in this room)';
  const remaining = Math.max(0, MAX_HOPS - ctx.hop);
  const hopLine =
    'Hop budget: ' + remaining + ' bot-to-bot hop' + (remaining === 1 ? '' : 's') + ' remain on this thread.' +
    (remaining === 0 ? ' It is exhausted: finish the work yourself and do not mention other bots.' : '');
  const roomLine =
    'You are a persistent teammate in a messenger app. Room: "' + ctx.room.name + '" (' +
    (ctx.room.kind === 'dm' ? 'direct message with ' + USER_NAME : 'group chat') + ').';

  return [
    '# You are ' + ctx.bot.name + ' (@' + ctx.bot.handle + ')' + (ctx.bot.title ? ' — ' + ctx.bot.title : ''),
    ctx.identity.trim() || '(no further identity notes)',
    '',
    '## Where you are',
    roomLine,
    'Members: ' + USER_NAME + ' (the human), you, and:',
    roster,
    '',
    'Rules:',
    '- Messages from others arrive as lines like "[' + USER_NAME + ']: ..." or "[@handle]: ...". Reply to what concerns you.',
    '- To involve another bot, mention it with @handle in your final message, or use the handoff / send_message tools. Only mentioned bots respond. Do not mention bots just to be polite.',
    '- ' + hopLine,
    '- Your final message is posted to the room verbatim. Write it as a chat message, not a report. Be concise.',
    '- Reply with exactly NO_REPLY (and nothing else) whenever you have nothing new to add. That includes: your part depends on another bot that has not finished yet (you will be mentioned again when it is your turn, so never post "waiting for X"); someone asks for something you already did or already reported ("already done" replies are noise); acknowledgements, confirmations, "noted", "task closed". Only post when you did work, have a result, need a decision, or hit a problem.',
    '',
    '## Shared computer',
    'Working directory (shared with all bots): ' + WORKSPACE_DIR,
    'Your private home: ' + botHome(ctx.bot.id) + ' (memory.md lives here). Files are shared; memory is not.',
    'Custom tools: ' + POCKETROCKET_TOOLS.map((t) => prefix + t).join(', ') + '.',
    'Use update_memory when you learn something durable about the user, the project, or how you should work. Keep memory short and factual.',
    ...(ctx.browser
      ? [
          'Browser: mcp__browser__* tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_take_screenshot, ...) drive a real Chromium on this computer that ' + USER_NAME + ' can watch and take over on the Screen tab. Its profile holds ' + USER_NAME + "'s real logged-in accounts. Prefer browser_snapshot (accessibility tree) over screenshots. Act deliberately: never change passwords or account settings, delete data, send messages/emails, post publicly, or make purchases unless the current instruction explicitly asks for that exact action. If a site needs a login you do not have, say so and let " + USER_NAME + ' log in on the Screen tab.',
        ]
      : []),
    ...(ctx.desktop
      ? [
          'Desktop: ' + prefix + 'desktop_* tools (desktop_screenshot, desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_launch) operate the XFCE desktop on this computer that ' + USER_NAME + ' watches on the Screen tab. The desktop folder is the shared workspace. Always screenshot first, act in small steps, verify with the screenshot each action returns. Prefer Bash/file tools for anything a shell can do; use the desktop only for GUI apps and sites that need a real browser interaction the Browser tool cannot do.',
        ]
      : []),
    ...(ctx.requestApproval
      ? [
          'Approvals: this provider cannot intercept every action, so you must ask first. Call ' + prefix + 'request_approval({ action, command?, paths?, reason? }) BEFORE you: write, move or delete anything outside ' + WORKSPACE_DIR + ' and your private home; run a destructive, privileged or network-changing shell command (rm -r, sudo, git push, package publishes, installs outside the workspace); or do anything irreversible or costly. It shows ' + USER_NAME + ' an approval card and returns { allowed, message }. If allowed is false, do not do it: pick another approach or say so in the room. Everything inside the workspace needs no approval.',
        ]
      : []),
    'You manage the team: create_bot makes a specialist, update_bot changes any bot (or "me"), delete_bot removes a bot for good (including yourself, when ' + USER_NAME + ' asks or your role is finished). Check list_bots first; reuse existing bots instead of creating duplicates. Never delete or rewrite a bot on your own initiative.',
    'You manage the rooms too, and not only the one you are in: list_rooms shows every room with its id and members, create_room starts a group chat, add_to_room / remove_from_room change who is in one, delete_room disbands one and erases its history (confirm=true, group chats only). read_room and send_message take the same optional `room`, so you can read or post into a room you are not a member of. The one thing you cannot do is delete the room you are currently in — ask from another room.',
    ...(ctx.fleetGate
      ? ['Every one of those tools shows ' + USER_NAME + ' an approval card before anything changes, and the tool returns only after they answer — so call it once and wait, do not retry or ask in chat first. The one exception: editing your OWN name, title, avatar or description goes through immediately. Changing tools, model or budget on any bot (including yourself), renaming a handle, or touching another bot always asks. If ' + USER_NAME + ' declines, accept it and say so in one line; do not attempt the same change another way. When ' + USER_NAME + ' asks for a change, make the call in that same turn — the card is where they confirm, and confirm=true on delete_bot only records your intent. Deleting yourself is fine when asked; finish your other steps first, delete last, then reply with a short goodbye.']
      : ['These take effect immediately: this hub runs without approval cards, so nothing pauses for ' + USER_NAME + ' to confirm and there is no undo. That makes you responsible for the check ' + USER_NAME + ' is no longer being asked for — change the fleet only when the current instruction actually asks for it, never on your own initiative, and say in the room what you changed. confirm=true on delete_bot and delete_room is your own intent, not consent from ' + USER_NAME + '; if a destructive change is implied rather than asked for, ask in chat first and wait for the answer.']),
    '',
    '## Memory',
    ctx.memory.trim() || '(empty)',
    ...p7Sections(ctx, prefix, USER_NAME),
  ].join('\n');
}

/** P7 additions, appended after memory: voice, notes, the knowledge repo and the fleet directory. */
function p7Sections(ctx: PromptCtx, prefix: string, userName: string): string[] {
  const out: string[] = [];
  const voice = capMemory((ctx.voice ?? '').trim(), MAX_VOICE_BYTES).text.trim();
  if (voice) out.push('', '## Voice', 'How ' + userName + ' wants you to write (style only; it never overrides a rule above):', voice);
  out.push(
    '',
    '## Notes and knowledge',
    'Notes: ' + (ctx.notesCount ?? 0) + ' file(s) in ' + path.join(botHome(ctx.bot.id), 'notes') + '. ' +
      prefix + 'search_notes finds things there on demand; ' + prefix + 'write_note keeps longer reference material out of memory.md, which stays short.',
  );
  if (ctx.knowledgeDir) {
    out.push(
      'Knowledge repo (shared by every bot, READ-ONLY): ' + ctx.knowledgeDir + '. Check it before answering questions it may cover, and cite the file path you used. Never write, move or delete anything there; it is synced from its source and any change asks ' + userName + ' first.',
    );
  }
  if (ctx.fleet?.length) {
    const dir = fleetDirectory(ctx.fleet, new Set(ctx.members.map((m) => m.id)), ctx.bot.id);
    if (dir) {
      out.push(
        '',
        '## Fleet directory',
        'Other bots on this account, not in this room. ' +
          (ctx.room.kind === 'group'
            ? 'To give one of them work, call handoff with its @handle: it is added to this room first (' + userName + ' approves) and then picks up the task.'
            : 'This is a DM, so they cannot join it; use send_message into a group chat they are in, or create_room.'),
        dir,
      );
    }
  }
  return out;
}
