import { describe, expect, it } from 'vitest';
import type { ProviderLimitState, ProvidersResponse } from '@pocketrocket/shared';
import { activeLimits, allOnClaude, heldGroups, heldLimitFor, limitName, limitPercent, planMeters, resetPhrase } from './limits';

const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const HOUR = 3600_000;
const lim = (p: Partial<ProviderLimitState>): ProviderLimitState => ({ provider: 'claude', status: 'held', kind: 'usage', until: NOW + HOUR, at: NOW, ...p });
const providers = (auth: Record<string, 'subscription' | 'apiKey'>): ProvidersResponse => ({
  active: 'claude',
  providers: Object.entries(auth).map(([id, a]) => ({ id, label: id === 'claude' ? 'Claude' : 'Codex', check: { ok: true, auth: a }, models: [] }) as unknown as ProvidersResponse['providers'][number]),
});

describe('provider limits', () => {
  it('drops entries past until (no WS event says so)', () => {
    expect(activeLimits([lim({ until: NOW - 1 }), lim({ until: NOW + 1 })], NOW)).toHaveLength(1);
  });

  it('names the window and reads utilization as 0..1 or as a percent', () => {
    expect(limitName(lim({ window: 'five_hour' }), 'Claude')).toBe('Claude 5-hour limit');
    expect(limitName(lim({ window: 'something_new' }), 'Claude')).toBe('Claude usage limit');
    expect(limitPercent(lim({ status: 'warning', utilization: 0.82 }))).toBe(82);
    expect(limitPercent(lim({ status: 'warning', utilization: 82 }))).toBe(82);
    expect(limitPercent(lim({ status: 'held' }))).toBe(100);
  });

  it('says the reset time, or nothing when the provider gave none', () => {
    expect(resetPhrase(lim({ resetsAt: NOW + 2 * HOUR }), NOW)).toMatch(/^resets \d{1,2}:00/);
    expect(resetPhrase(lim({}), NOW)).toBeNull();
  });

  it('finds the hold that stops a bot: its own provider, or the default when it follows it', () => {
    const limits = [lim({ provider: 'claude', model: 'claude-opus-4-1', until: NOW + 5 * HOUR }), lim({ provider: 'codex' })];
    expect(heldLimitFor({ provider: null, model: 'claude-opus-4-1' }, 'claude', limits)?.until).toBe(NOW + 5 * HOUR);
    expect(heldLimitFor({ provider: null, model: 'claude-sonnet-4-5' }, 'claude', limits)).toBeNull();
    expect(heldLimitFor({ provider: 'codex', model: 'gpt-5' }, 'claude', limits)?.provider).toBe('codex');
    expect(heldLimitFor({ provider: 'claude', model: 'x' }, 'claude', [lim({ status: 'warning' })])).toBeNull();
  });

  it('groups the bots a hold stops, and leaves out API-key logins', () => {
    const bots = [{ name: 'Ada', provider: null, model: 'm' }, { name: 'Dev', provider: 'claude' as const, model: 'm' }, { name: 'Cody', provider: 'codex' as const, model: 'm' }];
    const limits = [lim({ provider: 'claude' }), lim({ provider: 'codex' })];
    const groups = heldGroups(bots, 'claude', limits, providers({ claude: 'subscription', codex: 'apiKey' }));
    expect(groups).toHaveLength(1);
    expect(groups[0].bots.map((b) => b.name)).toEqual(['Ada', 'Dev']);
  });

  it('shows the model picker only while every member runs on Claude', () => {
    expect(allOnClaude([{ provider: null }, { provider: 'claude' }], 'claude')).toBe(true);
    expect(allOnClaude([{ provider: null }, { provider: 'codex' }], 'claude')).toBe(false);
    expect(allOnClaude([{ provider: null }], 'codex')).toBe(false);
    expect(allOnClaude([], 'codex')).toBe(true);
  });

  it('meters plan windows only: no figure-less warnings, no API-key logins', () => {
    const p = providers({ claude: 'subscription', codex: 'apiKey' });
    const shown = planMeters([lim({ status: 'warning', utilization: 0.8 }), lim({ status: 'warning' }), lim({ kind: 'overloaded' }), lim({ provider: 'codex' }), lim({})], p);
    expect(shown).toHaveLength(2);
  });
});
