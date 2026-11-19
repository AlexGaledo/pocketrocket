import { describe, expect, it } from 'vitest';
import type { ProviderLimitState } from '@pocketrocket/shared';
import { DEFAULT_HOLD_MS, ProviderHealth, limitModel } from './ProviderHealth.js';

/** M5 (spec 01 P0-2): in-memory holds per (provider, model?) until the reset, on a fake clock. */
function setup() {
  let t = 1_000_000;
  const changes: ProviderLimitState[][] = [];
  const health = new ProviderHealth({ now: () => t, onChange: (l) => changes.push(l) });
  return { health, changes, advance: (ms: number) => (t += ms), now: () => t };
}

describe('ProviderHealth', () => {
  it('holds a provider until resetsAt, then clears it', () => {
    const s = setup();
    const resetsAt = s.now() + 3_600_000;
    s.health.hold('claude', { kind: 'usage', resetsAt, window: 'five_hour' }, 'claude-sonnet-5');
    expect(s.health.isHeld('claude')).toBe(true);
    expect(s.health.isHeld('claude', 'claude-opus-5')).toBe(true); // a whole-login window covers every model
    expect(s.health.list()).toEqual([
      { provider: 'claude', status: 'held', kind: 'usage', window: 'five_hour', resetsAt, until: resetsAt, at: s.now() },
    ]);
    expect(s.changes).toHaveLength(1);
    s.advance(3_600_000 - 1);
    expect(s.health.isHeld('claude')).toBe(true);
    s.advance(1);
    expect(s.health.isHeld('claude')).toBe(false);
    expect(s.health.list()).toEqual([]);
  });

  it('holds only the model a model-specific window covers', () => {
    const s = setup();
    s.health.hold('claude', { kind: 'usage', resetsAt: s.now() + 1000, window: 'seven_day_opus' }, 'claude-opus-5');
    expect(s.health.isHeld('claude', 'claude-opus-5')).toBe(true);
    expect(s.health.isHeld('claude', 'claude-sonnet-5')).toBe(false);
    expect(s.health.list()[0].model).toBe('claude-opus-5');
    expect(limitModel('seven_day_opus', 'claude-sonnet-5')).toBeUndefined();
    expect(limitModel('five_hour', 'claude-opus-5')).toBeUndefined();
  });

  it('holds a limit with no reset time for the default, and only usage limits at all', () => {
    const s = setup();
    s.health.hold('claude', { kind: 'overloaded' });
    s.health.hold('claude', { kind: 'auth' });
    expect(s.health.list()).toEqual([]);
    s.health.hold('claude', { kind: 'usage' });
    expect(s.health.list()[0].until).toBe(s.now() + DEFAULT_HOLD_MS);
    s.advance(DEFAULT_HOLD_MS);
    expect(s.health.isHeld('claude')).toBe(false);
  });

  it('a past resetsAt does not make an entry that is already over', () => {
    const s = setup();
    s.health.hold('claude', { kind: 'usage', resetsAt: s.now() - 5 });
    expect(s.health.isHeld('claude')).toBe(true);
  });

  it('records warnings with utilization, which never hold and never replace a hold', () => {
    const s = setup();
    const resetsAt = s.now() + 60_000;
    s.health.report('claude', { status: 'allowed_warning', kind: 'usage', window: 'five_hour', resetsAt, utilization: 0.82 }, 'claude-sonnet-5');
    expect(s.health.isHeld('claude')).toBe(false);
    expect(s.health.list()).toMatchObject([{ status: 'warning', utilization: 0.82, until: resetsAt }]);

    s.health.report('claude', { status: 'rejected', kind: 'usage', window: 'five_hour', resetsAt, utilization: 1 }, 'claude-sonnet-5');
    expect(s.health.isHeld('claude')).toBe(true);
    s.health.report('claude', { status: 'allowed_warning', kind: 'usage', window: 'five_hour', resetsAt, utilization: 0.9 }, 'claude-sonnet-5');
    expect(s.health.list()).toMatchObject([{ status: 'held', utilization: 1 }]);
  });

  it('an allowed report ends that window early and says so', () => {
    const s = setup();
    s.health.report('claude', { status: 'rejected', kind: 'usage', window: 'five_hour', resetsAt: s.now() + 60_000 });
    const before = s.changes.length;
    s.health.report('claude', { status: 'allowed', kind: 'usage', window: 'five_hour' });
    expect(s.health.isHeld('claude')).toBe(false);
    expect(s.changes).toHaveLength(before + 1);
    expect(s.changes.at(-1)).toEqual([]);
    // Nothing to clear: no event.
    s.health.report('claude', { status: 'allowed', kind: 'usage', window: 'five_hour' });
    expect(s.changes).toHaveLength(before + 1);
  });

  it('keeps providers apart and lists the soonest reset first', () => {
    const s = setup();
    s.health.hold('codex', { kind: 'usage', resetsAt: s.now() + 5000 });
    s.health.hold('claude', { kind: 'usage', resetsAt: s.now() + 1000, window: 'five_hour' });
    expect(s.health.list().map((l) => l.provider)).toEqual(['claude', 'codex']);
    expect(s.health.heldFor('opencode')).toBeUndefined();
  });

  it('is in memory only: a new instance (a restart) starts empty', () => {
    const s = setup();
    s.health.hold('claude', { kind: 'usage', resetsAt: s.now() + 1000 });
    expect(new ProviderHealth({ now: s.now }).list()).toEqual([]);
  });
});
