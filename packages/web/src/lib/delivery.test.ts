import { describe, expect, it } from 'vitest';
import type { Message, ProvidersResponse } from '@pocketrocket/shared';
import { canSteer, deliveryLines, deliveryOf, earlierTurns, sendKey, showSendChoice } from './delivery';

const bots = [{ id: 'ada', name: 'Ada' }, { id: 'bo', name: 'Bo' }];
const texts = (p: Parameters<typeof deliveryLines>[0], label: string | null = null) => deliveryLines(p, bots, label).map((l) => l.text);

describe('deliveryLines: the status line under the bubble', () => {
  it('says a steered message joined the reply', () => {
    expect(texts({ steered: { ada: 't1' } })).toEqual(["Joined Ada's reply"]);
  });

  it('words each queue reason', () => {
    expect(texts({ queued: { ada: { reason: 'shortcut' } } })).toEqual(["Queued for after Ada's reply"]);
    expect(texts({ queued: { ada: { reason: 'setting' } } })).toEqual(["Queued for after Ada's reply"]);
    expect(texts({ queued: { ada: { reason: 'provider' } } }, 'Gemini')).toEqual(["Queued: Gemini can't take messages mid-task"]);
    expect(texts({ queued: { ada: { reason: 'between-runs' } } })).toEqual(['Queued: Ada was between steps']);
    expect(texts({ queued: { ada: { reason: 'requeued' } } })).toEqual(['Queued: Ada answers this next']);
  });

  it('names the bot for the provider reason when the provider is unknown', () => {
    expect(texts({ queued: { ada: { reason: 'provider' } } })).toEqual(["Queued: Ada can't take messages mid-task"]);
  });

  it('never claims a reason it does not know', () => {
    expect(texts({ queued: { ada: { reason: 'something-new' as never } } })).toEqual(["Queued for after Ada's reply"]);
  });

  it('lists several bots, joined first', () => {
    expect(texts({ queued: { bo: { reason: 'provider' } }, steered: { ada: 't1' } }, 'Gemini'))
      .toEqual(["Joined Ada's reply", "Queued: Gemini can't take messages mid-task"]);
  });

  it('reads a bot both steered and queued (a requeue) as queued only', () => {
    expect(texts({ steered: { ada: 't1' }, queued: { ada: { reason: 'requeued' } } })).toEqual(['Queued: Ada answers this next']);
  });
});

describe('deliveryOf', () => {
  const msg = (payload: unknown, authorType: Message['authorType'] = 'user') => ({ authorType, payload: payload as Message['payload'] });
  it('finds a delivery on a person\'s message only', () => {
    expect(deliveryOf(msg({ steered: { ada: 't1' } }))).toEqual({ steered: { ada: 't1' } });
    expect(deliveryOf(msg({ steered: { ada: 't1' } }, 'bot'))).toBeNull();
  });
  it('is null when every target was idle or there is no payload', () => {
    expect(deliveryOf(msg(null))).toBeNull();
    expect(deliveryOf(msg({}))).toBeNull();
    expect(deliveryOf(msg({ steered: {}, queued: {} }))).toBeNull();
  });
});

describe('sendKey: what the composer sends on a key press', () => {
  const k = (over: Partial<Parameters<typeof sendKey>[0]>) => sendKey({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });
  it('Enter sends with no mode, so the hub setting decides', () => {
    expect(k({})).toEqual({});
  });
  it('Ctrl+Enter (and Cmd+Enter) queues', () => {
    expect(k({ ctrlKey: true })).toEqual({ mode: 'queue' });
    expect(k({ metaKey: true })).toEqual({ mode: 'queue' });
  });
  it('Shift+Enter is a new line and Alt+Enter belongs to the desktop full-screen toggle', () => {
    expect(k({ shiftKey: true })).toBeNull();
    expect(k({ altKey: true })).toBeNull();
    expect(k({ key: 'a' })).toBeNull();
  });
});

describe('showSendChoice: the join/queue menu beside Send', () => {
  it('is hidden while every bot is idle', () => {
    expect(showSendChoice([], () => true)).toBe(false);
  });
  it('is hidden when the busy bots cannot steer', () => {
    expect(showSendChoice(['ada'], () => false)).toBe(false);
  });
  it('shows when a busy bot can steer', () => {
    expect(showSendChoice(['ada', 'bo'], (id) => id === 'bo')).toBe(true);
  });
});

describe('canSteer', () => {
  const providers = (steer?: boolean): ProvidersResponse => ({
    active: 'claude',
    providers: [{ id: 'claude', label: 'Claude', blurb: '', authModes: [], secretKeys: [], permissions: 'full', maturity: 'verified', check: { ok: true, auth: 'unknown' }, models: [], ...(steer === undefined ? {} : { steer }) }],
  });
  it('follows ProviderInfo.steer, and treats missing as no', () => {
    expect(canSteer(providers(true), { provider: 'claude' })).toBe(true);
    expect(canSteer(providers(false), { provider: 'claude' })).toBe(false);
    expect(canSteer(providers(), { provider: 'claude' })).toBe(false);
    expect(canSteer(null, { provider: 'claude' })).toBe(false);
  });
});

describe('earlierTurns: the "continued" work line', () => {
  it('marks a turn that already showed in an earlier group', () => {
    const groups = [{ items: [{ turnId: 't1' }] }, { items: [{ turnId: null }] }, { items: [{ turnId: 't1' }, { turnId: 't2' }] }];
    const seen = earlierTurns(groups);
    expect(seen[0].has('t1')).toBe(false);
    expect(seen[2].has('t1')).toBe(true);
    expect(seen[2].has('t2')).toBe(false);
  });
});
