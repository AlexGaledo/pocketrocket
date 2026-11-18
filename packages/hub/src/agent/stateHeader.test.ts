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
import { FileRevisions, type RevisionAuthor } from '../services/FileRevisions.js';
import { buildStateHeader, currentExcerpt, parseDecisions } from '../services/StateHeader.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomFiles, fileRootOf } from '../rooms/roomFiles.js';
import { BotRunner } from './BotRunner.js';

/** Bridge P2 (spec 6.2): the folder's state goes at the top of a turn's input, once per change, never in the system prompt. */

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

const human: RevisionAuthor = { kind: 'owner-cc', id: null, label: 'Alex via Claude Code (app)', machine: 'pc' };

function setup() {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-statehdr-'));
  dirs.push(tmp);
  const memory = new MemoryService();
  const projects = new ProjectService({ db, repos, memory, root: path.join(tmp, 'projects') });
  const roomFiles = new RoomFiles({ projects, roomsDir: path.join(tmp, 'rooms'), dmDir: (id) => path.join(tmp, 'bots', id, 'files') });
  const provider = new RecordingProvider();
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, memory, new SkillService(repos), new PermissionBroker(repos, { bypass: () => false }), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  const revisions = new FileRevisions(db);
  runner.projects = projects;
  runner.roomFiles = roomFiles;
  runner.revisions = revisions;
  const bot = repos.createBot({ name: 'Lead', handle: 'lead', title: '', description: '', avatar: '', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'group', name: 'Team', memberIds: [bot.id], coordinatorBotId: null }) as Room;
  const root = fileRootOf(room, roomFiles.folderOf(room)!);
  fs.mkdirSync(root.dir, { recursive: true });
  const write = (rel: string, text: string) => {
    fs.writeFileSync(path.join(root.dir, rel), text);
    revisions.record(root, rel, human);
  };
  /** A turn that resumes the session, as the second and later turns of a conversation do. */
  const resumeable = () => {
    repos.saveSession(bot.id, room.id, { sdkSessionId: 'sess-1', provider: 'claude' });
    repos.saveSessionState(bot.id, room.id, { contextTokens: 5_000, contextAt: Date.now(), costTotal: 1 });
  };
  const run = async () => {
    await runner.runTurn({ bot, room, members: [bot], injected: 'do the thing', hop: 0, causeId: 'c' + provider.seen.length });
    return provider.seen[provider.seen.length - 1];
  };
  return { run, write, resumeable, root, revisions, repos, bot, room };
}

describe('state header at the start of a turn', () => {
  it('is in the input, with the version of current.md and the latest decisions, and not in the system prompt', async () => {
    const s = setup();
    s.write('current.md', '# Plan\n\n## Now\nShip the hub bridge.\n\n## Later\nUnrelated.\n');
    s.revisions.appendDecision(s.root, { title: 'Use SQLite', text: 'Simple.' }, human);
    const ctx = await s.run();
    expect(ctx.input).toContain('current.md (rev 1, ');
    expect(ctx.input).toContain('last changed by Alex via Claude Code (app) (pc)');
    expect(ctx.input).toContain('Ship the hub bridge.');
    expect(ctx.input).not.toContain('Unrelated.');
    expect(ctx.input).toContain('D-0001 Use SQLite');
    expect(ctx.input).toContain('append-only');
    expect(ctx.input.endsWith('do the thing')).toBe(true);
    expect(ctx.input.length).toBeLessThan(2048 + 'do the thing'.length);
    expect(ctx.systemPrompt).not.toContain('Ship the hub bridge.');
    expect(ctx.systemPrompt).not.toContain('Use SQLite');
  });

  it('is left out when neither file exists', async () => {
    const s = setup();
    const ctx = await s.run();
    expect(ctx.input).toBe('do the thing');
  });

  it('shows decisions alone when there is no current.md', async () => {
    const s = setup();
    s.revisions.appendDecision(s.root, { title: 'Only one', text: 'x' }, human);
    const ctx = await s.run();
    expect(ctx.input).toContain('D-0001 Only one');
    expect(ctx.input).not.toContain('current.md (');
  });

  it('is not repeated on a resumed session while nothing changed, and comes back when a file does', async () => {
    const s = setup();
    s.write('current.md', '## Now\nstep one\n');
    s.resumeable();
    const first = await s.run();
    expect(first.input).toContain('step one');

    s.resumeable();
    const again = await s.run();
    expect(again.input).toBe('do the thing');

    s.write('current.md', '## Now\nstep two\n');
    s.resumeable();
    const changed = await s.run();
    expect(changed.input).toContain('step two');
    expect(changed.input).toContain('rev 2');

    s.resumeable();
    s.revisions.appendDecision(s.root, { title: 'Pick B', text: 'x' }, human);
    const decided = await s.run();
    expect(decided.input).toContain('D-0001 Pick B');
  });

  it('is shown again on a fresh session even when nothing changed', async () => {
    const s = setup();
    s.write('current.md', '## Now\nstep one\n');
    s.resumeable();
    await s.run();
    // No session to resume (a new conversation, or one rotated away): the bot has not seen it.
    s.repos.saveSession(s.bot.id, s.room.id, { sdkSessionId: null, provider: 'claude' });
    const fresh = await s.run();
    expect(fresh.input).toContain('step one');
  });
});

describe('state header pieces', () => {
  it('parses the decision headings appendDecision writes', () => {
    const s = setup();
    s.revisions.appendDecision(s.root, { title: 'First · with a dot', text: 'a' }, human);
    s.revisions.appendDecision(s.root, { title: 'Second', text: 'b', supersedes: ['D-0001'] }, human);
    const text = fs.readFileSync(path.join(s.root.dir, 'decisions.md'), 'utf8');
    const ds = parseDecisions(text);
    expect(ds.map((d) => [d.id, d.title, d.by])).toEqual([
      ['D-0001', 'First · with a dot', 'Alex via Claude Code (app)'],
      ['D-0002', 'Second', 'Alex via Claude Code (app)'],
    ]);
    expect(ds[0].at).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it('takes the Now section, else the first lines, capped', () => {
    expect(currentExcerpt('# T\n\n## Now\nA\nB\n\n## Next\nC\n')).toBe('## Now\nA\nB');
    expect(currentExcerpt('# T\nline\n')).toBe('# T\nline');
    const many = Array.from({ length: 80 }, (_, i) => 'l' + i).join('\n');
    expect(currentExcerpt(many).split('\n')).toHaveLength(30);
    expect(currentExcerpt('x'.repeat(5000)).length).toBeLessThanOrEqual(1504);
  });

  it('builds nothing for an empty folder and changes its signature with either file', () => {
    const s = setup();
    expect(buildStateHeader(s.root, s.revisions)).toBeNull();
    s.write('current.md', 'a');
    const a = buildStateHeader(s.root, s.revisions)!;
    s.revisions.appendDecision(s.root, { title: 'T', text: 'x' }, human);
    const b = buildStateHeader(s.root, s.revisions)!;
    expect(b.signature).not.toBe(a.signature);
    expect(b.text.length).toBeLessThan(2048);
  });
});
