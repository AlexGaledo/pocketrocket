import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner, isStaleSessionError } from './BotRunner.js';

/**
 * The CLI owns its session store, not the hub. When the transcript our `sessions` row points at is gone
 * (re-login, cleanup sweep, redeploy) every turn in that room used to die with "No conversation found with
 * session ID" until someone nulled the row by hand. Now the runner forgets the token and reruns the same
 * input once from a fresh session. Seen live on the VPS on 2026-09-10.
 */

const STALE = 'error_during_execution: No conversation found with session ID: d226bdfb-a2c2-41dd-9b7c-6f97600565fb';

class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Scripted';
  readonly info = { id: 'claude' as ProviderId, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  constructor(private script: Array<Partial<TurnOutcome>>) {}
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    const step = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    // A run that failed to resume never reports a session; a fresh one does.
    if (!step.error) sink.onSession('fresh-' + this.seen.length);
    return { ok: step.ok ?? false, error: step.error, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

function setup(script: Array<Partial<TurnOutcome>>, savedSession: string | null) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Smoke', handle: 'smoke', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  if (savedSession) repos.saveSession(bot.id, room.id, { sdkSessionId: savedSession, provider: 'claude' });
  const provider = new ScriptedProvider(script);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos),
    new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined },
    providers, new TurnRegistry(),
  );
  return { repos, bot, room, provider, runner };
}

const run = (s: ReturnType<typeof setup>) =>
  s.runner.runTurn({ bot: s.bot, room: s.room, members: [s.bot], injected: 'Reply with exactly: pong', hop: 0, causeId: 'c1' } as never);

describe('a resume against a vanished session is retried fresh', () => {
  it('recognises the CLI wording and nothing else', () => {
    expect(isStaleSessionError(STALE)).toBe(true);
    expect(isStaleSessionError('error_during_execution')).toBe(false);
    expect(isStaleSessionError('error_max_turns')).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });

  it('drops the dead token, reruns the same input without it, and stores the new session', async () => {
    const s = setup([{ error: STALE }, { ok: true }], 'd226bdfb-a2c2-41dd-9b7c-6f97600565fb');
    const r = await run(s);

    expect(s.provider.seen).toHaveLength(2);
    expect(s.provider.seen[0].resumeToken).toBe('d226bdfb-a2c2-41dd-9b7c-6f97600565fb');
    expect(s.provider.seen[1].resumeToken).toBeNull();
    expect(s.provider.seen[1].input).toBe('Reply with exactly: pong');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(s.repos.getSession(s.bot.id, s.room.id, 'claude').sdkSessionId).toBe('fresh-2');
    const notes = s.repos.listMessages(s.room.id, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text ?? '');
    expect(notes.some((t) => t.includes('saved session no longer exists'))).toBe(true);
  });

  it('retries only once: a second stale failure is reported, not looped', async () => {
    const s = setup([{ error: STALE }], 'd226bdfb-a2c2-41dd-9b7c-6f97600565fb');
    const r = await run(s);

    expect(s.provider.seen).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(STALE);
  });

  it('does not retry when there was no token to blame', async () => {
    const s = setup([{ error: STALE }], null);
    const r = await run(s);

    expect(s.provider.seen).toHaveLength(1);
    expect(r.error).toBe(STALE);
  });
});
