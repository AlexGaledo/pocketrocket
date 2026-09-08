import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { Bot, Room, HandoffPayload } from '@claudebot/shared';
import { USER_NAME } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import { events } from '../events.js';
import { parseMentions } from '../rooms/mentions.js';
import { desktopTools } from './desktopTools.js';

export interface ToolCtx {
  bot: Bot;
  room: Room;
  members: Bot[];
  turnId: string;
  hop: number;
  causeId: string;
  repos: Repos;
  memory: MemoryService;
  skills: SkillService;
  /** Route a bot-authored message to target bots (hop+1). Returns handles actually dispatched. */
  dispatchFromBot: (targets: Bot[]) => string[];
  setState: (s: 'waiting' | 'working') => void;
  /** Attach desktop (computer-use) tools for this turn. */
  desktop?: boolean;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export function createBotToolServer(ctx: ToolCtx) {
  const others = () => ctx.members.filter((m) => m.id !== ctx.bot.id);
  const findBot = (ref: string) => {
    const r = ref.replace(/^@/, '').toLowerCase();
    return others().find((b) => b.handle.toLowerCase() === r || b.name.toLowerCase() === r);
  };
  const post = (kind: 'text' | 'handoff', body: string, payload: HandoffPayload | null) => {
    const msg = ctx.repos.insertMessage({
      roomId: ctx.room.id, authorType: 'bot', authorId: ctx.bot.id, kind, text: body, payload,
      causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId,
    });
    events.emitEvent({ type: 'message.new', message: msg });
    return msg;
  };

  const sendMessage = tool(
    'send_message',
    'Post a message to the current room immediately, before your turn ends. Use @handle inside the text to mention bots; mentioned bots will respond.',
    { text: z.string().min(1).describe('Message text. May contain @handle mentions.') },
    async (a) => {
      const msg = post('text', a.text, null);
      const dispatched = ctx.dispatchFromBot(parseMentions(a.text, ctx.members, ctx.bot.id));
      return text(JSON.stringify({ posted: true, seq: msg.seq, dispatched }));
    },
  );

  const handoff = tool(
    'handoff',
    'Hand a task to another bot in this room. It picks the task up with room context. Use for delegation; you do not need to wait for it.',
    {
      to_bot: z.string().describe('@handle or name of the bot'),
      task: z.string().min(1).describe('What the bot should do'),
      context: z.string().optional().describe('Extra context: file paths, decisions, constraints'),
    },
    async (a) => {
      const target = findBot(a.to_bot);
      if (!target) {
        return err('Unknown bot "' + a.to_bot + '". Members: ' + (others().map((b) => '@' + b.handle).join(', ') || 'none'));
      }
      const payload: HandoffPayload = { fromBotId: ctx.bot.id, toBotId: target.id, task: a.task, context: a.context };
      const body = '@' + target.handle + ' handoff from @' + ctx.bot.handle + ': ' + a.task + (a.context ? '\n\nContext: ' + a.context : '');
      post('handoff', body, payload);
      ctx.setState('waiting');
      const dispatched = ctx.dispatchFromBot([target]);
      ctx.setState('working');
      return dispatched.length
        ? text('Handed off to @' + target.handle + '. They will respond in the room.')
        : err('Could not dispatch: hop budget exhausted. Finish the task yourself.');
    },
  );

  const updateMemory = tool(
    'update_memory',
    'Update your persistent memory.md (private to you, survives across rooms and restarts). Keep it short and factual.',
    {
      mode: z.enum(['replace', 'append', 'patch']).describe('replace: overwrite all. append: add lines. patch: replace `find` with `text`.'),
      text: z.string().describe('New content (or replacement text for patch)'),
      find: z.string().optional().describe('Text to find (patch mode only)'),
    },
    async (a) => {
      if (a.mode === 'replace') ctx.memory.write(ctx.bot.id, a.text);
      else if (a.mode === 'append') ctx.memory.append(ctx.bot.id, a.text);
      else {
        if (!a.find) return err('patch mode needs `find`');
        if (!ctx.memory.patch(ctx.bot.id, a.find, a.text)) return err('`find` text not present in memory');
      }
      return text('Memory updated.');
    },
  );

  const readMemory = tool('read_memory', 'Read your current memory.md.', {}, async () => text(ctx.memory.read(ctx.bot.id) || '(empty)'), {
    annotations: { readOnlyHint: true },
  });

  const saveSkill = tool(
    'save_skill',
    'Save a reusable workflow you just performed as a SKILL.md in the shared skill pool. The user reviews it before it becomes active.',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/).describe('kebab-case name'),
      description: z.string().min(5).max(300).describe('When to use this skill'),
      markdown: z.string().min(20).describe('Step-by-step instructions, decision rules, output format'),
    },
    async (a) => {
      try {
        const s = ctx.skills.save(a.name, a.description, a.markdown, { source: 'bot', createdByBot: ctx.bot.id });
        return text('Saved skill "' + s.name + '" (pending review by ' + USER_NAME + ').');
      } catch (e) {
        return err(String((e as Error).message));
      }
    },
  );

  const listBots = tool(
    'list_bots',
    'List the bots in this room with their roles.',
    {},
    async () => {
      const inRoom = new Set(ctx.members.map((b) => b.id));
      const line = (b: Bot) => '@' + b.handle + ' — ' + b.name + (b.title ? ' — ' + b.title : '') + (b.id === ctx.bot.id ? ' (you)' : '') + (b.description ? '\n  ' + b.description.split('\n')[0].slice(0, 160) : '');
      const others = ctx.repos.listBots().filter((b) => !inRoom.has(b.id));
      return text(
        'In this room:\n' + (ctx.members.map(line).join('\n') || '(none)') +
        (others.length ? '\n\nOther bots on this account (use add_to_room to bring one in):\n' + others.map(line).join('\n') : '\n\nNo other bots exist yet; create_bot can make one.'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const readRoom = tool(
    'read_room',
    'Read recent messages in the current room (oldest first).',
    { limit: z.number().int().min(1).max(200).optional().describe("Default 30") },
    async (a) => {
      const msgs = ctx.repos
        .listMessages(ctx.room.id, { limit: a.limit ?? 30 })
        .filter((m) => m.kind === 'text' || m.kind === 'handoff' || m.kind === 'routine');
      const who = (m: { authorType: string; authorId: string | null }) =>
        m.authorType === 'user'
          ? USER_NAME
          : m.authorType === 'system'
            ? 'system'
            : '@' + (ctx.members.find((b) => b.id === m.authorId)?.handle ?? ctx.repos.getBot(m.authorId ?? '')?.handle ?? 'bot');
      return text(msgs.map((m) => '#' + m.seq + ' [' + who(m) + ']: ' + m.text).join('\n') || '(no messages)');
    },
    { annotations: { readOnlyHint: true } },
  );

  const createBot = tool(
    'create_bot',
    'Create a new specialist bot (a persistent teammate with its own memory). In a group chat it joins this room and can be @mentioned right away. Use when the room lacks a needed role.',
    {
      name: z.string().min(1).max(40).describe('Display name, e.g. "Data Analyst"'),
      handle: z.string().regex(/^[a-z0-9_-]{2,24}$/).describe('Mention handle, lowercase, e.g. "analyst"'),
      title: z.string().max(80).describe('One-line role title'),
      description: z.string().min(10).max(4000).describe('Role instructions: responsibilities, how to work, what to avoid. Becomes the bot identity.'),
      avatar: z.string().max(8).optional().describe('Single emoji (default 🤖)'),
      tools: z.array(z.enum(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'])).optional().describe('Default: all of them'),
      join_this_room: z.boolean().optional().describe('Add the bot to the current room (group chats only). Default true'),
      model: z.enum(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']).optional().describe('Model for the new bot. Default: same as yours. Haiku = cheapest/fastest, Opus = strongest.'),
    },
    async (a) => {
      if (ctx.repos.listBots().length >= 50) return err('Bot limit reached (50).');
      if (ctx.repos.getBotByHandle(a.handle)) return err('Handle @' + a.handle + ' already exists. Use add_to_room to bring an existing bot in, or pick another handle.');
      const bot = ctx.repos.createBot({ name: a.name, handle: a.handle, title: a.title, description: a.description, avatar: a.avatar ?? '🤖', model: a.model ?? ctx.bot.model, allowedTools: a.tools ?? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'], maxBudgetUsd: ctx.bot.maxBudgetUsd });
      ctx.memory.ensureHome(bot.id);
      ctx.memory.writeIdentity(bot.id, a.description);
      events.emitEvent({ type: 'bots.changed', bots: ctx.repos.listBots() });
      let joined = false;
      if ((a.join_this_room ?? true) && ctx.room.kind === 'group') {
        const room = ctx.repos.getRoom(ctx.room.id);
        if (room && room.memberIds.length < 6) {
          ctx.repos.updateRoom(room.id, { memberIds: [...room.memberIds, bot.id] });
          ctx.members.push(bot);
          joined = true;
          events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
        }
      }
      const note = ctx.repos.insertMessage({ roomId: ctx.room.id, authorType: 'system', authorId: null, kind: 'system', text: '@' + ctx.bot.handle + ' created bot ' + bot.avatar + ' ' + bot.name + ' (@' + bot.handle + ')' + (joined ? ' and added it to this room.' : '.'), payload: null, causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId });
      events.emitEvent({ type: 'message.new', message: note });
      return text('Created @' + bot.handle + ' (' + bot.name + ').' + (joined ? ' It is in this room; mention @' + bot.handle + ' to give it work.' : ctx.room.kind === 'group' ? ' Room is full (6), not added.' : ' This is a DM, so it was not added here; ' + USER_NAME + ' can open a DM or add it to a group chat.'));
    },
  );

  const addToRoom = tool(
    'add_to_room',
    'Add an existing bot (by @handle) to the current group chat so it can be mentioned here.',
    { handle: z.string().describe('@handle of an existing bot') },
    async (a) => {
      if (ctx.room.kind !== 'group') return err('Only group chats have members to add.');
      const b = ctx.repos.getBotByHandle(a.handle.replace(/^@/, '').toLowerCase());
      if (!b) return err('No bot with handle ' + a.handle + '. Existing: ' + ctx.repos.listBots().map((x) => '@' + x.handle).join(', '));
      const room = ctx.repos.getRoom(ctx.room.id)!;
      if (room.memberIds.includes(b.id)) return text('@' + b.handle + ' is already in this room.');
      if (room.memberIds.length >= 6) return err('Room is full (6 bots).');
      ctx.repos.updateRoom(room.id, { memberIds: [...room.memberIds, b.id] });
      ctx.members.push(b);
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      const note = ctx.repos.insertMessage({ roomId: ctx.room.id, authorType: 'system', authorId: null, kind: 'system', text: '@' + ctx.bot.handle + ' added ' + b.avatar + ' ' + b.name + ' (@' + b.handle + ') to this room.', payload: null, causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId });
      events.emitEvent({ type: 'message.new', message: note });
      return text('Added @' + b.handle + '. Mention it to give it work.');
    },
  );

  const TOOL_ENUM = z.enum(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Browser', 'Desktop']);
  const resolveAny = (ref: string) => {
    const r = ref.replace(/^@/, '').toLowerCase();
    return r === 'me' || r === 'self' || r === ctx.bot.handle.toLowerCase()
      ? ctx.repos.getBot(ctx.bot.id)
      : ctx.repos.getBotByHandle(r) ?? ctx.repos.listBots().find((b) => b.name.toLowerCase() === r);
  };
  const sysNote = (body: string) => {
    const note = ctx.repos.insertMessage({ roomId: ctx.room.id, authorType: 'system', authorId: null, kind: 'system', text: body, payload: null, causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId });
    events.emitEvent({ type: 'message.new', message: note });
  };

  const updateBot = tool(
    'update_bot',
    'Change an existing bot (any bot, including yourself: use "me"). Only the fields you pass change. Description replaces the identity instructions.',
    {
      bot: z.string().describe('@handle, name, or "me"'),
      name: z.string().min(1).max(40).optional(),
      handle: z.string().regex(/^[a-z0-9_-]{2,24}$/).optional().describe('New mention handle (must be unused)'),
      title: z.string().max(80).optional(),
      description: z.string().min(10).max(4000).optional().describe('New role instructions (full replacement)'),
      avatar: z.string().max(8).optional(),
      model: z.enum(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']).optional(),
      tools: z.array(TOOL_ENUM).optional().describe('Full replacement of the allowed tool list'),
      max_budget_usd: z.number().min(0.05).max(50).optional().describe('Budget per turn'),
    },
    async (a) => {
      const target = resolveAny(a.bot);
      if (!target) return err('No bot "' + a.bot + '". Existing: ' + ctx.repos.listBots().map((x) => '@' + x.handle).join(', '));
      if (a.handle && a.handle !== target.handle && ctx.repos.getBotByHandle(a.handle)) return err('Handle @' + a.handle + ' is taken.');
      const patch: Partial<Bot> = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.handle !== undefined) patch.handle = a.handle;
      if (a.title !== undefined) patch.title = a.title;
      if (a.description !== undefined) patch.description = a.description;
      if (a.avatar !== undefined) patch.avatar = a.avatar;
      if (a.model !== undefined) patch.model = a.model;
      if (a.tools !== undefined) patch.allowedTools = a.tools;
      if (a.max_budget_usd !== undefined) patch.maxBudgetUsd = a.max_budget_usd;
      if (!Object.keys(patch).length) return err('Nothing to change: pass at least one field.');
      const updated = ctx.repos.updateBot(target.id, patch)!;
      if (a.description !== undefined) ctx.memory.writeIdentity(updated.id, a.description);
      const i = ctx.members.findIndex((m) => m.id === updated.id);
      if (i >= 0) ctx.members[i] = updated;
      events.emitEvent({ type: 'bots.changed', bots: ctx.repos.listBots() });
      sysNote('@' + ctx.bot.handle + ' updated ' + updated.avatar + ' ' + updated.name + ' (@' + updated.handle + '): ' + Object.keys(patch).join(', ') + '.');
      return text('Updated @' + updated.handle + ' (' + Object.keys(patch).join(', ') + ').' + (target.id === ctx.bot.id ? ' Changes to your own identity/tools apply from your next turn.' : ''));
    },
  );

  const deleteBot = tool(
    'delete_bot',
    'Permanently delete a bot (any bot, including yourself: use "me"). Removes it from all rooms and deletes its memory. Chat history stays. Requires confirm=true.',
    {
      bot: z.string().describe('@handle, name, or "me"'),
      confirm: z.boolean().describe('Must be true. Deletion cannot be undone.'),
      reason: z.string().max(300).optional().describe('Short reason, shown in the room'),
    },
    async (a) => {
      if (!a.confirm) return err('Not deleted: pass confirm=true to delete.');
      const target = resolveAny(a.bot);
      if (!target) return err('No bot "' + a.bot + '".');
      const self = target.id === ctx.bot.id;
      ctx.repos.deleteBot(target.id);
      try { const fs = await import('node:fs'); const { botHome } = await import('../config.js'); fs.rmSync(botHome(target.id), { recursive: true, force: true }); } catch { /* ignore */ }
      const idx = ctx.members.findIndex((m) => m.id === target.id);
      if (idx >= 0) ctx.members.splice(idx, 1);
      events.emitEvent({ type: 'bots.changed', bots: ctx.repos.listBots() });
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      sysNote((self ? '@' + ctx.bot.handle + ' deleted itself' : '@' + ctx.bot.handle + ' deleted ' + target.avatar + ' ' + target.name + ' (@' + target.handle + ')') + (a.reason ? ': ' + a.reason : '.'));
      return text(self
        ? 'You are deleted. Say goodbye in one line; you will not run again after this turn.'
        : 'Deleted @' + target.handle + '. It is gone from every room; its memory is erased.');
    },
  );

  const removeFromRoom = tool(
    'remove_from_room',
    'Remove a bot (or yourself: "me") from the current group chat. The bot keeps existing and can be added back.',
    { bot: z.string().describe('@handle, name, or "me"') },
    async (a) => {
      if (ctx.room.kind !== 'group') return err('Only group chats have members to remove.');
      const target = resolveAny(a.bot);
      if (!target) return err('No bot "' + a.bot + '".');
      const room = ctx.repos.getRoom(ctx.room.id)!;
      if (!room.memberIds.includes(target.id)) return text('@' + target.handle + ' is not in this room.');
      ctx.repos.updateRoom(room.id, { memberIds: room.memberIds.filter((id) => id !== target.id), coordinatorBotId: room.coordinatorBotId === target.id ? null : undefined });
      const idx = ctx.members.findIndex((m) => m.id === target.id);
      if (idx >= 0) ctx.members.splice(idx, 1);
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      sysNote('@' + ctx.bot.handle + ' removed ' + target.avatar + ' ' + target.name + ' (@' + target.handle + ') from this room.');
      return text('Removed @' + target.handle + ' from this room.');
    },
  );

  // alwaysLoad: keep these schemas in the prompt so bots don't spend a ToolSearch roundtrip every turn.
  const tools: Parameters<typeof createSdkMcpServer>[0]['tools'] = [sendMessage, handoff, updateMemory, readMemory, saveSkill, listBots, readRoom, createBot, addToRoom, updateBot, deleteBot, removeFromRoom];
  if (ctx.desktop) tools!.push(...desktopTools());
  return createSdkMcpServer({ name: 'claudebot', version: '0.1.0', alwaysLoad: true, tools });
}
