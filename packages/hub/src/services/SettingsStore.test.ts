import { describe, expect, it } from 'vitest';
import os from 'node:os';
import type { ModelInfo, ProviderId } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SettingsStore } from './SettingsStore.js';

const MODELS: Record<ProviderId, ModelInfo[]> = {
  claude: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', default: true }, { id: 'claude-opus-5', label: 'Opus 5' }],
  codex: [{ id: 'gpt-5.5-codex', label: 'Codex', default: true }],
  opencode: [],
  grok: [{ id: 'grok-code-fast-1', label: 'Grok', default: true }],
};

function store() {
  const repos = new Repos(new Db(':memory:'));
  return { repos, settings: new SettingsStore({ repos, models: (p) => MODELS[p] }) };
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
    const keep = repos.createBot({ name: 'Keep', handle: 'keep', title: '', description: '', avatar: '🤖', model: 'gpt-5.5-codex', allowedTools: [], maxBudgetUsd: 1 });
    const move = repos.createBot({ name: 'Move', handle: 'move', title: '', description: '', avatar: '🤖', model: 'claude-opus-5', allowedTools: [], maxBudgetUsd: 1 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [move.id], coordinatorBotId: null });

    settings.patch({ provider: 'codex' });

    expect(repos.getBot(move.id)!.model).toBe('gpt-5.5-codex');
    expect(repos.getBot(keep.id)!.model).toBe('gpt-5.5-codex');
    const sys = repos.listMessages(room.id, { limit: 10 }).filter((m) => m.kind === 'system');
    expect(sys.length).toBe(1);
    expect(sys[0].text).toContain('gpt-5.5-codex');
  });

  it('leaves models alone when the new provider publishes no list', () => {
    const { repos, settings } = store();
    const bot = repos.createBot({ name: 'B', handle: 'b', title: '', description: '', avatar: '🤖', model: 'claude-sonnet-5', allowedTools: [], maxBudgetUsd: 1 });
    settings.patch({ provider: 'opencode' });
    expect(repos.getBot(bot.id)!.model).toBe('claude-sonnet-5');
  });
});
