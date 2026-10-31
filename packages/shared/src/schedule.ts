/**
 * P3: routine schedule presets, the friendly side of a cron pattern. The Routines tab edits a preset plus a
 * time; this turns it into the cron the hub stores (read in `settings.timezone`) and back again. Anything a
 * preset cannot express is `custom` and edited as raw cron under "Advanced".
 */
export const SCHEDULE_PRESETS = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'custom'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

export interface ScheduleParts {
  preset: SchedulePreset;
  /** `HH:MM`, 24-hour. */
  time: string;
  /** `YYYY-MM-DD`, for `once`. */
  date: string;
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  weekday: number;
  /** 1–31, for `monthly` and `yearly`. */
  monthDay: number;
  /** 1–12, for `yearly`. */
  month: number;
  /** Raw pattern, for `custom`. */
  cron: string;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (time: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : [9, 0];
};

/** The cron for a recurring preset (`once` has none: it is a date-time; `custom` returns its raw cron). */
export function presetToCron(p: ScheduleParts): string {
  const [h, m] = hm(p.time);
  switch (p.preset) {
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${p.weekday}`;
    case 'monthly': return `${m} ${h} ${p.monthDay} * *`;
    case 'yearly': return `${m} ${h} ${p.monthDay} ${p.month} *`;
    case 'once': return '';
    case 'custom': return p.cron.trim();
  }
}

/** Reads a stored cron back into a preset; anything else is `custom`. Only the fields the preset uses are set. */
export function cronToPreset(cron: string): Partial<ScheduleParts> & { preset: SchedulePreset } {
  const f = cron.trim().split(/\s+/);
  const int = (s: string, lo: number, hi: number) => (/^\d{1,2}$/.test(s) && Number(s) >= lo && Number(s) <= hi ? Number(s) : null);
  if (f.length === 5) {
    const [mi, ho, dom, mon, dow] = f;
    const m = int(mi, 0, 59);
    const h = int(ho, 0, 23);
    if (m !== null && h !== null) {
      const time = pad(h) + ':' + pad(m);
      if (dom === '*' && mon === '*' && dow === '*') return { preset: 'daily', time };
      if (dom === '*' && mon === '*' && dow === '1-5') return { preset: 'weekdays', time };
      const wd = int(dow, 0, 6);
      if (dom === '*' && mon === '*' && wd !== null) return { preset: 'weekly', time, weekday: wd };
      const d = int(dom, 1, 31);
      if (d !== null && mon === '*' && dow === '*') return { preset: 'monthly', time, monthDay: d };
      const mo = int(mon, 1, 12);
      if (d !== null && mo !== null && dow === '*') return { preset: 'yearly', time, monthDay: d, month: mo };
    }
  }
  return { preset: 'custom', cron: cron.trim() };
}

/** One line for a routine list: "Weekdays at 09:00", "Every 3 May at 08:30", or the raw cron. */
export function describeCron(cron: string): string {
  const p = cronToPreset(cron);
  switch (p.preset) {
    case 'daily': return 'Every day at ' + p.time;
    case 'weekdays': return 'Weekdays at ' + p.time;
    case 'weekly': return 'Every ' + WEEKDAYS[p.weekday!] + ' at ' + p.time;
    case 'monthly': return 'Monthly on day ' + p.monthDay + ' at ' + p.time;
    case 'yearly': return 'Every ' + p.monthDay + ' ' + MONTHS[p.month! - 1] + ' at ' + p.time;
    default: return 'cron ' + cron.trim();
  }
}

/** `{ date: 'YYYY-MM-DD', time: 'HH:MM' }` for an instant as the clock reads in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute };
}
