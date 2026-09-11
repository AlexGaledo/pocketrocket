import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { PROVIDER_IDS, type ModelInfo, type ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SettingsRejected, SettingsStore } from './SettingsStore.js';

const MODELS: Record<ProviderId, ModelInfo[]> = {
  claude: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', default: true }, { id: 'claude-opus-5', label: 'Opus 5' }],
  codex: [{ id: 'test-model-x', label: 'Codex', default: true }],
  opencode: [],
  grok: [{ id: 'grok-code-fast-1', label: 'Grok', default: true }],
};

// The switching tests exercise the repoint path across every adapter, so they enable them all.
const ALL = PROVIDER_IDS;

function store() {
  const repos = new Repos(new Db(':memory:'));
  return { repos, settings: new SettingsStore({ repos, enabled: ALL, models: (p) => MODELS[p] }) };
}

describe('SettingsStore', () => {
  it('returns defaults with the OS user name', () => {
    const { settings } = store();
    const s = settings.get();
    expect(s.provider).toBe('claude');
    expect(s.onboarded).toBe(false);
    expect(s.sounds).toBe(true);
    expect(s.userName).toBe(os.userInfo().username);
  });

  it('persists a patch and re-reads it from the table', () => {
    const { repos, settings } = store();
    const next = settings.patch({ userName: 'Alex', sounds: false, onboarded: true });
    expect(next.userName).toBe('Alex');
    expect(next.sounds).toBe(false);
    const fresh = new SettingsStore({ repos });
    expect(fresh.get()).toMatchObject({ userName: 'Alex', sounds: false, onboarded: true, provider: 'claude' });
  });

  it('rejects an invalid patch', () => {
    const { settings } = store();
    expect(() => settings.patch({ provider: 'nope' as ProviderId })).toThrow();
    expect(settings.get().provider).toBe('claude');
  });

  it('repoints bots whose model the new provider does not offer', () => {
    const { repos, settings } = store();
    const keep = repos.createBot({ name: 'Keep', handle: 'keep', title: '', description: '', avatar: '🤖', model: 'test-model-x', allowedTools: [], maxBudgetUsd: 1 });
    const move = repos.createBot({ name: 'Move', handle: 'move', title: '', description: '', avatar: '🤖', model: 'claude-opus-5', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [move.id], coordinatorBotId: null });

    settings.patch({ provider: 'codex' });

    expect(repos.getBot(move.id)!.model).toBe('test-model-x');
    expect(repos.getBot(keep.id)!.model).toBe('test-model-x');
    const sys = repos.listMessages(room.id, { limit: 10 }).filter((m) => m.kind === 'system');
    expect(sys.length).toBe(1);
    expect(sys[0].text).toContain('test-model-x');
  });

  it('leaves models alone when the new provider publishes no list', () => {
    const { repos, settings } = store();
    const bot = repos.createBot({ name: 'B', handle: 'b', title: '', description: '', avatar: '🤖', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });
    settings.patch({ provider: 'opencode' });
    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');
  });

  it('repoints once a cold model cache resolves', async () => {
    // OpenCode's list comes from `opencode models`, so modelsSync answers empty right after startup.
    const repos = new Repos(new Db(':memory:'));
    const late: ModelInfo[] = [{ id: 'anthropic/claude-sonnet-4', label: 'Sonnet', default: true }];
    const settings = new SettingsStore({
      repos,
      enabled: ALL,
      models: (p) => MODELS[p],
      modelsAsync: async (p) => (p === 'opencode' ? late : MODELS[p]),
    });
    const bot = repos.createBot({ name: 'B', handle: 'b', title: '', description: '', avatar: '🤖', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });

    settings.patch({ provider: 'opencode' });
    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');

    await vi.waitFor(() => expect(repos.getBot(bot.id)!.model).toBe('anthropic/claude-sonnet-4'));
    const sys = repos.listMessages(room.id, { limit: 10 }).filter((m) => m.kind === 'system');
    expect(sys[0].text).toContain('anthropic/claude-sonnet-4');
  });

  it('does not repoint for a provider that was switched away from while the list loaded', async () => {
    const repos = new Repos(new Db(':memory:'));
    let release: (m: ModelInfo[]) => void = () => {};
    const settings = new SettingsStore({
      repos,
      enabled: ALL,
      models: (p) => MODELS[p],
      modelsAsync: (p) => (p === 'opencode' ? new Promise<ModelInfo[]>((r) => { release = r; }) : Promise.resolve(MODELS[p])),
    });
    const bot = repos.createBot({ name: 'B', handle: 'b', title: '', description: '', avatar: '🤖', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });

    settings.patch({ provider: 'opencode' });
    settings.patch({ provider: 'claude' });   // back before the slow list lands
    release([{ id: 'anthropic/claude-sonnet-4', label: 'Sonnet', default: true }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');
  });
});

describe('SettingsStore with only Claude enabled (the v1 default)', () => {
  function claudeOnly(repos = new Repos(new Db(':memory:'))) {
    return { repos, settings: new SettingsStore({ repos, enabled: ['claude'], models: (p) => MODELS[p] }) };
  }

  it('rejects switching to a disabled provider and keeps the current one', () => {
    const { settings } = claudeOnly();
    expect(() => settings.patch({ provider: 'codex' })).toThrow(SettingsRejected);
    expect(settings.get().provider).toBe('claude');
  });

  it('moves an existing install off a disabled provider through the normal repoint path', () => {
    const repos = new Repos(new Db(':memory:'));
    repos.setSetting('provider', 'codex');
    repos.setSetting('defaultModel', 'test-model-x');
    const bot = repos.createBot({ name: 'Old', handle: 'old', title: '', description: '', avatar: '🤖', model: 'test-model-x', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const { settings } = claudeOnly(repos);

    settings.ensureEnabledProvider();

    expect(settings.get()).toMatchObject({ provider: 'claude', defaultModel: 'claude-sonnet-5' });
    expect(new SettingsStore({ repos, enabled: ['claude'] }).get().provider).toBe('claude');
    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');
    const sys = repos.listMessages(room.id, { limit: 10 }).filter((m) => m.kind === 'system');
    expect(sys.length).toBe(1);
    expect(sys[0].text).toContain('test-model-x is not available on claude');
  });

  it('leaves an install already on an enabled provider alone', () => {
    const { repos, settings } = claudeOnly();
    const bot = repos.createBot({ name: 'B', handle: 'b', title: '', description: '', avatar: '🤖', model: 'claude-opus-5', allowedTools: [], maxBudgetUsd: 1 });
    settings.patch({ defaultModel: 'claude-opus-5' });
    settings.ensureEnabledProvider();
    expect(settings.get().defaultModel).toBe('claude-opus-5');
    expect(repos.getBot(bot.id)!.model).toBe('claude-opus-5');
  });
});
