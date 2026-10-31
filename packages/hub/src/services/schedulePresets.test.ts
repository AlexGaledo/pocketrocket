import { describe, expect, it } from 'vitest';
import { cronToPreset, describeCron, presetToCron, zonedParts, type ScheduleParts } from '@pocketrocket/shared';
import { RoutineScheduler } from './RoutineScheduler.js';

/** P3 3.3: the Routines tab's preset picker writes cron, and reads it back, so nobody needs to know cron. */

const base: ScheduleParts = { preset: 'daily', time: '09:00', date: '2026-11-02', weekday: 1, monthDay: 1, month: 1, cron: '' };

describe('schedule presets', () => {
  it('writes a valid cron for every recurring preset and reads the same preset back', () => {
    const cases: [Partial<ScheduleParts>, string][] = [
      [{ preset: 'daily', time: '07:05' }, '5 7 * * *'],
      [{ preset: 'weekdays', time: '09:00' }, '0 9 * * 1-5'],
      [{ preset: 'weekly', time: '18:30', weekday: 5 }, '30 18 * * 5'],
      [{ preset: 'monthly', time: '00:00', monthDay: 15 }, '0 0 15 * *'],
      [{ preset: 'yearly', time: '08:15', monthDay: 3, month: 5 }, '15 8 3 5 *'],
    ];
    for (const [parts, cron] of cases) {
      const p = { ...base, ...parts };
      expect(presetToCron(p)).toBe(cron);
      expect(RoutineScheduler.validate(cron, 'Asia/Manila')).toBeNull();
      expect(cronToPreset(cron)).toMatchObject(parts);
    }
  });

  it('treats anything else as custom cron', () => {
    expect(cronToPreset('*/15 * * * *')).toEqual({ preset: 'custom', cron: '*/15 * * * *' });
    expect(cronToPreset('0 9 * * 1,3')).toMatchObject({ preset: 'custom' });
    expect(presetToCron({ ...base, preset: 'custom', cron: ' 0 */2 * * * ' })).toBe('0 */2 * * *');
    expect(presetToCron({ ...base, preset: 'once' })).toBe('');
  });

  it('describes a cron in words', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('15 8 3 5 *')).toBe('Every 3 May at 08:15');
    expect(describeCron('*/15 * * * *')).toBe('cron */15 * * * *');
  });

  it('shows an instant as the wall clock of the zone', () => {
    const ms = Date.parse('2026-11-02T01:00:00Z');
    expect(zonedParts(ms, 'Asia/Manila')).toEqual({ date: '2026-11-02', time: '09:00' });
    expect(zonedParts(ms, 'America/New_York')).toEqual({ date: '2026-11-01', time: '20:00' });
  });
});
