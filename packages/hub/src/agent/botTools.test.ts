import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { isMediaRef } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { MediaStore } from '../services/MediaStore.js';
import { WORKSPACE_DIR } from '../config.js';
import { events } from '../events.js';
import { settings } from '../services/SettingsStore.js';
import { createHubTools, type ToolCtx } from './botTools.js';

function setup(extra: Partial<ToolCtx> = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const ctx: ToolCtx = {
    bot, room: room as Room, members: [bot as Bot], turnId: 't1', hop: 0, causeId: 'c1',
    repos, memory: new MemoryService(), skills: new SkillService(repos),
    dispatchFromBot: () => [], setState: () => undefined,
    models: ['claude-sonnet-5', 'claude-opus-5'],
    ...extra,
  };
  return { repos, bot, room, ctx, tools: createHubTools(ctx) };
}

const byName = (tools: ReturnType<typeof createHubTools>, name: string) => tools.find((t) => t.name === name)!;

describe('read_owner_messages', () => {
  const asPersona = (extra: Partial<ToolCtx> = {}) => {
    const s = setup(extra);
    vi.spyOn(settings, 'get').mockReturnValue({ ...settings.get(), personaBotId: s.bot.id });
    return { ...s, tools: createHubTools(s.ctx) };
  };
  afterEach(() => vi.restoreAllMocks());
  const say = (repos: Repos, roomId: string, authorType: 'user' | 'bot', text: string) =>
    repos.insertMessage({ roomId, authorType, authorId: null, kind: 'text', text, payload: null, causeId: null, hop: 0, turnId: null });
  const read = async (tools: ReturnType<typeof createHubTools>, input: Record<string, unknown> = {}) =>
    ((await byName(tools, 'read_owner_messages').handler(input)).content[0] as { text: string }).text;

  it('goes only to the bot the owner named', () => {
    expect(setup().tools.some((t) => t.name === 'read_owner_messages')).toBe(false);
    expect(asPersona().tools.some((t) => t.name === 'read_owner_messages')).toBe(true);
  });

  it('returns the owner\'s messages from every room and leaves out bot replies', async () => {
    const { tools, repos, room, bot } = asPersona();
    const other = repos.createRoom({ kind: 'group', name: 'Elsewhere', memberIds: [bot.id], coordinatorBotId: null });
    say(repos, room.id, 'user', 'from the dm');
    say(repos, other.id, 'user', 'from the group');
    say(repos, other.id, 'bot', 'a bot reply');
    const out = await read(tools);
    expect(out).toContain('from the dm');
    expect(out).toContain('in Elsewhere] from the group');
    expect(out).not.toContain('a bot reply');
  });

  it('filters by room and text, treating wildcards as plain text', async () => {
    const { tools, repos, room, bot } = asPersona();
    const other = repos.createRoom({ kind: 'group', name: 'Elsewhere', memberIds: [bot.id], coordinatorBotId: null });
    say(repos, room.id, 'user', 'dentist at noon');
    say(repos, other.id, 'user', 'dentist again');
    say(repos, room.id, 'user', '100% done');
    expect(await read(tools, { room: 'Elsewhere' })).not.toContain('noon');
    const hits = await read(tools, { query: '%' });
    expect(hits).toContain('100% done');
    expect(hits).not.toContain('dentist');
  });

  it('redacts secrets the owner pasted', async () => {
    const { tools, repos, room } = asPersona();
    say(repos, room.id, 'user', 'my key is Bearer abcdefghijklmnopqrstuvwxyz123456');
    expect(await read(tools)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('refuses a since that is not a date', async () => {
    const { tools } = asPersona();
    const out = await byName(tools, 'read_owner_messages').handler({ since: 'lately' });
    expect(out.isError).toBe(true);
  });
});

describe('createHubTools', () => {
  it('returns the 31 hub tools and no request_approval for a full-permission provider', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
      'list_rooms', 'create_bot', 'create_room', 'add_to_room', 'update_bot', 'delete_bot',
      'remove_from_room', 'delete_room',
      // P3
      'list_routines', 'create_routine', 'update_routine', 'delete_routine',
      // Key routing
      'where_to_run', 'list_machines', 'escalate',
      // P7
      'search_notes', 'write_note',
      // G1-G5
      'create_task', 'update_task', 'list_tasks', 'search_history', 'recall_memory', 'report_blocked', 'send_feedback',
    ]);
  });

  it('validates create_bot/update_bot models against the active provider', async () => {
    const { tools, bot, repos } = setup();
    const out = await byName(tools, 'update_bot').handler({ bot: 'me', model: 'test-model-x' });
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('Unknown model') });
    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');

    const ok = await byName(tools, 'update_bot').handler({ bot: 'me', model: 'claude-opus-5' });
    expect(ok.isError).toBeFalsy();
    expect(repos.getBot(bot.id)!.model).toBe('claude-opus-5');

    const bad = await byName(tools, 'create_bot').handler({ name: 'X', handle: 'xx', title: '', description: 'a description', model: 'grok-4.6' });
    expect(bad.isError).toBe(true);
    expect(repos.getBotByHandle('xx')).toBeUndefined();
  });

  it('create_bot defaults to the provider default model, not the creator\'s', async () => {
    const s = setup();
    const tools = createHubTools({ ...s.ctx, bot: { ...s.bot, model: 'claude-opus-5' } });
    const out = await byName(tools, 'create_bot').handler({ name: 'Worker', handle: 'worker', title: '', description: 'a description' });
    expect(out.isError).toBeFalsy();
    expect(s.repos.getBotByHandle('worker')!.model).toBe('claude-sonnet-5');
    // Opus only when it is asked for by name.
    await byName(tools, 'create_bot').handler({ name: 'Lead', handle: 'lead', title: '', description: 'a description', model: 'claude-opus-5' });
    expect(s.repos.getBotByHandle('lead')!.model).toBe('claude-opus-5');
    // Another provider has no Sonnet id: Auto, which routes to its own default tier, rather than the creator's model.
    const other = createHubTools({ ...s.ctx, bot: { ...s.bot, model: 'opencode/claude-opus-4-6' }, models: ['opencode/claude-opus-4-6', 'opencode/claude-sonnet-4-5', 'auto'] });
    await byName(other, 'create_bot').handler({ name: 'Other', handle: 'other', title: '', description: 'a description' });
    expect(s.repos.getBotByHandle('other')!.model).toBe('auto');
    expect((byName(tools, 'create_bot').inputSchema.shape.model as { description?: string }).description).toMatch(/Sonnet for most workers/);
  });

  it('reports bad arguments instead of throwing', async () => {
    const { tools } = setup();
    const out = await byName(tools, 'send_message').handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('Invalid arguments') });
  });

  it('request_approval routes to the PermissionBroker and reports the decision', async () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'test-model-x', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const broker = new PermissionBroker(repos);
    const ac = new AbortController();
    const setState = vi.fn();
    const permCtx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState };

    const tools = createHubTools({
      bot, room, members: [bot], turnId: 't1', hop: 0, causeId: 'c1',
      repos, memory: new MemoryService(), skills: new SkillService(repos),
      dispatchFromBot: () => [], setState: () => undefined, models: ['test-model-x'],
      requestApproval: (a) => broker.ask(permCtx, a, ac.signal),
    });
    const tool = byName(tools, 'request_approval');
    expect(tool).toBeTruthy();

    // The approval card reaches the UI as an approval.request event; answer it like the web client does.
    const seen: ApprovalPayload[] = [];
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') {
        seen.push(ev.approval);
        setTimeout(() => broker.resolve(ev.approval.approvalId, 'allow'), 0);
      }
    });
    const out = await tool.handler({ action: 'delete the build cache', command: 'rm -rf /tmp/build', reason: 'stale' });
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: 'request_approval', reason: 'delete the build cache', danger: true });
    // The approval now returns the id of the recorded grant (audit 2026-09-09, B10).
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as { allowed: boolean; message: string; approvalId: string };
    expect(parsed).toMatchObject({ allowed: true, message: 'Approved by the user.' });
    expect(parsed.approvalId).toBe(seen[0].approvalId);
    expect(setState).toHaveBeenCalledWith('blocked');
  });

  it('request_approval reports a denial back to the bot', async () => {
    const repos = new Repos(new Db(':memory:'));
    const bot = repos.createBot({ name: 'Codey', handle: 'codey2', title: '', description: 'x', avatar: '🤖', model: 'test-model-x', allowedTools: [], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const broker = new PermissionBroker(repos);
    const permCtx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState: () => undefined };
    const tools = createHubTools({
      bot, room, members: [bot], turnId: 't1', hop: 0, causeId: 'c1',
      repos, memory: new MemoryService(), skills: new SkillService(repos),
      dispatchFromBot: () => [], setState: () => undefined, models: [],
      requestApproval: (a) => broker.ask(permCtx, a, new AbortController().signal),
    });
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, 'deny'), 0);
    });
    const out = await byName(tools, 'request_approval').handler({ action: 'email the customer list' });
    off();
    const parsed = JSON.parse((out.content[0] as { text: string }).text) as { allowed: boolean; message: string };
    expect(parsed.allowed).toBe(false);
    expect(parsed.message).toContain('declined');
  });

  describe('send_message image_path', () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const cleanup: (() => void)[] = [];
    afterEach(() => { for (const c of cleanup.splice(0)) c(); });

    it('attaches an image saved in the shared workspace', async () => {
      const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-media-'));
      cleanup.push(() => fs.rmSync(mediaDir, { recursive: true, force: true }));
      const { tools, repos, room } = setup({ media: new MediaStore(mediaDir) });
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      const f = path.join(WORKSPACE_DIR, 'send-message-attach-probe.png');
      fs.writeFileSync(f, PNG);
      cleanup.push(() => fs.rmSync(f, { force: true }));

      const out = await byName(tools, 'send_message').handler({ text: 'here is the sheet', image_path: f });
      expect(out.isError).toBeFalsy();
      const msgs = repos.listMessages(room.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].attachments).toHaveLength(1);
      expect(isMediaRef(msgs[0].attachments![0])).toBe(true);
    });

    it('refuses a path outside the bot\'s own folders', async () => {
      const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-media-'));
      cleanup.push(() => fs.rmSync(mediaDir, { recursive: true, force: true }));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-outside-'));
      cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
      const f = path.join(outside, 'secret.png');
      fs.writeFileSync(f, PNG);
      const { tools, repos, room } = setup({ media: new MediaStore(mediaDir) });

      const out = await byName(tools, 'send_message').handler({ text: 'sneaky', image_path: f });
      expect(out.isError).toBe(true);
      expect(out.content[0]).toMatchObject({ text: expect.stringContaining('outside') });
      expect(repos.listMessages(room.id)).toHaveLength(0);
    });

    it('refuses a non-image file', async () => {
      const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-media-'));
      cleanup.push(() => fs.rmSync(mediaDir, { recursive: true, force: true }));
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      const f = path.join(WORKSPACE_DIR, 'send-message-attach-probe.txt');
      fs.writeFileSync(f, 'not a picture');
      cleanup.push(() => fs.rmSync(f, { force: true }));
      const { tools, repos, room } = setup({ media: new MediaStore(mediaDir) });

      const out = await byName(tools, 'send_message').handler({ text: 'oops', image_path: f });
      expect(out.isError).toBe(true);
      expect(repos.listMessages(room.id)).toHaveLength(0);
    });

    it('without a MediaStore wired (most unit tests), refuses rather than posting a broken attachment', async () => {
      const { tools, repos, room } = setup();
      const out = await byName(tools, 'send_message').handler({ text: 'x', image_path: path.join(WORKSPACE_DIR, 'whatever.png') });
      expect(out.isError).toBe(true);
      expect(repos.listMessages(room.id)).toHaveLength(0);
    });

    it('still posts a plain message with no image_path', async () => {
      const { tools, repos, room } = setup();
      const out = await byName(tools, 'send_message').handler({ text: 'no picture here' });
      expect(out.isError).toBeFalsy();
      expect(repos.listMessages(room.id)[0].attachments).toBeUndefined();
    });
  });
});

describe('M6: provider per bot in the bot tools (P1-3, P1-7)', () => {
  const MODELS: Record<string, string[]> = {
    claude: ['claude-sonnet-5', 'claude-opus-5', 'auto'],
    codex: ['gpt-5-codex', 'auto'],
  };
  const modelsFor = (p: string | null) => MODELS[p ?? 'claude'];

  it('update_bot checks a model against the provider the target bot runs on, not the caller\'s', async () => {
    const s = setup({ modelsFor });
    const cy = s.repos.createBot({ name: 'Cy', handle: 'cy', title: '', description: 'x', avatar: '', model: 'gpt-5-codex', allowedTools: [], maxBudgetUsd: 1, provider: 'codex' });
    const tools = createHubTools(s.ctx);
    // A Claude model on a Codex bot is refused, though the caller (on Claude) lists it.
    const bad = await byName(tools, 'update_bot').handler({ bot: 'cy', model: 'claude-opus-5' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]).toMatchObject({ text: expect.stringContaining('gpt-5-codex') });
    expect(s.repos.getBot(cy.id)!.model).toBe('gpt-5-codex');
    // And a Codex model on the caller's own Claude bot is refused too.
    expect((await byName(tools, 'update_bot').handler({ bot: 'me', model: 'gpt-5-codex' })).isError).toBe(true);
    expect((await byName(tools, 'update_bot').handler({ bot: 'cy', model: 'auto' })).isError).toBeFalsy();
  });

  it('create_bot checks against the default provider, where the new bot runs, even from a bot on another one', async () => {
    const s = setup({ modelsFor });
    const onCodex = s.repos.updateBot(s.bot.id, { provider: 'codex', model: 'gpt-5-codex' })!;
    const tools = createHubTools({ ...s.ctx, bot: onCodex, models: MODELS.codex });
    expect((await byName(tools, 'create_bot').handler({ name: 'X', handle: 'xx', title: '', description: 'a description', model: 'gpt-5-codex' })).isError).toBe(true);
    expect((await byName(tools, 'create_bot').handler({ name: 'Y', handle: 'yy', title: '', description: 'a description' })).isError).toBeFalsy();
    // The default (Claude) default, not the Codex creator's model.
    expect(s.repos.getBotByHandle('yy')).toMatchObject({ model: 'claude-sonnet-5', provider: null });
  });

  it('a bot cannot set a provider or a backup, for itself or another bot, even with approvals off', async () => {
    const s = setup({ modelsFor });
    const tools = createHubTools(s.ctx); // no confirmFleetChange: every other change would go through unguarded
    const self = await byName(tools, 'update_bot').handler({ bot: 'me', provider: 'codex' });
    expect(self.isError).toBe(true);
    expect(self.content[0]).toMatchObject({ text: expect.stringContaining('only by the owner') });
    const both = await byName(tools, 'update_bot').handler({ bot: 'me', name: 'Renamed', backup: { provider: 'codex', model: 'gpt-5-codex' } });
    expect(both.isError).toBe(true);
    expect(s.repos.getBot(s.bot.id)).toMatchObject({ name: 'Scout', provider: null, backup: null });

    const created = await byName(tools, 'create_bot').handler({ name: 'X', handle: 'xx', title: '', description: 'a description', provider: 'codex' });
    expect(created.isError).toBe(true);
    expect(s.repos.getBotByHandle('xx')).toBeUndefined();
    // Without those fields the same calls still work.
    expect((await byName(tools, 'update_bot').handler({ bot: 'me', name: 'Renamed' })).isError).toBeFalsy();
  });

  it('read_skill is offered only for skills as text, and opens only an approved skill assigned to this bot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-skill-'));
    try {
      fs.mkdirSync(path.join(dir, 'mine'));
      fs.writeFileSync(path.join(dir, 'mine', 'SKILL.md'), '# Weekly report\nStep 1: gather numbers.');
      const s = setup();
      expect(s.tools.some((t) => t.name === 'read_skill')).toBe(false);
      const mine = s.repos.upsertSkill({ name: 'mine', description: 'd', path: path.join(dir, 'mine'), source: 'authored', reviewStatus: 'approved', createdByBot: null });
      const draft = s.repos.upsertSkill({ name: 'draft', description: 'd', path: path.join(dir, 'mine'), source: 'bot', reviewStatus: 'pending', createdByBot: s.bot.id });
      s.repos.upsertSkill({ name: 'theirs', description: 'd', path: path.join(dir, 'mine'), source: 'authored', reviewStatus: 'approved', createdByBot: null });
      s.repos.setBotSkills(s.bot.id, [mine.id, draft.id]);
      const tools = createHubTools({ ...s.ctx, skillsAsText: true });
      const read = (name: string) => byName(tools, 'read_skill').handler({ name });
      const ok = await read('mine');
      expect(ok.isError).toBeFalsy();
      expect((ok.content[0] as { text: string }).text).toContain('Step 1: gather numbers.');
      for (const name of ['draft', 'theirs', '../mine']) {
        const out = await read(name);
        expect(out.isError).toBe(true);
        expect((out.content[0] as { text: string }).text).toContain('Yours: mine.');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
