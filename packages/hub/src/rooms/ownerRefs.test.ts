import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { MIGRATIONS } from '../db/migrations.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { FollowUp } from '../services/FollowUp.js';
import { RoutineScheduler } from '../services/RoutineScheduler.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { RoomRouter } from './RoomRouter.js';
import { parseOwnerRef, routineRef, workflowRef, type OwnerHandler, type ParsedOwnerRef } from './ownerRef.js';

/**
 * Workflows 3.2a: the lane foundations. An owner ref (`routine:<runId>`, `workflow:<runId>:<nodeId>`) replaces the bare
 * routine run id in the lane journal and on parked approvals, and the turn's `onDone` is rebuilt from it after a restart
 * and a park. A solo item never shares a turn. `causeBudget` caps every hop of a workflow run. Routines behave as before.
 */

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const tick = () => new Promise((r) => setTimeout(r, 25));

function routerOn(repos: Repos, run: (req: TurnRequest) => Promise<TurnResult> | TurnResult = () => ({ ok: true, turnId: 't', finalText: '', costUsd: 0.01 })) {
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const reqs: TurnRequest[] = [];
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      return run(req);
    },
  } as unknown as BotRunner;
  return { router, reqs };
}
const hang = (): Promise<TurnResult> => new Promise(() => undefined);

function world() {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Ann', handle: 'ann', title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  return { repos, bot, room };
}

/** Records what the router tells a workflow owner. */
function fakeOwner() {
  const log: string[] = [];
  const results: TurnResult[] = [];
  const handler: OwnerHandler = {
    onDone: (ref: ParsedOwnerRef, r) => { log.push('done ' + workflowKey(ref)); results.push(r); },
    onGone: (ref, why) => { log.push('gone ' + workflowKey(ref) + ' ' + why); },
  };
  return { log, results, handler };
}
const workflowKey = (ref: ParsedOwnerRef) => (ref.kind === 'workflow' ? ref.runId + '/' + ref.nodeId : ref.runId);

/** A workflow run's cause: the system note every step and hand-off of the run shares. */
function runCause(repos: Repos, roomId: string, payload: WorkflowPayload) {
  const msg = repos.insertMessage({ roomId, authorType: 'system', authorId: null, kind: 'system', text: 'Workflow started', payload, causeId: null, hop: 0, turnId: null });
  repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', msg.id, msg.id);
  return msg;
}

describe('owner refs', () => {
  it('builds and parses refs, and rejects anything else', () => {
    expect(routineRef('r1')).toBe('routine:r1');
    expect(workflowRef('r1', 'step-2')).toBe('workflow:r1:step-2');
    expect(parseOwnerRef('routine:r1')).toEqual({ kind: 'routine', runId: 'r1' });
    expect(parseOwnerRef('workflow:r1:step-2')).toEqual({ kind: 'workflow', runId: 'r1', nodeId: 'step-2' });
    for (const bad of ['', null, undefined, 'routine', 'routine:', 'workflow:r1', 'workflow:r1:', 'workflow:r1:a:b', 'channel:x', 'x:y:z']) expect(parseOwnerRef(bad)).toBeNull();
  });

  it('migration 290 backfills the owner ref of rows written with a routine run id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-owner-'));
    const file = path.join(dir, 'hub.db');
    const before = new Db(file, MIGRATIONS.filter((m) => m.version < 290));
    before.run("INSERT INTO lane_journal (id,bot_id,room_id,cause_id,hop,trigger_seq,run_id,note,attempts,created_at) VALUES ('j1','b','r','c',0,1,'run-7',NULL,0,1)");
    before.run("INSERT INTO lane_journal (id,bot_id,room_id,cause_id,hop,trigger_seq,run_id,note,attempts,created_at) VALUES ('j2','b','r','c',0,1,NULL,NULL,0,1)");
    before.run("INSERT INTO approvals (id,bot_id,room_id,tool_name,status,created_at,parked_at,run_id) VALUES ('a1','b','r','Bash','pending',1,2,'run-8')");
    before.raw.close();
    const after = new Db(file);
    const repos = new Repos(after);
    expect(repos.journalTakeAll().map((r) => [r.id, r.ownerRef])).toEqual([['j1', 'routine:run-7'], ['j2', null]]);
    expect(new ApprovalStore(after).listParked()[0].ownerRef).toBe('routine:run-8');
    after.raw.close();
  });

  it('a routine fired now journals its owner ref and closes the run when the turn ends', async () => {
    const w = world();
    const { router } = routerOn(w.repos);
    const run = w.repos.createRun('routine-1', null);
    router.fireRoutine(w.room, w.bot, '[Routine "n"] go', { routineId: 'routine-1', runId: run.id, name: 'n' });
    await until(() => w.repos.listRuns('routine-1')[0].status === 'success');
  });

  it('a routine turn cut off twice by restarts closes its run as an error (the owner is told it is gone)', async () => {
    const w = world();
    const p1 = routerOn(w.repos, hang);
    const run = w.repos.createRun('routine-1', null);
    p1.router.fireRoutine(w.room, w.bot, '[Routine "n"] go', { routineId: 'routine-1', runId: run.id, name: 'n' });
    await until(() => p1.reqs.length === 1);
    p1.router.freeze();
    const rows = w.repos.db.all<{ owner_ref: string; run_id: string }>('SELECT owner_ref, run_id FROM lane_journal');
    expect(rows).toEqual([{ owner_ref: 'routine:' + run.id, run_id: run.id }]);

    const p2 = routerOn(w.repos, hang);
    expect(new FollowUp({ repos: w.repos, router: p2.router }).resumeInterrupted()).toBe(1);
    await until(() => p2.reqs.length === 1);
    expect(w.repos.listRuns('routine-1')[0].status).toBe('running'); // resumed once: the run stays open
    p2.router.freeze();

    const p3 = routerOn(w.repos);
    expect(new FollowUp({ repos: w.repos, router: p3.router }).resumeInterrupted()).toBe(0);
    expect(w.repos.listRuns('routine-1')[0].status).toBe('error');
  });

  it('a routine turn that parks keeps its run open, and the resumed turn closes it', async () => {
    const w = world();
    const { router, reqs } = routerOn(w.repos, (req) => (req.injected.includes('(Approval granted)') ? { ok: true, turnId: 't', finalText: '', costUsd: 0.5 } : { ok: true, turnId: 't', finalText: '', costUsd: 0, parked: true }));
    const run = w.repos.createRun('routine-1', null);
    const msg = router.fireRoutine(w.room, w.bot, '[Routine "n"] go', { routineId: 'routine-1', runId: run.id, name: 'n' });
    await until(() => reqs.length === 1);
    await tick();
    expect(w.repos.listRuns('routine-1')[0].status).toBe('running');
    router.resumeParked(w.bot.id, w.room.id, { causeId: msg.id, hop: 0, ownerRef: routineRef(run.id), note: '(Approval granted)' });
    await until(() => w.repos.listRuns('routine-1')[0].status === 'success');
    expect(w.repos.listRuns('routine-1')[0].costUsd).toBe(0.5);
  });
});

describe('workflow owner refs survive a restart and a park', () => {
  it('a step cut off by a restart is resumed by FollowUp into the owner it belonged to, once, and runs alone', async () => {
    const w = world();
    const owner = fakeOwner();
    const p1 = routerOn(w.repos, hang);
    p1.router.registerOwner('workflow', owner.handler);
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'Weekly' });
    const ref = workflowRef('run1', 'n2');
    p1.router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0, ownerRef: ref });
    await until(() => p1.reqs.length === 1);
    expect(p1.reqs[0].ownerRef).toBe(ref);
    p1.router.freeze();
    expect(w.repos.journalHasOwner('workflow:run1:')).toBe(true);
    expect(w.repos.journalHasOwner('workflow:run2:')).toBe(false);

    // The next process: the closure is gone, the ref is not.
    const p2 = routerOn(w.repos);
    const owner2 = fakeOwner();
    p2.router.registerOwner('workflow', owner2.handler);
    expect(new FollowUp({ repos: w.repos, router: p2.router }).resumeInterrupted()).toBe(1);
    await until(() => owner2.log.length === 1);
    expect(owner2.log).toEqual(['done run1/n2']);
    expect(p2.reqs[0]).toMatchObject({ ownerRef: ref, causeKind: 'workflow', strictApprovals: true });
    expect(owner.log).toEqual([]);
    await tick();
    expect(w.repos.journalHasOwner('workflow:')).toBe(false); // settled: nothing left to resume
  });

  it('a step cut off by a second restart is not resumed again: its owner hears it is gone', async () => {
    const w = world();
    const p1 = routerOn(w.repos, hang);
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'Weekly' });
    p1.router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 1, ownerRef: workflowRef('run1', 'n2') });
    await until(() => p1.reqs.length === 1);
    p1.router.freeze();
    const p2 = routerOn(w.repos);
    const owner = fakeOwner();
    p2.router.registerOwner('workflow', owner.handler);
    expect(new FollowUp({ repos: w.repos, router: p2.router }).resumeInterrupted()).toBe(0);
    expect(owner.log).toEqual(['gone run1/n2 cut off by a server restart']);
    await tick();
    expect(p2.reqs).toHaveLength(0);
  });

  it('a parked step does not advance; the resumed turn settles it, and a bot that left tells its owner', async () => {
    const w = world();
    const owner = fakeOwner();
    const { router, reqs } = routerOn(w.repos, (req) => (req.injected.includes('(Approval granted)') ? { ok: true, turnId: 't', finalText: 'the draft', costUsd: 0.2 } : { ok: true, turnId: 't', finalText: '', costUsd: 0, parked: true }));
    router.registerOwner('workflow', owner.handler);
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'Weekly' });
    const ref = workflowRef('run1', 'n2');
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0, ownerRef: ref });
    await until(() => reqs.length === 1);
    await tick();
    expect(owner.log).toEqual([]); // parked: the step is not finished
    expect(router.resumeParked(w.bot.id, w.room.id, { causeId: cause.id, hop: 0, ownerRef: ref, note: '(Approval granted)' })).toBe(true);
    await until(() => owner.log.length === 1);
    expect(owner.log).toEqual(['done run1/n2']);
    expect(owner.results[0]).toMatchObject({ finalText: 'the draft', costUsd: 0.2 });
    expect(reqs[1]).toMatchObject({ ownerRef: ref, causeKind: 'workflow' });

    w.repos.updateRoom(w.room.id, { memberIds: [] });
    expect(router.resumeParked(w.bot.id, w.room.id, { causeId: cause.id, hop: 0, ownerRef: ref, note: 'x' })).toBe(false);
    expect(owner.log.at(-1)).toBe('gone run1/n2 removed from the room');
  });

  it('a workflow item that cannot start (the cause cap) settles its owner with the error', async () => {
    const w = world();
    const owner = fakeOwner();
    const { router, reqs } = routerOn(w.repos);
    router.registerOwner('workflow', owner.handler);
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'Weekly' });
    new UsageTracker(w.repos).record(w.bot.id, w.room.id, 'tt', cause.id, { costUsd: 99, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 1 } as never);
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0, ownerRef: workflowRef('run1', 'n2') });
    await until(() => owner.log.length === 1);
    expect(owner.results[0]).toMatchObject({ ok: false, error: 'cost cap reached' });
    expect(reqs).toHaveLength(0);
  });
});

describe('solo items', () => {
  it('a solo item runs alone: what queued before it is one turn, what came after is another', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { router, reqs } = routerOn(w.repos, async (req) => {
      if (reqs.length === 1) await gate; // the first turn holds the lane
      return { ok: true, turnId: 't' + reqs.length, finalText: '', costUsd: 0 };
    });
    const owner = fakeOwner();
    router.registerOwner('workflow', owner.handler);
    const first = router.onUserMessage(w.room.id, 'first', undefined, undefined, 'queue');
    await until(() => reqs.length === 1);
    const a = router.onUserMessage(w.room.id, 'chat A', undefined, undefined, 'queue');
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'Weekly' });
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0, ownerRef: workflowRef('run1', 'n2') });
    const b = router.onUserMessage(w.room.id, 'chat B', undefined, undefined, 'queue');
    release();
    await until(() => reqs.length === 4);
    await until(() => owner.log.length === 1);
    expect(first.seq).toBeLessThan(a.seq);
    // turn 2 = chat A alone, turn 3 = the workflow step alone, turn 4 = chat B alone
    expect(reqs[1].injected).toContain('triggered you: #' + a.seq + '.');
    expect(reqs[1].ownerRef).toBeUndefined();
    expect(reqs[2].ownerRef).toBe(workflowRef('run1', 'n2'));
    expect(reqs[2].injected).toContain('triggered on #' + cause.seq + '.');
    expect(reqs[3].ownerRef).toBeUndefined();
    expect(reqs[3].injected).toContain('triggered on #' + b.seq + '.'); // chat B was already shown to the earlier turn
    // The step's reply is the step's alone: onDone fired once, for its own turn.
    expect(owner.log).toEqual(['done run1/n2']);
  });

  it('items that are not solo are still batched into one turn, as before', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { router, reqs } = routerOn(w.repos, async () => {
      if (reqs.length === 1) await gate;
      return { ok: true, turnId: 't', finalText: '', costUsd: 0 };
    });
    router.onUserMessage(w.room.id, 'first', undefined, undefined, 'queue');
    await until(() => reqs.length === 1);
    const a = router.onUserMessage(w.room.id, 'chat A', undefined, undefined, 'queue');
    const b = router.onUserMessage(w.room.id, 'chat B', undefined, undefined, 'queue');
    release();
    await until(() => reqs.length === 2);
    expect(reqs[1].injected).toContain('#' + a.seq + ', #' + b.seq);
  });
});

describe('causeBudget: a workflow run budget covers every hop on its thread', () => {
  it('caps a step at what is left of the run budget, and drops a hop once nothing is left', async () => {
    const w = world();
    const { router, reqs } = routerOn(w.repos);
    let left: number | undefined = 0.4;
    const asked: string[] = [];
    router.workflowBudget = (runId) => { asked.push(runId); return left; };
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'Weekly' });
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0, ownerRef: workflowRef('run1', 'n2') });
    await until(() => reqs.length === 1);
    expect(reqs[0].causeBudgetUsd).toBeCloseTo(0.4);
    expect(asked).toContain('run1');

    // A hand-off on the same thread hits the same budget (the run is out of money).
    left = 0;
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 2, triggerSeq: cause.seq, attempts: 0 });
    await tick();
    expect(reqs).toHaveLength(1);
    const notes = w.repos.listMessages(w.room.id, { limit: 50 }).filter((m) => m.kind === 'system').map((m) => m.text);
    expect(notes.some((t) => /Run budget reached for workflow "Weekly"/.test(t))).toBe(true);
  });

  it('a run that no longer exists has nothing left to spend, and without a hook nothing changes', async () => {
    const w = world();
    const { router, reqs } = routerOn(w.repos);
    const cause = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'gone', name: 'Weekly' });
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0 });
    await until(() => reqs.length === 1); // no hook registered: only the cause cap applies
    router.workflowBudget = () => undefined;
    router.resume(w.bot, w.room, { causeId: cause.id, hop: 0, triggerSeq: cause.seq, attempts: 0 });
    await tick();
    expect(reqs).toHaveLength(1);
  });
});

describe('cause kinds and the manual flag', () => {
  it('a resumed turn on a workflow thread is a workflow turn; routine and trigger threads keep theirs', async () => {
    const w = world();
    const { router, reqs } = routerOn(w.repos);
    const wf = runCause(w.repos, w.room.id, { workflowId: 'wf', runId: 'run1', name: 'W' });
    const routine = w.repos.insertMessage({ roomId: w.room.id, authorType: 'system', authorId: null, kind: 'routine', text: 'r', payload: { routineId: 'r', runId: 'x', name: 'r' }, causeId: null, hop: 0, turnId: null });
    w.repos.db.run('UPDATE messages SET cause_id=? WHERE id=?', routine.id, routine.id);
    router.resume(w.bot, w.room, { causeId: wf.id, hop: 0, triggerSeq: wf.seq, attempts: 1 });
    await until(() => reqs.length === 1);
    router.resume(w.bot, w.room, { causeId: routine.id, hop: 0, triggerSeq: routine.seq, attempts: 1 });
    await until(() => reqs.length === 2);
    expect(reqs.map((r) => r.causeKind)).toEqual(['workflow', 'routine']);
    router.resume(w.bot, w.room, { causeId: wf.id, hop: 2, triggerSeq: wf.seq, attempts: 1 });
    await until(() => reqs.length === 3);
    expect(reqs[2].causeKind).toBe('bot'); // a hand-off inside a workflow step is still a bot turn
  });

  it('"Run now" marks the routine and its cause; a scheduled firing does not', async () => {
    const w = world();
    const { router } = routerOn(w.repos);
    const scheduler = new RoutineScheduler(w.repos, router, { timezone: () => 'UTC' });
    const r = w.repos.createRoutine({ botId: w.bot.id, roomId: w.room.id, name: 'n', cron: '0 3 * * *', prompt: 'p', enabled: true });
    scheduler.fire(r.id, { manual: true });
    scheduler.fire(r.id);
    await tick();
    const runs = w.repos.listRuns(r.id);
    const causes = runs.map((x) => x.messageId!).map((id) => ({ id, manual: router.isManualCause(id), payload: w.repos.getMessage(id)!.payload }));
    expect(causes.filter((c) => c.manual)).toHaveLength(1);
    expect(causes.find((c) => c.manual)!.payload).toMatchObject({ manual: true });
    expect(causes.find((c) => !c.manual)!.payload).not.toHaveProperty('manual');
    // A person's own message and an unknown cause are not "manual runs".
    expect(router.isManualCause('nope')).toBe(false);
    scheduler.stop();
  });
});
