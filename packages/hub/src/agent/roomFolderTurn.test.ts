import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ProjectService } from '../services/ProjectService.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomFiles } from '../rooms/roomFiles.js';
import { BotRunner } from './BotRunner.js';

/** A turn may use the file folder of the room it is replying in, and no other room's or project's. */

class RecordingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Recording';
  readonly info = { id: 'claude' as ProviderId, label: 'Recording', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onText('done');
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(opts: { bypass?: boolean } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-roomturn-'));
  dirs.push(tmp);
  const memory = new MemoryService();
  const projects = new ProjectService({ db, repos, memory, root: path.join(tmp, 'projects') });
  const roomsDir = path.join(tmp, 'rooms');
  const dmDir = (id: string) => path.join(tmp, 'bots', id, 'files');
  const roomFiles = new RoomFiles({ projects, roomsDir, dmDir });
  const provider = new RecordingProvider();
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, memory, new SkillService(repos), new PermissionBroker(repos, { bypass: () => !!opts.bypass }), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  runner.projects = projects;
  runner.roomFiles = roomFiles;

  const bot = repos.createBot({ name: 'Lead', handle: 'lead', title: '', description: '', avatar: '', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const group = (name: string) => repos.createRoom({ kind: 'group', name, memberIds: [bot.id], coordinatorBotId: null }) as Room;
  const roomA = group('A');
  const roomB = group('B');
  const plain = group('Plain');
  const other = group('Other');
  const dm = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null }) as Room;
  // The bot is on both projects; only the room decides which one it may open.
  projects.create({ name: 'Alpha', memberIds: [bot.id] });
  projects.create({ name: 'Beta', memberIds: [bot.id] });
  db.run('UPDATE projects SET room_id=? WHERE slug=?', roomA.id, 'alpha');
  db.run('UPDATE projects SET room_id=? WHERE slug=?', roomB.id, 'beta');

  const run = async (room: Room) => {
    await runner.runTurn({ bot, room, members: [bot], injected: 'hi', hop: 0, causeId: 'c-' + room.id });
    return provider.seen[provider.seen.length - 1];
  };
  return { bot, run, projects, roomsDir, dmDir, roomA, roomB, plain, other, dm, repos, db };
}

const read = (ctx: TurnContext, file: string) => ctx.projectGuard!('Read', { file_path: file }, ctx.workspaceDir);

describe('a turn\'s file folder', () => {
  it('in a project room: that project\'s folder only, in the roots, the prompt and the guard', async () => {
    const s = setup();
    const ctx = await s.run(s.roomA);
    const alpha = s.projects.dirOf('alpha');
    const beta = s.projects.dirOf('beta');
    expect(ctx.projectDirs).toEqual([alpha]);
    expect(ctx.systemPrompt).toContain(alpha);
    expect(ctx.systemPrompt).not.toContain(beta);
    expect(read(ctx, path.join(alpha, 'current.md'))).toBeNull();
    expect(read(ctx, path.join(beta, 'current.md'))).toMatch(/another room/);
    expect(read(ctx, path.join(s.roomsDir, s.plain.id, 'x.md'))).toMatch(/another room/);
    expect(ctx.projectGuard!('Bash', { command: 'cat ' + beta.replaceAll('\\', '/') + '/current.md' }, ctx.workspaceDir)).toMatch(/another room/);
  });

  it('in a direct chat: the bot\'s files/ folder, and no project, even one the bot is on', async () => {
    const s = setup();
    const ctx = await s.run(s.dm);
    expect(ctx.projectDirs).toEqual([s.dmDir(s.bot.id)]);
    expect(fs.statSync(s.dmDir(s.bot.id)).isDirectory()).toBe(true);
    expect(ctx.systemPrompt).toContain(s.dmDir(s.bot.id));
    expect(ctx.systemPrompt).not.toContain(s.projects.dirOf('alpha'));
    expect(read(ctx, path.join(s.projects.dirOf('alpha'), 'current.md'))).toMatch(/another room/);
  });

  it('in a group room with no project: its own folder, made on first use, and no other room\'s', async () => {
    const s = setup();
    const ctx = await s.run(s.plain);
    const mine = path.join(s.roomsDir, s.plain.id);
    expect(ctx.projectDirs).toEqual([mine]);
    expect(fs.statSync(mine).isDirectory()).toBe(true);
    expect(read(ctx, path.join(mine, 'notes.md'))).toBeNull();
    expect(read(ctx, path.join(s.roomsDir, s.other.id, 'notes.md'))).toMatch(/another room/);
    expect(ctx.projectGuard!('Glob', { path: s.roomsDir, pattern: '**' }, ctx.workspaceDir)).toMatch(/another room/);
    expect(read(ctx, path.join(s.projects.dirOf('alpha'), 'current.md'))).toMatch(/another room/);
  });

  it('keeps the guard on with approvals bypassed', async () => {
    const s = setup({ bypass: true });
    const ctx = await s.run(s.roomA);
    expect(ctx.bypassPermissions).toBe(true);
    expect(ctx.projectGuard).toBeTypeOf('function');
    expect(read(ctx, path.join(s.projects.dirOf('beta'), 'current.md'))).toMatch(/another room/);
  });

  it('gives a bot not on the room\'s project no folder there', async () => {
    const s = setup();
    s.projects.setMembers('alpha', []);
    const ctx = await s.run(s.roomA);
    expect(ctx.projectDirs).toEqual([]);
    expect(read(ctx, path.join(s.projects.dirOf('alpha'), 'current.md'))).toMatch(/another room/);
  });
});
