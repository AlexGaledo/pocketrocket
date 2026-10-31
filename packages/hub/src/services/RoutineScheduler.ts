import { Cron } from 'croner';
import type { Routine, RoutinePayload } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';
import { settings } from './SettingsStore.js';

/** A routine's schedule after validation: a cron pattern, or a one-shot instant (then `cron` is ''). */
export type Schedule = { cron: string; onceAt: number | null };

export class RoutineScheduler {
  private jobs = new Map<string, Cron>();
  private offSettings: (() => void) | null = null;
  private zone = '';
  /** `timezone` defaults to the live `settings.timezone`; tests pass a fixed one. */
  constructor(private repos: Repos, private router: RoomRouter, private opts: { timezone?: () => string } = {}) {}

  /** The zone cron patterns and local one-shot times are read in. */
  timezone(): string {
    return this.opts.timezone?.() ?? settings.get().timezone;
  }

  static validate(expr: string, timezone?: string): string | null {
    try {
      const c = new Cron(expr, { paused: true, timezone });
      c.stop();
      return null;
    } catch (e) {
      return String((e as Error).message ?? e);
    }
  }

  /**
   * Validates and normalises a schedule. `onceAt` wins over `cron`: epoch ms, or a local date-time string
   * (`2026-11-02T09:00`) read in `timezone`. A one-shot in the past is refused, as is an empty cron.
   */
  static resolveSchedule(i: { cron?: string; onceAt?: number | string | null }, timezone: string, now = Date.now()): Schedule | { error: string } {
    if (i.onceAt !== undefined && i.onceAt !== null) {
      let at: number | null;
      if (typeof i.onceAt === 'number') at = i.onceAt;
      else {
        try {
          const c = new Cron(i.onceAt, { paused: true, timezone });
          at = c.nextRun()?.getTime() ?? null;
          c.stop();
        } catch (e) {
          return { error: 'Invalid once_at "' + i.onceAt + '": ' + String((e as Error).message ?? e) };
        }
      }
      if (at === null || at <= now) return { error: 'once_at is in the past (' + timezone + ').' };
      return { cron: '', onceAt: at };
    }
    const cron = (i.cron ?? '').trim();
    if (!cron) return { error: 'A routine needs a cron pattern or a one-shot time (once_at).' };
    const bad = RoutineScheduler.validate(cron, timezone);
    return bad ? { error: 'Invalid cron: ' + bad } : { cron, onceAt: null };
  }

  /** Schedules every enabled routine, then fires one-shots whose time passed while the hub was down. */
  start() {
    this.reload();
    this.zone = this.timezone();
    // A new time zone moves every cron routine, so reschedule when it changes.
    this.offSettings ??= events.onEvent((ev) => {
      if (ev.type === 'settings.changed' && ev.settings.timezone !== this.zone) {
        this.zone = ev.settings.timezone;
        this.reload();
      }
    });
    const now = Date.now();
    for (const r of this.repos.listRoutines()) {
      // Still enabled means it never fired for real (firing switches a one-shot off; "Run now" does not).
      if (r.enabled && r.onceAt !== null && r.onceAt <= now) this.fire(r.id);
    }
  }
  stop() {
    this.clearJobs();
    this.offSettings?.();
    this.offSettings = null;
  }
  private clearJobs() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }
  reload() {
    this.clearJobs();
    for (const r of this.repos.listRoutines()) if (r.enabled) this.schedule(r);
    events.emitEvent({ type: 'routines.changed' });
  }
  private schedule(r: Routine) {
    try {
      let job: Cron;
      if (r.onceAt !== null) {
        if (r.onceAt <= Date.now()) {
          this.repos.updateRoutine(r.id, { nextRunAt: null });
          return;
        }
        job = new Cron(new Date(r.onceAt), { protect: true }, () => {
          this.fire(r.id);
        });
      } else {
        job = new Cron(r.cron, { protect: true, timezone: this.timezone() }, () => {
          this.fire(r.id);
        });
      }
      this.jobs.set(r.id, job);
      const next = job.nextRun();
      this.repos.updateRoutine(r.id, { nextRunAt: next ? next.getTime() : null });
    } catch (e) {
      console.error('[routine ' + r.name + '] invalid schedule: ' + (r.onceAt ?? r.cron), e);
    }
  }

  /** `manual`: "Run now" from the UI. It does not use up a one-shot, which still fires at its time. */
  fire(routineId: string, opts: { manual?: boolean } = {}): boolean {
    const r = this.repos.getRoutine(routineId);
    if (!r) return false;
    const bot = this.repos.getBot(r.botId);
    const room = this.repos.getRoom(r.roomId);
    if (!bot || !room) return false;
    const run = this.repos.createRun(r.id, null);
    const payload: RoutinePayload = { routineId: r.id, runId: run.id, name: r.name };
    const msg = this.router.fireRoutine(room, bot, '[Routine "' + r.name + '"] ' + r.prompt, payload, (res) => {
      this.repos.finishRun(run.id, res.ok ? 'success' : 'error', res.costUsd);
    });
    this.repos.db.run('UPDATE routine_runs SET message_id=? WHERE id=?', msg.id, run.id);
    if (r.onceAt !== null && !opts.manual) {
      // A one-shot is done once it fires: switch it off so neither a reload nor a restart fires it again.
      this.jobs.get(r.id)?.stop();
      this.jobs.delete(r.id);
      this.repos.updateRoutine(r.id, { lastRunAt: Date.now(), nextRunAt: null, enabled: false });
    } else {
      const next = r.onceAt !== null ? (r.enabled && r.onceAt > Date.now() ? r.onceAt : null) : this.jobs.get(r.id)?.nextRun()?.getTime();
      this.repos.updateRoutine(r.id, { lastRunAt: Date.now(), nextRunAt: next ?? null });
    }
    events.emitEvent({ type: 'routine.fired', routineId: r.id, runId: run.id, botId: bot.id, roomId: room.id });
    return true;
  }
}
