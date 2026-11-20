import { describe, expect, it } from 'vitest';
import { RepeatFailureWatch, browserRefusal, brokenStart, escalationNote, REPEAT_COOLDOWN_MS, REPEAT_WINDOW_MS } from './repeatFailure.js';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe('browserRefusal', () => {
  it('reads the refused address from a browser tool error', () => {
    expect(browserRefusal('mcp__browser__browser_navigate', 'Error: browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9414')).toBe('ECONNREFUSED 127.0.0.1:9414');
  });
  it('ignores other tools and other errors', () => {
    expect(browserRefusal('Bash', 'curl: ECONNREFUSED 127.0.0.1:5432')).toBeNull();
    expect(browserRefusal('mcp__browser__browser_click', 'Timeout 30000ms exceeded')).toBeNull();
  });
});

describe('brokenStart', () => {
  it('escalates a broken computer, not a capacity answer', () => {
    expect(brokenStart('Its computer could not start: Unit not found')).toBe(true);
    expect(brokenStart('Its computer did not come up within 25s.')).toBe(true);
    expect(brokenStart('All 3 computers are in use or were used moments ago. Try again in a minute.')).toBe(false);
    expect(brokenStart('The server is low on memory and every running computer is in use. Try again when one is idle.')).toBe(false);
    expect(brokenStart('Its disk is full (5.0 GB of 5.0 GB).')).toBe(false);
  });
});

describe('RepeatFailureWatch', () => {
  it('fires on the 2nd identical failure, not the 1st', () => {
    const c = clock();
    const w = new RepeatFailureWatch({ now: c.now });
    expect(w.record('b1', 'ECONNREFUSED 127.0.0.1:9414')).toBe(false);
    c.advance(1000);
    expect(w.record('b1', 'ECONNREFUSED 127.0.0.1:9414')).toBe(true);
  });

  it('does not pair different errors or different bots', () => {
    const w = new RepeatFailureWatch({ now: clock().now });
    expect(w.record('b1', 'A')).toBe(false);
    expect(w.record('b1', 'B')).toBe(false);
    expect(w.record('b2', 'A')).toBe(false);
  });

  it('forgets a failure older than the window', () => {
    const c = clock();
    const w = new RepeatFailureWatch({ now: c.now });
    w.record('b1', 'A');
    c.advance(REPEAT_WINDOW_MS);
    expect(w.record('b1', 'A')).toBe(false);
    c.advance(1);
    expect(w.record('b1', 'A')).toBe(true);
  });

  it('stays quiet during the cooldown, then can fire again', () => {
    const c = clock();
    const w = new RepeatFailureWatch({ now: c.now });
    w.record('b1', 'A');
    expect(w.record('b1', 'A')).toBe(true);
    for (let i = 0; i < 5; i++) {
      c.advance(1000);
      expect(w.record('b1', 'A')).toBe(false);
    }
    c.advance(REPEAT_COOLDOWN_MS);
    w.record('b1', 'A');
    expect(w.record('b1', 'A')).toBe(true);
  });

  it('clear() resets the count after the browser answers again', () => {
    const w = new RepeatFailureWatch({ now: clock().now });
    w.record('b1', 'A');
    w.clear('b1');
    expect(w.record('b1', 'A')).toBe(false);
    w.record('b2', 'A');
    w.clear('b1');
    expect(w.record('b2', 'A')).toBe(true);
  });
});

describe('escalationNote', () => {
  it('names support, the bot, the exact error and the one action', () => {
    const t = escalationNote({ handle: 'paper-scout', kind: 'browser', error: 'ECONNREFUSED 127.0.0.1:9414', support: true });
    expect(t).toMatch(/^@pocketrocket-support: @paper-scout's browser failed twice/);
    expect(t).toContain('ECONNREFUSED 127.0.0.1:9414');
    expect(t).toContain('press Wake');
  });
  it('addresses the owner when there is no support bot', () => {
    expect(escalationNote({ handle: 'x', kind: 'computer', error: 'e', support: false })).toMatch(/^Owner: @x's computer/);
  });
});
