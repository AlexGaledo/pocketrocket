import type { Bot, Room } from '@pocketrocket/shared';
import { MAX_HOPS, USER_NAME, WORKSPACE_DIR, botHome } from '../config.js';

export interface PromptCtx {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  memory: string;
  identity: string;
  browser?: boolean;
  desktop?: boolean;
}

export const POCKETROCKET_TOOLS = ['send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room', 'create_bot', 'update_bot', 'delete_bot', 'add_to_room', 'remove_from_room'];

function firstLine(s: string) {
  return s.split('\n')[0].slice(0, 120);
}

export function buildSystemPrompt(ctx: PromptCtx): string {
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
    'Custom tools: ' + POCKETROCKET_TOOLS.map((t) => 'mcp__pocketrocket__' + t).join(', ') + '.',
    'Use update_memory when you learn something durable about the user, the project, or how you should work. Keep memory short and factual.',
    ...(ctx.browser
      ? [
          'Browser: mcp__browser__* tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_take_screenshot, ...) drive a real Chromium on this computer that ' + USER_NAME + ' can watch and take over on the Screen tab. Its profile holds ' + USER_NAME + "'s real logged-in accounts. Prefer browser_snapshot (accessibility tree) over screenshots. Act deliberately: never change passwords or account settings, delete data, send messages/emails, post publicly, or make purchases unless the current instruction explicitly asks for that exact action. If a site needs a login you do not have, say so and let " + USER_NAME + ' log in on the Screen tab.',
        ]
      : []),
    ...(ctx.desktop
      ? [
          'Desktop: mcp__pocketrocket__desktop_* tools (desktop_screenshot, desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_launch) operate the XFCE desktop on this computer that ' + USER_NAME + ' watches on the Screen tab. The desktop folder is the shared workspace. Always screenshot first, act in small steps, verify with the screenshot each action returns. Prefer Bash/file tools for anything a shell can do; use the desktop only for GUI apps and sites that need a real browser interaction the Browser tool cannot do.',
        ]
      : []),
    'You manage the team: create_bot makes a specialist, update_bot changes any bot (or "me"), delete_bot removes a bot for good (including yourself, when ' + USER_NAME + ' asks or your role is finished), add_to_room / remove_from_room change who is in a group chat. Check list_bots first; reuse existing bots instead of creating duplicates. Never delete or rewrite a bot on your own initiative. When ' + USER_NAME + ' tells you to delete or change a bot, including yourself, do it in that same turn without asking for confirmation: ' + USER_NAME + "'s message is the confirmation, and confirm=true is how you record it. Deleting yourself is fine and expected when asked; finish your other steps first, delete last, then reply with a short goodbye.",
    '',
    '## Memory',
    ctx.memory.trim() || '(empty)',
  ].join('\n');
}
