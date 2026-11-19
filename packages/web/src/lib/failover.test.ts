import { describe, expect, it } from 'vitest';
import type { Bot, FailoverActive, FailoverCard, ProviderLimitState, ProvidersResponse, Room } from '@pocketrocket/shared';
import { activeFor, backupModelLabel, cardsForRoom, continueBlocker, onBackupText, providerLabel } from './failover';
import { selectInbox } from './inbox';

const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const AT_14 = new Date(2026, 10, 19, 14, 0).getTime();

const providers = {
  active: 'claude',
  providers: [
    { id: 'claude', label: 'Claude', models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet' }] },
    { id: 'gemini', label: 'Gemini', models: [{ id: 'gemini-3-pro', label: 'Gemini 3 Pro' }] },
  ],
} as unknown as ProvidersResponse;

const card = (over: Partial<FailoverCard> = {}): FailoverCard => ({
  id: 'c1', botId: 'b1', roomId: 'r1', provider: 'claude', window: 'five_hour', backup: { provider: 'gemini', model: 'gemini-3-pro' },
  resetsAt: AT_14, expiresAt: AT_14, createdAt: NOW - 60_000, status: 'pending', ...over,
});
const bot = (over: Partial<Bot> = {}) => ({ id: 'b1', name: 'Ada', backup: { provider: 'gemini', model: 'gemini-3-pro' }, ...over }) as Bot;
const room = (memberIds = ['b1']) => ({ id: 'r1', memberIds }) as Room;
const held = (over: Partial<ProviderLimitState> = {}): ProviderLimitState =>
  ({ provider: 'gemini', status: 'held', kind: 'usage', until: AT_14, at: NOW, ...over });
const ctx = (over: Partial<Parameters<typeof continueBlocker>[1]> = {}) => ({ bot: bot(), room: room(), providers, limits: [], now: NOW, ...over });

describe('continueBlocker', () => {
  it('offers Continue when nothing the hub checks is in the way', () => {
    expect(continueBlocker(card(), ctx())).toBeNull();
  });

  it('hides Continue for each 409 the page can foresee', () => {
    expect(continueBlocker(card(), ctx({ room: room([]) }))).toMatch(/no longer in this chat/);
    expect(continueBlocker(card(), ctx({ bot: undefined }))).toMatch(/no longer in this chat/);
    expect(continueBlocker(card(), ctx({ bot: bot({ backup: null }) }))).toMatch(/backup changed/);
    expect(continueBlocker(card(), ctx({ bot: bot({ backup: { provider: 'gemini', model: 'other' } }) }))).toMatch(/backup changed/);
    const noGemini = { ...providers, providers: providers.providers.filter((p) => p.id !== 'gemini') };
    expect(continueBlocker(card(), ctx({ providers: noGemini }))).toBe('gemini is not enabled on this hub.');
    expect(continueBlocker(card(), ctx({ limits: [held()] }))).toBe('Gemini is at its own limit right now.');
    expect(continueBlocker(card(), ctx({ limits: [held({ model: 'gemini-3-pro' })] }))).toMatch(/own limit/);
  });

  it('ignores holds that do not cover the backup, warnings, and holds that ended', () => {
    expect(continueBlocker(card(), ctx({ limits: [held({ provider: 'claude' })] }))).toBeNull();
    expect(continueBlocker(card(), ctx({ limits: [held({ model: 'gemini-3-flash' })] }))).toBeNull();
    expect(continueBlocker(card(), ctx({ limits: [held({ status: 'warning' })] }))).toBeNull();
    expect(continueBlocker(card(), ctx({ limits: [held({ until: NOW - 1 })] }))).toBeNull();
  });

  it('does not guess about enabled providers before the list has loaded', () => {
    expect(continueBlocker(card(), ctx({ providers: null }))).toBeNull();
  });
});

describe('on-backup badge', () => {
  const active: FailoverActive[] = [{ botId: 'b1', from: 'claude', backup: { provider: 'gemini', model: 'gemini-3-pro' }, until: AT_14 }];
  it('finds the bot while its window lasts, and words it', () => {
    const a = activeFor(active, 'b1', NOW);
    expect(a).not.toBeNull();
    expect(onBackupText(a!, providers, NOW)).toMatch(/^On Gemini until \d{1,2}:00/);
    expect(activeFor(active, 'b2', NOW)).toBeNull();
    expect(activeFor(active, 'b1', AT_14)).toBeNull();
  });
});

describe('labels and grouping', () => {
  it('falls back to ids it does not know', () => {
    expect(providerLabel(null, 'gemini')).toBe('gemini');
    expect(backupModelLabel(providers, { provider: 'gemini', model: 'gemini-3-pro' })).toBe('Gemini 3 Pro');
    expect(backupModelLabel(providers, { provider: 'gemini', model: 'x' })).toBe('x');
  });
  it('keeps one chat\'s cards, oldest first', () => {
    const list = [card({ id: 'late', createdAt: 9 }), card({ id: 'other', roomId: 'r2' }), card({ id: 'early', createdAt: 1 })];
    expect(cardsForRoom(list, 'r1').map((c) => c.id)).toEqual(['early', 'late']);
  });
});

describe('Needs you', () => {
  it('lists a limit card with the card itself on the row', () => {
    const items = selectInbox({ openApprovals: [], messages: {}, control: {}, skills: null, failoverCards: [card()] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'failover:c1', kind: 'failover', botId: 'b1', roomId: 'r1', since: NOW - 60_000 });
    expect(items[0].failoverCard?.id).toBe('c1');
  });
});
