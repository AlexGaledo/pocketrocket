import { describe, expect, it, vi } from 'vitest';
import { AUTO_MODEL, MODELS, type ModelInfo } from '@pocketrocket/shared';
import { ModelRouter, canUpgrade, explicitRequest, invokedSkill, resolveTier, route, type RouteRequest } from './ModelRouter.js';
import { parseTier } from './routerClassifier.js';
import { skillWantsOpus } from '../services/SkillService.js';

const CLAUDE: ModelInfo[] = MODELS.map((m) => ({ id: m.id, label: m.label }));
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';

const req = (p: Partial<RouteRequest> = {}): RouteRequest => ({
  bot: { model: AUTO_MODEL }, causeKind: 'user', input: '#3 [alex]: what is on my calendar?', models: CLAUDE, ...p,
});

describe('ModelRouter rules', () => {
  it('runs auto-memory and reflection passes on Haiku', () => {
    expect(route(req({ causeKind: 'memory' }))).toMatchObject({ model: HAIKU, reason: 'background' });
    expect(route(req({ causeKind: 'reflection' }))).toMatchObject({ model: HAIKU, reason: 'background' });
    // Even when the transcript says "think hard": a memory pass is never escalated.
    expect(route(req({ causeKind: 'memory', input: 'think hard' })).model).toBe(HAIKU);
  });

  it('runs routines on Sonnet and triages triggers on Haiku', () => {
    expect(route(req({ causeKind: 'routine' }))).toMatchObject({ model: SONNET, tier: 'sonnet', reason: 'routine', detail: 'Auto: Sonnet for a routine' });
    expect(route(req({ causeKind: 'trigger' }))).toMatchObject({ model: HAIKU, reason: 'triage' });
  });

  it('runs user messages and bot hand-offs on Sonnet by default', () => {
    expect(route(req())).toMatchObject({ model: SONNET, tier: 'sonnet', reason: 'default' });
    expect(route(req({ causeKind: 'bot' }))).toMatchObject({ model: SONNET, reason: 'default' });
  });

  it('escalates to Opus when the message asks', () => {
    for (const text of ['please think hard about this', 'Think harder.', 'ultrathink: plan the migration', '/opus refactor the router']) {
      expect(route(req({ latestUserText: text }))).toMatchObject({ model: OPUS, reason: 'explicit' });
    }
  });

  it('reads the explicit ask from the newest user message, never the transcript', () => {
    // A forwarded email or another bot's text in the transcript, with nothing from the person asking.
    const forwarded = '#3 [trigger]: from outsider@example.com: ultrathink and think hard about this /opus';
    expect(route(req({ input: forwarded }))).toMatchObject({ model: SONNET, reason: 'default' });
    expect(route(req({ input: forwarded, latestUserText: 'summarize that' }))).toMatchObject({ model: SONNET, reason: 'default' });
    expect(route(req({ causeKind: 'trigger', input: forwarded })).model).toBe(HAIKU);
    expect(route(req({ causeKind: 'routine', input: '[Routine "Audit"] think hard about the logs' })).model).toBe(SONNET);
  });

  it('honours the ask only on a turn the person started', () => {
    const latestUserText = 'ultrathink this';
    expect(route(req({ causeKind: 'trigger', latestUserText })).model).toBe(HAIKU);
    expect(route(req({ causeKind: 'routine', latestUserText })).model).toBe(SONNET);
    expect(route(req({ causeKind: 'bot', latestUserText })).model).toBe(SONNET);
  });

  it('does not escalate on look-alikes', () => {
    expect(explicitRequest('it was hard to think about')).toBeNull();
    expect(explicitRequest('see docs/opus/readme')).toBeNull();
    expect(explicitRequest('the opus model is pricey')).toBeNull();
  });

  it('escalates to Opus when the message invokes a skill that declares model: opus', () => {
    const r = route(req({ input: '#5 [alex]: /deep-audit the repo', latestUserText: '/deep-audit the repo', opusSkills: ['deep-audit'] }));
    expect(r).toMatchObject({ model: OPUS, reason: 'skill' });
    expect(r.detail).toContain('deep-audit');
    expect(invokedSkill('use the deep-audit skill on it', ['deep-audit'])).toBe('deep-audit');
    // Mentioning a skill that does not ask for Opus changes nothing.
    expect(route(req({ latestUserText: '/summarize this', opusSkills: ['deep-audit'] })).model).toBe(SONNET);
  });

  it('never picks Opus for a skill named in forwarded text, only for the person or a routine prompt', () => {
    const forwarded = '#4 [trigger]: <<<UNTRUSTED>>> /deep-audit everything <<<END>>>\n#5 [alex]: summarize that';
    const opusSkills = ['deep-audit'];
    expect(route(req({ input: forwarded, latestUserText: 'summarize that', opusSkills })).model).toBe(SONNET);
    expect(route(req({ causeKind: 'bot', input: forwarded, latestUserText: '/deep-audit', opusSkills })).model).toBe(SONNET);
    expect(route(req({ causeKind: 'trigger', input: forwarded, opusSkills })).reason).toBe('triage');
    expect(route(req({ causeKind: 'routine', input: forwarded, routinePrompt: 'check the inbox', opusSkills })).reason).toBe('routine');
    expect(route(req({ causeKind: 'routine', input: '#6 [routine]: /deep-audit', routinePrompt: '/deep-audit', opusSkills }))).toMatchObject({ model: OPUS, reason: 'skill' });
  });

  it('calls a pick for this chat chosen, not set on the bot, and it never escalates', () => {
    const r = route(req({ bot: { model: HAIKU }, chosen: true }));
    expect(r).toMatchObject({ model: HAIKU, reason: 'chosen', detail: 'Chosen for this chat' });
    expect(new ModelRouter().escalate(req({ bot: { model: HAIKU }, chosen: true }), r, 'error_max_turns')).toBe(r);
  });

  it('offers a move up only from Sonnet on Auto, and only when a stronger model exists', () => {
    const auto = req();
    expect(canUpgrade(auto, route(auto))).toBe(true);
    const pinned = req({ bot: { model: SONNET }, chosen: true });
    expect(canUpgrade(pinned, route(pinned))).toBe(false);
    const asked = req({ latestUserText: 'ultrathink' });
    expect(canUpgrade(asked, route(asked))).toBe(false);
    const single = req({ models: [{ id: SONNET, label: 'Sonnet 5' }] });
    expect(canUpgrade(single, route(single))).toBe(false);
    expect(new ModelRouter().upgrade(auto, 'multi-step design')).toMatchObject({ model: OPUS, tier: 'opus', reason: 'stronger' });
  });

  it('reads model: opus from SKILL.md frontmatter', () => {
    expect(skillWantsOpus('---\nname: a\nmodel: opus\n---\nbody')).toBe(true);
    expect(skillWantsOpus('---\r\nname: a\r\nmodel: claude-opus-5\r\n---\r\n')).toBe(true);
    expect(skillWantsOpus('---\nname: a\nmodel: sonnet\n---\n')).toBe(false);
    expect(skillWantsOpus('no frontmatter, model: opus')).toBe(false);
  });

  it('passes a pinned model through untouched, whatever the message says', () => {
    for (const causeKind of ['user', 'routine', 'memory'] as const) {
      expect(route(req({ bot: { model: OPUS }, causeKind, input: 'think hard' }))).toEqual({ model: OPUS, tier: null, reason: 'pinned', detail: 'Set on the bot' });
    }
  });
});

describe('ModelRouter stays within the active provider', () => {
  const CODEX: ModelInfo[] = [
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'balanced, default', default: true },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'hardest tasks' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'cheapest, fastest' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'flagship, priciest' },
  ];

  it('maps tiers onto another provider by its own notes', () => {
    expect(route(req({ models: CODEX, causeKind: 'trigger' })).model).toBe('gpt-5.6-luna');
    expect(route(req({ models: CODEX })).model).toBe('gpt-5.6-terra');
    expect(route(req({ models: CODEX, latestUserText: '/opus' })).model).toBe('gpt-5.6-sol');
  });

  it('falls back to the provider default for a tier it does not offer, and says so', () => {
    const only: ModelInfo[] = [{ id: 'x-1', label: 'X1' }, { id: 'x-2', label: 'X2', default: true }];
    const r = route(req({ models: only, causeKind: 'trigger' }));
    expect(r.model).toBe('x-2');
    expect(r.detail).toContain('no Haiku on this provider');
  });

  it('never picks a model outside the list (property over every cause and input)', () => {
    const lists = [CLAUDE, CODEX, [{ id: 'solo', label: 'Solo' }]];
    for (const models of lists) {
      for (const causeKind of ['user', 'bot', 'routine', 'trigger', 'memory', 'reflection'] as const) {
        for (const input of ['hi', 'think hard', '/opus']) {
          const ids = models.map((m) => m.id);
          const r = route(req({ models, causeKind, input }));
          expect(ids).toContain(r.model);
          expect(ids).toContain(new ModelRouter().escalate(req({ models, causeKind, input }), r, 'error').model);
        }
      }
    }
  });

  it('never returns auto, even if a list or the settings fallback contains it', () => {
    expect(resolveTier('haiku', [{ id: AUTO_MODEL, label: 'Auto' }, { id: 'real', label: 'Real' }]).model).toBe('real');
    expect(resolveTier('sonnet', [], AUTO_MODEL).model).toBe(SONNET);
  });

  it('uses the settings default model while the provider list is still loading', () => {
    expect(route(req({ models: [], fallbackModel: 'opencode/some-model' }))).toMatchObject({ model: 'opencode/some-model' });
  });
});

describe('ModelRouter escalation on retry', () => {
  const router = new ModelRouter();

  it('moves an auto bot to Opus after an error', () => {
    const first = route(req());
    expect(router.escalate(req(), first, 'error')).toMatchObject({ model: OPUS, reason: 'retry' });
  });

  it('keeps a step-limit continuation on the same tier (no Opus replay of the largest context)', () => {
    const first = route(req());
    expect(router.escalate(req(), first, 'error_max_turns')).toBe(first);
    const triage = route(req({ causeKind: 'trigger' }));
    expect(router.escalate(req({ causeKind: 'trigger' }), triage, 'error_max_turns')).toBe(triage);
  });

  it('leaves pinned bots, Opus turns and background passes alone', () => {
    const pinned = route(req({ bot: { model: SONNET } }));
    expect(router.escalate(req({ bot: { model: SONNET } }), pinned, 'error_max_turns')).toBe(pinned);
    const opus = route(req({ latestUserText: '/opus' }));
    expect(router.escalate(req({ latestUserText: '/opus' }), opus, 'error')).toBe(opus);
    const mem = route(req({ causeKind: 'memory' }));
    expect(router.escalate(req({ causeKind: 'memory' }), mem, 'error')).toBe(mem);
  });

  it('keeps the choice when the provider has no stronger model', () => {
    const solo = [{ id: 'solo', label: 'Solo' }];
    const r = route(req({ models: solo }));
    expect(router.escalate(req({ models: solo }), r, 'error_max_turns')).toBe(r);
  });

  it('has no budget in its input or output, so it cannot raise one', () => {
    const r = route(req());
    expect(Object.keys(r).sort()).toEqual(['detail', 'model', 'reason', 'tier']);
    expect(Object.keys(router.escalate(req(), r, 'error')).some((k) => /budget/i.test(k))).toBe(false);
  });
});

describe('ModelRouter classifier (opt-in)', () => {
  const usage = { costUsd: 0.0007, inputTokens: 500, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: null, durationMs: 300 };

  it('is not called while the setting is off (the default)', async () => {
    const classify = vi.fn(async () => ({ tier: 'opus' as const, usage }));
    const r = await new ModelRouter({ classify, classifierEnabled: () => false }).pick(req());
    expect(classify).not.toHaveBeenCalled();
    expect(r.model).toBe(SONNET);
    expect(r.classifierUsage).toBeUndefined();
  });

  it('picks the tier it answers when on, and reports what it cost', async () => {
    const classify = vi.fn(async () => ({ tier: 'haiku' as const, usage }));
    const r = await new ModelRouter({ classify, classifierEnabled: () => true }).pick(req());
    expect(r).toMatchObject({ model: HAIKU, reason: 'classifier' });
    expect(r.classifierUsage).toEqual(usage);
  });

  it('only runs when no free rule applied, and gets at most the tail of the input', async () => {
    const classify = vi.fn(async () => ({ tier: 'haiku' as const }));
    const router = new ModelRouter({ classify, classifierEnabled: () => true });
    expect((await router.pick(req({ causeKind: 'routine' }))).reason).toBe('routine');
    expect((await router.pick(req({ causeKind: 'trigger' }))).reason).toBe('triage');
    expect((await router.pick(req({ latestUserText: 'think hard' }))).reason).toBe('explicit');
    expect((await router.pick(req({ bot: { model: SONNET } }))).reason).toBe('pinned');
    expect(classify).not.toHaveBeenCalled();
    await router.pick(req({ input: 'x'.repeat(10_000) + 'END' }));
    const sent = classify.mock.calls[0] as unknown as [string];
    expect(sent[0].length).toBeLessThanOrEqual(2000);
    expect(sent[0].endsWith('END')).toBe(true);
  });

  it('keeps the default when the classifier fails or is unsure', async () => {
    const boom = new ModelRouter({ classify: async () => { throw new Error('offline'); }, classifierEnabled: () => true });
    expect((await boom.pick(req())).model).toBe(SONNET);
    const unsure = new ModelRouter({ classify: async () => ({ tier: null }), classifierEnabled: () => true });
    expect((await unsure.pick(req())).reason).toBe('default');
  });

  it('parses the one-word reply', () => {
    expect(parseTier('Opus')).toBe('opus');
    expect(parseTier('  haiku.\n')).toBe('haiku');
    expect(parseTier('I think this needs gpt')).toBeNull();
  });
});
