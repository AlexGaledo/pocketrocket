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
import { BotRunner, narrationNote } from './BotRunner.js';

/**
 * A bot driving a browser test used to post every "Let's click X…" line between tool calls as its own room
 * message (seen live in the Wika room, 2026-11-09: a dozen narration posts in one turn). Text followed by a
 * tool call is narration and becomes a status note; only text with nothing after it is posted.
 */

type Step = { text: string } | { tool: string };

class NarratingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Narrating';
  readonly info = { id: 'claude' as ProviderId, label: 'Narrating', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  constructor(private steps: Step[]) {}
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(_ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    sink.onSession('s1');
    let n = 0;
    for (const s of this.steps) {
      if ('text' in s) sink.onText(s.text);
      else {
        const id = 't' + n++;
        sink.onToolUse(id, s.tool, {});
        sink.onToolResult(id, 'ok', false);
      }
    }
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

function setup(steps: Step[]) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Designer', handle: 'designer', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const other = repos.createBot({ name: 'Lead', handle: 'lead', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'group', name: 'G', memberIds: [bot.id, other.id], coordinatorBotId: null });
  const notes: string[] = [];
  const provider = new NarratingProvider(steps);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos),
    new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: (_b, _r, _s, note) => { if (note) notes.push(note); } },
    providers, new TurnRegistry(),
  );
  const run = () => runner.runTurn({ bot, room, members: [bot, other], injected: 'go', hop: 0, causeId: 'c1' } as never);
  const texts = () => repos.messagesAfter(room.id, 0).filter((m) => m.kind === 'text').map((m) => m.text);
  return { run, texts, notes };
}

describe('narration between tool calls is not posted to the room', () => {
  it('posts only the text after the last tool call; earlier lines become status notes', async () => {
    const s = setup([
      { text: "Server's running. Let me resize the tab and take a screenshot." },
      { tool: 'mcp__browser__browser_resize' },
      { text: "Let's click the mascot to test the tap interaction, @lead." },
      { tool: 'mcp__browser__browser_click' },
      { text: 'Booth layout done: mascot left, tiles right, QR strip at the bottom.' },
    ]);
    const r = await s.run();
    expect(s.texts()).toEqual(['Booth layout done: mascot left, tiles right, QR strip at the bottom.']);
    // finalText drives @mention routing: narration naming @lead must not wake it.
    expect(r.finalText).toBe('Booth layout done: mascot left, tiles right, QR strip at the bottom.');
    expect(s.notes).toContain("Server's running. Let me resize the tab and take a screenshot.");
  });

  it('keeps consecutive reply blocks together as one message', async () => {
    const s = setup([{ tool: 'Read' }, { text: 'Part one.' }, { text: 'Part two.' }]);
    await s.run();
    expect(s.texts()).toEqual(['Part one.\n\nPart two.']);
  });

  it('NO_REPLY drops held text too', async () => {
    const s = setup([{ text: 'Thinking about it…' }, { text: 'NO_REPLY' }]);
    const r = await s.run();
    expect(s.texts()).toEqual([]);
    expect(r.finalText).toBe('');
  });

  it('a turn with no tools still posts its reply', async () => {
    const s = setup([{ text: 'pong' }]);
    await s.run();
    expect(s.texts()).toEqual(['pong']);
  });

  it('caps the status note to one short line', () => {
    expect(narrationNote('  first line\nsecond')).toBe('first line');
    expect(narrationNote('x'.repeat(300))).toHaveLength(140);
  });
});
