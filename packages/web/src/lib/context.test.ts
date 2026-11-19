import { describe, expect, it } from 'vitest';
import { applyContext, contextMeterProps, fmtTokens, replaceRoomContexts } from './context';

const u = (contextTokens: number, window = 200_000, rotateAt: number | null = 120_000) => ({ contextTokens, window, rotateAt });

describe('context meter (P4-2)', () => {
  it('formats token counts short', () => {
    expect(fmtTokens(84_000)).toBe('84k');
    expect(fmtTokens(200_000)).toBe('200k');
    expect(fmtTokens(1_000_000)).toBe('1M');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtTokens(900)).toBe('900');
  });

  it('fills to used / window and marks the rotation point, with no marker when rotation is off or past the window', () => {
    expect(contextMeterProps(u(84_000))).toEqual({ value: 42, detail: '84k of 200k tokens', marker: { value: 60, label: 'a fresh session starts at 120k' } });
    expect(contextMeterProps(u(84_000, 200_000, null)).marker).toBeUndefined();
    expect(contextMeterProps(u(84_000, 100_000, 120_000)).marker).toBeUndefined();
  });

  it('a turn.end sets or drops one entry; a room snapshot replaces only that room', () => {
    let c = applyContext({}, 'a', 'r1', u(1_000));
    c = applyContext(c, 'b', 'r1', u(2_000));
    c = applyContext(c, 'a', 'r2', u(3_000));
    expect(Object.keys(c).sort()).toEqual(['a:r1', 'a:r2', 'b:r1']);
    const same = applyContext(c, 'z', 'r1', undefined);
    expect(same).toBe(c);
    expect(Object.keys(applyContext(c, 'b', 'r1', undefined)).sort()).toEqual(['a:r1', 'a:r2']);
    expect(replaceRoomContexts(c, 'r1', { b: u(5_000) })).toEqual({ 'a:r2': u(3_000), 'b:r1': u(5_000) });
  });
});
