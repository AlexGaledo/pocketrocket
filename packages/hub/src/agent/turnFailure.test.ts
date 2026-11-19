import { describe, expect, it } from 'vitest';
import { TURN_FAILURE_BEHAVIOUR } from '@pocketrocket/shared';
import { limitText, resetTime, turnFailureNote } from './turnFailure.js';

/** M5 (spec 01 P0-3): the failure note for a turn that ended on a provider limit. */

// 2026-11-19 10:00 UTC
const NOW = Date.UTC(2026, 10, 19, 10, 0);
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h, m);

describe('limit failure note', () => {
  it('reads "Claude 5-hour limit reached, resets 14:00" in local time, and is external', () => {
    const note = turnFailureNote('Ada', 'usage limit reached (five_hour)', false, { provider: 'Claude', kind: 'usage', window: 'five_hour', resetsAt: at(19, 14) }, NOW, 'UTC');
    expect(note.text).toBe('Ada turn ended: Claude 5-hour limit reached, resets 14:00.');
    expect(note.payload.turnFailure).toBe('external');
  });

  it('shows the reset in the hub zone, not UTC', () => {
    expect(resetTime(at(19, 14), NOW, 'Asia/Manila')).toBe('22:00');
    expect(resetTime(at(19, 23, 30), NOW, 'Asia/Manila')).toBe('Fri 07:30');
  });

  it('names the day when the reset is not today, and the date beyond a week', () => {
    expect(resetTime(at(19, 0, 5), NOW, 'UTC')).toBe('00:05');
    expect(resetTime(at(21, 9), NOW, 'UTC')).toBe('Sat 09:00');
    expect(resetTime(at(28, 9), NOW, 'UTC')).toBe('Nov 28 09:00');
  });

  it('words each window and kind without the provider text', () => {
    const l = (o: object) => limitText({ provider: 'Claude', kind: 'usage', ...o } as never, NOW, 'UTC');
    expect(l({ window: 'seven_day', resetsAt: at(21, 9) })).toBe('Claude weekly limit reached, resets Sat 09:00');
    expect(l({ window: 'seven_day_opus' })).toBe('Claude weekly Opus limit reached');
    expect(l({})).toBe('Claude usage limit reached');
    expect(l({ window: 'something_new', resetsAt: NOW - 1 })).toBe('Claude usage limit reached');
    expect(l({ kind: 'overloaded' })).toMatch(/^Claude is overloaded/);
    expect(l({ kind: 'auth' })).toMatch(/^Claude sign-in failed/);
    expect(l({ kind: 'down' })).toBe('Claude could not be reached');
  });

  it('leaves the training classifier as it was for every other failure', () => {
    expect(turnFailureNote('W', 'error_max_turns', false).payload.turnFailure).toBe(TURN_FAILURE_BEHAVIOUR);
    expect(turnFailureNote('W', 'error_max_turns', false).text).toBe('W turn ended: error_max_turns');
    expect(turnFailureNote('W', 'usage limit reached', false).payload.turnFailure).toBe('external');
    expect(turnFailureNote('W', 'boom', true).payload.turnFailure).toBe('external');
  });
});
