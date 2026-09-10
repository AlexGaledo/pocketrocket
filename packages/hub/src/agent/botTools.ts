import { z } from 'zod';
import type { Bot, Room, HandoffPayload } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import type { MemoryService } from '../services/MemoryService.js';
import { MAX_MEMORY_BYTES } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import { settings } from '../services/SettingsStore.js';
import { events } from '../events.js';
import { parseMentions } from '../rooms/mentions.js';
import { desktopTools } from './desktopTools.js';
import type { HubTool, ToolOutput } from '../providers/types.js';

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
  /**
   * Route a bot-authored message to target bots (hop+1). Returns handles actually dispatched.
   * `room` defaults to the room the turn is running in; pass another to wake bots in that room instead.
   */
  dispatchFromBot: (targets: Bot[], room?: Room) => string[];
  setState: (s: 'waiting' | 'working') => void;
  /** Attach desktop (computer-use) tools for this turn. */
  desktop?: boolean;
  /** Model ids the active provider offers; create_bot/update_bot validate against it. */
  models: string[];
  /**
   * Ask the user for approval through the PermissionBroker. Present only for providers whose permission
   * parity is 'best-effort' (everything but Claude); adds the `request_approval` tool.
   */
  requestApproval?: (a: { action: string; command?: string; paths?: string[]; reason?: string }) => Promise<{ allowed: boolean; message: string; approvalId?: string }>;
  /**
   * Approval card for a fleet change (create/update/delete a bot, create/delete a room, add/remove a
   * member). Wired by BotRunner for every provider; when absent (unit tests, or POCKETROCKET_BYPASS_PERMISSIONS)
   * the change goes through unguarded. See audit 2026-09-09, B6/B14.
   */
  confirmFleetChange?: (a: { tool: string; reason: string; input: Record<string, unknown> }) => Promise<{ allowed: boolean; message: string }>;
}

export const text = (t: string): ToolOutput => ({ content: [{ type: 'text' as const, text: t }] });
export const err = (t: string): ToolOutput => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** Build a provider-agnostic HubTool from a zod shape; the handler sees parsed, typed args. */
export function hubTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (a: z.infer<z.ZodObject<S>>) => Promise<ToolOutput>,
  opts?: { readOnly?: boolean },
): HubTool {
  const schema = z.object(shape);
  return {
    name,
    description,
    inputSchema: schema as unknown as z.ZodObject<z.ZodRawShape>,
    readOnly: opts?.readOnly,
    handler: async (input) => {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) return err('Invalid arguments: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '));
      return handler(parsed.data as z.infer<z.ZodObject<S>>);
    },
  };
}

/**
 * The hub's own tools, independent of any provider SDK. `providers/claude.ts` wraps them with the Agent
 * SDK's `tool()`; CLI providers call the same handlers over the HTTP MCP endpoint.
 */
export function createHubTools(ctx: ToolCtx): HubTool[] {
  const userName = settings.get().userName;
  const others = () => ctx.members.filter((m) => m.id !== ctx.bot.id);
  const findBot = (ref: string) => {
    const r = ref.replace(/^@/, '').toLowerCase();
    return others().find((b) => b.handle.toLowerCase() === r || b.name.toLowerCase() === r);
  };
  const post = (kind: 'text' | 'handoff', body: string, payload: HandoffPayload | null, room: Room = ctx.room) => {
    const msg = ctx.repos.insertMessage({
      roomId: room.id, authorType: 'bot', authorId: ctx.bot.id, kind, text: body, payload,
      causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId,
    });
    events.emitEvent({ type: 'message.new', message: msg });
    return msg;
  };
  const roomMembers = (room: Room) =>
    room.memberIds.map((id) => ctx.repos.getBot(id)).filter((b): b is Bot => !!b);
  /**
   * Resolve a room reference to that room and its live members. Every room tool takes an optional `room`
   * and defaults to the one the turn is running in, so a bot can manage a room it is not a member of --
   * before this, a bot that created a room could never touch it again.
   */
  type RoomRef = { ok: true; room: Room; members: Bot[] } | { ok: false; out: ToolOutput };
  const resolveRoom = (ref?: string): RoomRef => {
    if (!ref || !ref.trim()) {
      return { ok: true, room: ctx.repos.getRoom(ctx.room.id) ?? ctx.room, members: ctx.members };
    }
    const raw = ref.trim();
    const wanted = raw.replace(/^[#@]/, '').toLowerCase();
    const all = ctx.repos.listRooms();
    const byId = all.find((x) => x.id === raw);
    const hits = byId ? [byId] : all.filter((x) => x.name.toLowerCase() === wanted);
    if (!hits.length) {
      return { ok: false, out: err('No room "' + raw + '". Call list_rooms to see the rooms and their ids.') };
    }
    if (hits.length > 1) {
      return { ok: false, out: err('More than one room is named "' + raw + '"; pass an id instead. Matching ids: ' + hits.map((x) => x.id).join(', ')) };
    }
    return { ok: true, room: hits[0], members: roomMembers(hits[0]) };
  };
  const ROOM_ARG = z.string().optional().describe('Room name or id. Omit for the room you are in.');
  /**
   * Gate for anything that changes the fleet. Returns null when the user approved (or no gate is wired),
   * or the ToolOutput to hand straight back to the bot when they declined. Called BEFORE any mutation.
   */
  const gate = async (tool: string, reason: string, input: Record<string, unknown>): Promise<ToolOutput | null> => {
    if (!ctx.confirmFleetChange) return null;
    const r = await ctx.confirmFleetChange({ tool, reason, input });
    return r.allowed ? null : err(r.message);
  };
  const modelHint = ctx.models.length ? ' One of: ' + ctx.models.join(', ') + '.' : '';
  const checkModel = (m: string | undefined) =>
    !m || !ctx.models.length || ctx.models.includes(m)
      ? null
      : err('Unknown model "' + m + '" for the active provider. Available: ' + ctx.models.join(', ') + '.');

  const sendMessage = hubTool(
    'send_message',
    'Post a message immediately, before your turn ends. Use @handle inside the text to mention bots; mentioned bots will respond. Defaults to the room you are in; pass `room` to post into another room (you do not have to be a member of it).',
    { text: z.string().min(1).describe('Message text. May contain @handle mentions.'), room: ROOM_ARG },
    async (a) => {
      const r = resolveRoom(a.room);
      if (!r.ok) return r.out;
      const msg = post('text', a.text, null, r.room);
      const dispatched = ctx.dispatchFromBot(parseMentions(a.text, r.members, ctx.bot.id), r.room);
      return text(JSON.stringify({ posted: true, room: r.room.name, seq: msg.seq, dispatched }));
    },
  );

  const handoff = hubTool(
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

  const updateMemory = hubTool(
    'update_memory',
    'Update your persistent memory.md (private to you, survives across rooms and restarts). Keep it short and factual.',
    {
      mode: z.enum(['replace', 'append', 'patch']).describe('replace: overwrite all. append: add lines. patch: replace `find` with `text`.'),
      text: z.string().describe('New content (or replacement text for patch)'),
      find: z.string().optional().describe('Text to find (patch mode only)'),
    },
    async (a) => {
      let trimmed = false;
      if (a.mode === 'replace') trimmed = ctx.memory.write(ctx.bot.id, a.text);
      else if (a.mode === 'append') trimmed = ctx.memory.append(ctx.bot.id, a.text);
      else {
        if (!a.find) return err('patch mode needs `find`');
        if (!ctx.memory.patch(ctx.bot.id, a.find, a.text)) return err('`find` text not present in memory');
      }
      // Memory is capped because it rides the system prompt every turn. Say so, so the bot prunes
      // deliberately instead of appending into a file that silently drops its oldest notes.
      return text(
        trimmed
          ? 'Memory updated, but it hit the ' + Math.round(MAX_MEMORY_BYTES / 1024) +
            ' KB limit and the oldest notes were dropped. Read it back and rewrite it shorter, keeping only what still matters.'
          : 'Memory updated.',
      );
    },
  );

  const readMemory = hubTool('read_memory', 'Read your current memory.md.', {}, async () => text(ctx.memory.read(ctx.bot.id) || '(empty)'), { readOnly: true });

  const saveSkill = hubTool(
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
        return text('Saved skill "' + s.name + '" (pending review by ' + userName + ').');
      } catch (e) {
        return err(String((e as Error).message));
      }
    },
  );

  const listBots = hubTool(
    'list_bots',
    'List the bots in this room with their roles.',
    {},
    async () => {
      const inRoom = new Set(ctx.members.map((b) => b.id));
      const line = (b: Bot) => '@' + b.handle + ' — ' + b.name + (b.title ? ' — ' + b.title : '') + (b.id === ctx.bot.id ? ' (you)' : '') + (b.description ? '\n  ' + b.description.split('\n')[0].slice(0, 160) : '');
      const rest = ctx.repos.listBots().filter((b) => !inRoom.has(b.id));
      return text(
        'In this room:\n' + (ctx.members.map(line).join('\n') || '(none)') +
        (rest.length ? '\n\nOther bots on this account (use add_to_room to bring one in):\n' + rest.map(line).join('\n') : '\n\nNo other bots exist yet; create_bot can make one.'),
      );
    },
    { readOnly: true },
  );

  const readRoom = hubTool(
    'read_room',
    'Read recent messages (oldest first). Defaults to the room you are in; pass `room` to read another one.',
    { limit: z.number().int().min(1).max(200).optional().describe('Default 30'), room: ROOM_ARG },
    async (a) => {
      const r = resolveRoom(a.room);
      if (!r.ok) return r.out;
      const msgs = ctx.repos
        .listMessages(r.room.id, { limit: a.limit ?? 30 })
        .filter((m) => m.kind === 'text' || m.kind === 'handoff' || m.kind === 'routine');
      const who = (m: { authorType: string; authorId: string | null }) =>
        m.authorType === 'user'
          ? userName
          : m.authorType === 'system'
            ? 'system'
            : '@' + (r.members.find((b) => b.id === m.authorId)?.handle ?? ctx.repos.getBot(m.authorId ?? '')?.handle ?? 'bot');
      return text(msgs.map((m) => '#' + m.seq + ' [' + who(m) + ']: ' + m.text).join('\n') || '(no messages)');
    },
    { readOnly: true },
  );

  const listRooms = hubTool(
    'list_rooms',
    'List every room on this account with its id, kind and members. Use it to find a room you are not in, then pass its name or id to read_room, send_message, add_to_room, remove_from_room or delete_room.',
    {},
    async () => {
      const rooms = ctx.repos.listRooms();
      if (!rooms.length) return text('(no rooms)');
      const line = (r: Room) => {
        const members = roomMembers(r);
        const coord = r.coordinatorBotId ? members.find((m) => m.id === r.coordinatorBotId) : undefined;
        return [
          (r.id === ctx.room.id ? '* ' : '  ') + r.name + ' [' + r.kind + '] id=' + r.id,
          '    members: ' + (members.map((m) => '@' + m.handle + (m.id === ctx.bot.id ? ' (you)' : '')).join(', ') || '(none)'),
          coord ? '    coordinator: @' + coord.handle : null,
        ].filter(Boolean).join('\n');
      };
      return text('* = the room you are in now\n' + rooms.map(line).join('\n'));
    },
    { readOnly: true },
  );

  const createBot = hubTool(
    'create_bot',
    'Create a new specialist bot (a persistent teammate with its own memory). In a group chat it joins this room and can be @mentioned right away. Use when the room lacks a needed role. Shows ' + userName + ' an approval card first; the bot is only created if they accept.',
    {
      name: z.string().min(1).max(40).describe('Display name, e.g. "Data Analyst"'),
      handle: z.string().regex(/^[a-z0-9_-]{2,24}$/).describe('Mention handle, lowercase, e.g. "analyst"'),
      title: z.string().max(80).describe('One-line role title'),
      description: z.string().min(10).max(4000).describe('Role instructions: responsibilities, how to work, what to avoid. Becomes the bot identity.'),
      avatar: z.string().max(8).optional().describe('Single emoji (default 🤖)'),
      tools: z.array(z.enum(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'])).optional().describe('Default: all of them'),
      join_this_room: z.boolean().optional().describe('Add the bot to the current room (group chats only). Default true'),
      model: z.string().optional().describe('Model for the new bot. Default: same as yours.' + modelHint),
    },
    async (a) => {
      if (ctx.repos.listBots().length >= 50) return err('Bot limit reached (50).');
      if (ctx.repos.getBotByHandle(a.handle)) return err('Handle @' + a.handle + ' already exists. Use add_to_room to bring an existing bot in, or pick another handle.');
      const bad = checkModel(a.model);
      if (bad) return bad;
      const denied = await gate(
        'create_bot',
        'Create bot @' + a.handle + ' (' + a.name + ')' + (a.title ? ' — ' + a.title : '') +
          ', tools: ' + (a.tools ?? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']).join('/') +
          ', model: ' + (a.model ?? ctx.bot.model),
        a as unknown as Record<string, unknown>,
      );
      if (denied) return denied;
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
      return text('Created @' + bot.handle + ' (' + bot.name + ').' + (joined ? ' It is in this room; mention @' + bot.handle + ' to give it work.' : ctx.room.kind === 'group' ? ' Room is full (6), not added.' : ' This is a DM, so it was not added here; ' + userName + ' can open a DM or add it to a group chat.'));
    },
  );

  const addToRoom = hubTool(
    'add_to_room',
    'Add an existing bot (by @handle) to a group chat so it can be mentioned there. Defaults to the room you are in; pass `room` for another one.',
    { handle: z.string().describe('@handle of an existing bot'), room: ROOM_ARG },
    async (a) => {
      const r = resolveRoom(a.room);
      if (!r.ok) return r.out;
      const room = r.room;
      if (room.kind !== 'group') return err('Only group chats have members to add; "' + room.name + '" is a ' + room.kind + '.');
      const b = ctx.repos.getBotByHandle(a.handle.replace(/^@/, '').toLowerCase());
      if (!b) return err('No bot with handle ' + a.handle + '. Existing: ' + ctx.repos.listBots().map((x) => '@' + x.handle).join(', '));
      if (room.memberIds.includes(b.id)) return text('@' + b.handle + ' is already in "' + room.name + '".');
      if (room.memberIds.length >= 6) return err('"' + room.name + '" is full (6 bots).');
      const denied = await gate('add_to_room', 'Add @' + b.handle + ' (' + b.name + ') to "' + room.name + '"', a as unknown as Record<string, unknown>);
      if (denied) return denied;
      ctx.repos.updateRoom(room.id, { memberIds: [...room.memberIds, b.id] });
      if (room.id === ctx.room.id) ctx.members.push(b);
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      const note = ctx.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'system', text: '@' + ctx.bot.handle + ' added ' + b.avatar + ' ' + b.name + ' (@' + b.handle + ') to this room.', payload: null, causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId });
      events.emitEvent({ type: 'message.new', message: note });
      return text('Added @' + b.handle + ' to "' + room.name + '". Mention it to give it work.');
    },
  );

  const createRoom = hubTool(
    'create_room',
    'Start a new group chat with existing bots (by @handle) so work can be split across them. You are added ' +
      'automatically. Shows ' + userName + ' an approval card first.',
    {
      name: z.string().describe('Short room name, e.g. "launch-plan"'),
      handles: z.array(z.string()).describe('@handles of existing bots to put in the room, besides you'),
      coordinator: z.string().optional().describe('@handle that answers messages with no @mention. Defaults to you.'),
    },
    async (a) => {
      const name = a.name.trim();
      if (!name) return err('A room needs a name.');

      // Resolve every handle before asking, so a typo is a plain error rather than a declined card.
      const wanted: Bot[] = [];
      for (const h of a.handles) {
        const found = ctx.repos.getBotByHandle(h.replace(/^@/, '').toLowerCase());
        if (!found) return err('No bot with handle ' + h + '. Existing: ' + ctx.repos.listBots().map((x) => '@' + x.handle).join(', '));
        if (found.id !== ctx.bot.id && !wanted.some((w) => w.id === found.id)) wanted.push(found);
      }
      const self = ctx.repos.getBot(ctx.bot.id)!;
      const members = [self, ...wanted];
      if (members.length < 2) return err('A group chat needs at least one other bot besides you.');
      if (members.length > 6) return err('A room holds at most 6 bots; you asked for ' + members.length + '.');

      const coordRef = (a.coordinator ?? ctx.bot.handle).replace(/^@/, '').toLowerCase();
      const coord = members.find((m) => m.handle.toLowerCase() === coordRef);
      if (!coord) return err('Coordinator @' + coordRef + ' is not one of the room members.');

      const denied = await gate(
        'create_room',
        'Create group chat "' + name + '" with ' + members.map((m) => '@' + m.handle).join(', ') + ' (coordinator @' + coord.handle + ')',
        a as unknown as Record<string, unknown>,
      );
      if (denied) return denied;

      const room = ctx.repos.createRoom({ kind: 'group', name, memberIds: members.map((m) => m.id), coordinatorBotId: coord.id });
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      const note = ctx.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: null, kind: 'system',
        text: '@' + ctx.bot.handle + ' created this room with ' + members.map((m) => '@' + m.handle).join(', ') + '.',
        payload: null, causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId,
      });
      events.emitEvent({ type: 'message.new', message: note });
      return text(
        'Created "' + name + '" with ' + members.map((m) => '@' + m.handle).join(', ') + '. ' +
        'Your turn is still in this room, so start the work with send_message({ room: "' + name + '", text: "@handle ..." }).',
      );
    },
  );

  const TOOL_ENUM = z.enum(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Browser', 'Desktop']);
  const resolveAny = (ref: string) => {
    const r = ref.replace(/^@/, '').toLowerCase();
    return r === 'me' || r === 'self' || r === ctx.bot.handle.toLowerCase()
      ? ctx.repos.getBot(ctx.bot.id)
      : ctx.repos.getBotByHandle(r) ?? ctx.repos.listBots().find((b) => b.name.toLowerCase() === r);
  };
  const sysNote = (body: string, room: Room = ctx.room) => {
    const note = ctx.repos.insertMessage({ roomId: room.id, authorType: 'system', authorId: null, kind: 'system', text: body, payload: null, causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId });
    events.emitEvent({ type: 'message.new', message: note });
  };

  const updateBot = hubTool(
    'update_bot',
    'Change an existing bot (any bot, including yourself: use "me"). Only the fields you pass change. Description replaces the identity instructions. Editing your OWN name/title/avatar/description is immediate; changing tools, model or budget, renaming a handle, or touching any other bot shows ' + userName + ' an approval card first.',
    {
      bot: z.string().describe('@handle, name, or "me"'),
      name: z.string().min(1).max(40).optional(),
      handle: z.string().regex(/^[a-z0-9_-]{2,24}$/).optional().describe('New mention handle (must be unused)'),
      title: z.string().max(80).optional(),
      description: z.string().min(10).max(4000).optional().describe('New role instructions (full replacement)'),
      avatar: z.string().max(8).optional(),
      model: z.string().optional().describe('Model id.' + modelHint),
      tools: z.array(TOOL_ENUM).optional().describe('Full replacement of the allowed tool list'),
      max_budget_usd: z.number().min(0.05).max(50).optional().describe('Budget per turn'),
    },
    async (a) => {
      const target = resolveAny(a.bot);
      if (!target) return err('No bot "' + a.bot + '". Existing: ' + ctx.repos.listBots().map((x) => '@' + x.handle).join(', '));
      if (a.handle && a.handle !== target.handle && ctx.repos.getBotByHandle(a.handle)) return err('Handle @' + a.handle + ' is taken.');
      const bad = checkModel(a.model);
      if (bad) return bad;
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

      // A bot may still tidy its own presentation. Anything that changes what a bot is *allowed to do* —
      // tools, model, budget — or that touches another bot needs the human (audit 2026-09-09, B6).
      const SELF_EDITABLE = new Set(['name', 'title', 'avatar', 'description']);
      const security = Object.keys(patch).filter((k) => !SELF_EDITABLE.has(k));
      const isSelf = target.id === ctx.bot.id;
      if (!isSelf || security.length) {
        const denied = await gate(
          'update_bot',
          (isSelf ? 'Change your own settings' : 'Change ' + target.avatar + ' ' + target.name + ' (@' + target.handle + ')') +
            ': ' + Object.entries(patch).map(([k, v]) => k + ' = ' + JSON.stringify(v).slice(0, 120)).join(', '),
          a as unknown as Record<string, unknown>,
        );
        if (denied) return denied;
      }
      const updated = ctx.repos.updateBot(target.id, patch)!;
      if (a.description !== undefined) ctx.memory.writeIdentity(updated.id, a.description);
      const i = ctx.members.findIndex((m) => m.id === updated.id);
      if (i >= 0) ctx.members[i] = updated;
      events.emitEvent({ type: 'bots.changed', bots: ctx.repos.listBots() });
      sysNote('@' + ctx.bot.handle + ' updated ' + updated.avatar + ' ' + updated.name + ' (@' + updated.handle + '): ' + Object.keys(patch).join(', ') + '.');
      return text('Updated @' + updated.handle + ' (' + Object.keys(patch).join(', ') + ').' + (target.id === ctx.bot.id ? ' Changes to your own identity/tools apply from your next turn.' : ''));
    },
  );

  const deleteBot = hubTool(
    'delete_bot',
    'Permanently delete a bot (any bot, including yourself: use "me"). Removes it from all rooms and deletes its memory. Chat history stays. Requires confirm=true, and always shows ' + userName + ' an approval card — your confirm=true is not their consent.',
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
      const denied = await gate(
        'delete_bot',
        'Permanently delete ' + target.avatar + ' ' + target.name + ' (@' + target.handle + ')' + (self ? ' — itself' : '') +
          ' and erase its memory' + (a.reason ? ': ' + a.reason : '.'),
        a as unknown as Record<string, unknown>,
      );
      if (denied) return denied;
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

  const removeFromRoom = hubTool(
    'remove_from_room',
    'Remove a bot (or yourself: "me") from a group chat. The bot keeps existing and can be added back. Defaults to the room you are in; pass `room` for another one.',
    { bot: z.string().describe('@handle, name, or "me"'), room: ROOM_ARG },
    async (a) => {
      const r = resolveRoom(a.room);
      if (!r.ok) return r.out;
      const room = r.room;
      if (room.kind !== 'group') return err('Only group chats have members to remove; "' + room.name + '" is a ' + room.kind + '.');
      const target = resolveAny(a.bot);
      if (!target) return err('No bot "' + a.bot + '".');
      if (!room.memberIds.includes(target.id)) return text('@' + target.handle + ' is not in "' + room.name + '".');
      const denied = await gate('remove_from_room', 'Remove @' + target.handle + ' (' + target.name + ') from "' + room.name + '"', a as unknown as Record<string, unknown>);
      if (denied) return denied;
      ctx.repos.updateRoom(room.id, { memberIds: room.memberIds.filter((id) => id !== target.id), coordinatorBotId: room.coordinatorBotId === target.id ? null : undefined });
      if (room.id === ctx.room.id) {
        const idx = ctx.members.findIndex((m) => m.id === target.id);
        if (idx >= 0) ctx.members.splice(idx, 1);
      }
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      sysNote('@' + ctx.bot.handle + ' removed ' + target.avatar + ' ' + target.name + ' (@' + target.handle + ') from this room.', room);
      return text('Removed @' + target.handle + ' from "' + room.name + '".');
    },
  );

  const deleteRoom = hubTool(
    'delete_room',
    'Disband a group chat: the room, its whole message history, its routines and its bot sessions are deleted for good. The bots themselves keep existing. You do not have to be a member. Requires confirm=true.',
    {
      room: z.string().describe('Room name or id, from list_rooms'),
      confirm: z.boolean().describe('Must be true. Deleting a room cannot be undone.'),
    },
    async (a) => {
      if (!a.confirm) return err('delete_room needs confirm=true; nothing was deleted.');
      const r = resolveRoom(a.room);
      if (!r.ok) return r.out;
      const room = r.room;
      if (room.kind !== 'group') return err('"' + room.name + '" is a ' + room.kind + ', not a group chat. DMs belong to ' + userName + ' and are not yours to delete.');
      // Deleting the room this turn is running in would drop the transcript mid-turn, including the reply
      // about to be posted. Refuse rather than corrupt the run; another room can always do it.
      if (room.id === ctx.room.id) return err('You are in "' + room.name + '" right now, so you cannot delete it from inside it. Ask from another room, or have ' + userName + ' delete it.');
      const denied = await gate('delete_room', 'Delete group chat "' + room.name + '" and its whole history', a as unknown as Record<string, unknown>);
      if (denied) return denied;
      const members = r.members.map((m) => '@' + m.handle).join(', ');
      ctx.repos.deleteRoom(room.id);
      events.emitEvent({ type: 'rooms.changed', rooms: ctx.repos.listRooms() });
      sysNote('@' + ctx.bot.handle + ' deleted the group chat "' + room.name + '" (' + (members || 'no members') + ').');
      return text('Deleted "' + room.name + '". Its history is gone; the bots (' + (members || 'none') + ') still exist.');
    },
  );

  const tools: HubTool[] = [sendMessage, handoff, updateMemory, readMemory, saveSkill, listBots, readRoom, listRooms, createBot, createRoom, addToRoom, updateBot, deleteBot, removeFromRoom, deleteRoom];

  if (ctx.requestApproval) {
    tools.push(hubTool(
      'request_approval',
      'Ask ' + userName + ' to approve an action before you take it. Required before writing outside the workspace, running a destructive or network-changing shell command, or anything irreversible. ' +
        'Returns { allowed, message, approvalId }. The approval is recorded against exactly the action, command and paths you passed and expires in 10 minutes — it is ADVISORY: the hub cannot police what your CLI actually runs, so do only what you described. Doing something else after an approval is a violation, not a loophole.',
      {
        action: z.string().min(3).describe('What you want to do, in one line'),
        command: z.string().optional().describe('The exact shell command, when the action is a command'),
        paths: z.array(z.string()).optional().describe('Absolute paths the action touches'),
        reason: z.string().optional().describe('Why it is needed'),
      },
      async (a) => {
        const r = await ctx.requestApproval!({ action: a.action, command: a.command, paths: a.paths, reason: a.reason });
        return text(JSON.stringify(r));
      },
    ));
  }
  if (ctx.desktop) tools.push(...desktopTools());
  return tools;
}
