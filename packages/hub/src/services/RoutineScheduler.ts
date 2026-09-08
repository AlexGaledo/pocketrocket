import { Cron } from 'croner';
import type { Routine, RoutinePayload } from '@claudebot/shared';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { events } from '../events.js';

export class RoutineScheduler {
  private jobs = new Map<string, Cron>();
  constructor(private repos: Repos, private router: RoomRouter) {}

  static validate(expr: string): string | null {
    try {
      const c = new Cron(expr, { paused: true });
      c.stop();
      return null;
    } catch (e) {
      return String((e as Error).message ?? e);
    }
  }

  start() {
    this.reload();
  }
  stop() {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }
  reload() {
    this.stop();
    for (const r of this.repos.listRoutines()) if (r.enabled) this.schedule(r);
  }
  private schedule(r: Routine) {
    try {
      const job = new Cron(r.cron, { protect: true }, () => {
        this.fire(r.id);
      });
      this.jobs.set(r.id, job);
      const next = job.nextRun();
      this.repos.updateRoutine(r.id, { nextRunAt: next ? next.getTime() : null });
    } catch (e) {
      console.error('[routine ' + r.name + '] invalid cron: ' + r.cron, e);
    }
  }

  fire(routineId: string): boolean {
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
    const job = this.jobs.get(r.id);
    const next = job?.nextRun();
    this.repos.updateRoutine(r.id, { lastRunAt: Date.now(), nextRunAt: next ? next.getTime() : null });
    events.emitEvent({ type: 'routine.fired', routineId: r.id, runId: run.id, botId: bot.id, roomId: room.id });
    return true;
  }
}
