import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { Machines } from './Machines.js';
import { listMachinesTool, runOnPcTool, type ToolCtx } from '../agent/botTools.js';
import { PermissionBroker, SIGN_IN_TOOLS } from '../permissions/PermissionBroker.js';
import { MemoryService } from './MemoryService.js';
import { SkillService } from './SkillService.js';
import type { PcRunner } from './PcRunner.js';
import type { ToolOutput } from '../providers/types.js';

const textOf = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join('');

/** A paired, online PC that records what the tool sent it. */
function fakePc() {
  const created: unknown[] = [];
  const pc = {
    isPaired: () => true, online: () => true, folders: () => ['site'],
    create: (j: unknown) => { created.push(j); return { id: 'job1' }; },
    cancel: () => undefined, approve: () => true, get: () => undefined,
    wait: async () => ({ status: 'done', result: 'ok', costUsd: null }),
  } as unknown as PcRunner;
  return { pc, created };
}

function setup() {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const bot = repos.createBot({ name: 'M', handle: 'mach', title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const { pc, created } = fakePc();
  const cards: Parameters<NonNullable<ToolCtx['confirmFleetChange']>>[0][] = [];
  const ctx: ToolCtx = {
    bot, room, members: [bot], turnId: 't', hop: 0, causeId: 'c', repos,
    memory: new MemoryService(), skills: new SkillService(repos), dispatchFromBot: () => [], setState: () => undefined, models: [],
    confirmFleetChange: async (a) => { cards.push(a); return { allowed: true, message: 'ok' }; },
    pcRunner: pc,
  };
  const run = (input: unknown) => runOnPcTool(ctx, pc).handler(input as Record<string, unknown>) as Promise<ToolOutput>;
  return { db, repos, bot, ctx, pc, created, cards, run, machines: new Machines(db, pc) };
}

describe('per-machine execution policy', () => {
  it('defaults to ask: the card is raised and the job is sent after approval', async () => {
    const s = setup();
    expect(s.machines.policy('pc')).toBe('ask');
    const out = await s.run({ folder: 'site', prompt: 'do it' });
    expect(out.isError).toBeFalsy();
    expect(s.created).toHaveLength(1);
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]).toMatchObject({ tool: 'run_on_pc', evenUnderBypass: true, machine: 'pc' });
  });

  it('never: refuses with the off message, creates no job and raises no card', async () => {
    const s = setup();
    s.machines.setPolicy('pc', 'never');
    const out = await s.run({ folder: 'site', prompt: 'do it' });
    expect(out.isError).toBe(true);
    const t = textOf(out);
    expect(t).toContain('is turned off');
    expect(t).toContain('Do not retry it');
    expect(t).toContain('use your own computer');
    expect(s.created).toHaveLength(0);
    expect(s.cards).toHaveLength(0);
  });

  it('always does not relax anything: same card, still signInOnly and ask-every-time', async () => {
    const s = setup();
    s.machines.setPolicy('pc', 'always');
    const out = await s.run({ folder: 'site', prompt: 'do it', machine: 'pc' });
    expect(out.isError).toBeFalsy();
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0].evenUnderBypass).toBe(true);
    expect(SIGN_IN_TOOLS.has('run_on_pc')).toBe(true);
    // An allow rule still cannot pre-approve it (ASK_EVERY_TIME), with or without a machine.
    const store = new ApprovalStore(s.db);
    const broker = new PermissionBroker(s.repos, { store });
    store.addPolicy({ botId: s.bot.id, tool: 'run_on_pc', pattern: '*', decision: 'allow', scope: 'always', machine: 'pc' });
    expect(broker.matchPolicy(s.bot.id, 'run_on_pc', '*', false, 'pc')).toBeNull();
  });

  it('machine vps and unknown machines are refused without sending anything', async () => {
    const s = setup();
    const a = await s.run({ folder: 'site', prompt: 'x', machine: 'vps' });
    const b = await s.run({ folder: 'site', prompt: 'x', machine: 'nas' });
    expect(a.isError && b.isError).toBe(true);
    expect(textOf(b)).toContain('list_machines');
    expect(s.created).toHaveLength(0);
  });

  it('only the PC has a settable policy', () => {
    const s = setup();
    expect(s.machines.setPolicy('vps', 'never')).toBe(false);
    expect(s.machines.setPolicy('nas', 'never')).toBe(false);
    expect(s.machines.policy('vps')).toBe('always');
  });
});

describe('list_machines', () => {
  it('is read-only and lists id, label, kind, online, paired and policy', async () => {
    const s = setup();
    s.machines.setPolicy('pc', 'never');
    const t = listMachinesTool(s.ctx);
    expect(t.readOnly).toBe(true);
    const list = JSON.parse(textOf((await t.handler({})) as ToolOutput));
    expect(list).toEqual([
      { id: 'vps', label: 'Your own computer', kind: 'own', online: true, paired: true, policy: 'always' },
      { id: 'pc', label: "Owner's PC", kind: 'pc', online: true, paired: true, policy: 'never' },
    ]);
  });

  it('shows an unpaired PC as offline and unpaired', () => {
    const db = new Db(':memory:');
    const pc = { isPaired: () => false, online: () => true } as unknown as PcRunner;
    expect(new Machines(db, pc).get('pc')).toMatchObject({ online: false, paired: false, policy: 'ask' });
  });
});

describe('machine scope and expiry on approval rules', () => {
  function rules() {
    let now = 1000;
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const store = new ApprovalStore(db, () => now);
    const broker = new PermissionBroker(repos, { store });
    return { db, store, broker, advance: (ms: number) => { now += ms; } };
  }

  it('a machine-scoped rule covers only that machine; an unscoped one covers any', () => {
    const { store, broker } = rules();
    store.addPolicy({ botId: 'b', tool: 'run_on_pc', pattern: '*', decision: 'deny', scope: 'always', machine: 'pc' });
    expect(broker.matchPolicy('b', 'run_on_pc', '*', false, 'pc')).toBe('deny');
    expect(broker.matchPolicy('b', 'run_on_pc', '*', false, 'vps')).toBeNull();
    expect(broker.matchPolicy('b', 'run_on_pc', '*')).toBeNull();
    store.addPolicy({ botId: 'b', tool: 'WebFetch', pattern: '*', decision: 'allow', scope: 'always', machine: 'pc' });
    expect(broker.matchPolicy('b', 'WebFetch', '*', false, 'vps')).toBeNull();
    expect(broker.matchPolicy('b', 'WebFetch', '*', false, 'pc')).toBe('allow');
    store.addPolicy({ botId: 'b', tool: 'Bash', pattern: 'ls', decision: 'allow', scope: 'always' });
    expect(broker.matchPolicy('b', 'Bash', 'ls', false, 'pc')).toBe('allow');
    expect(broker.matchPolicy('b', 'Bash', 'ls')).toBe('allow');
  });

  it('same rule on different machines or expiries is not a duplicate', () => {
    const { store } = rules();
    const base = { botId: 'b', tool: 'Bash', pattern: 'ls', decision: 'allow' as const, scope: 'always' as const };
    const a = store.addPolicy(base);
    expect(store.addPolicy(base).id).toBe(a.id);
    expect(store.addPolicy({ ...base, machine: 'pc' }).id).not.toBe(a.id);
    expect(store.addPolicy({ ...base, expiresAt: 5000 }).id).not.toBe(a.id);
    expect(store.getPolicy(a.id)).toMatchObject({ machine: null, expiresAt: null });
  });

  it('an expired rule no longer matches or lists, and prunePolicies deletes it', () => {
    const { db, store, broker, advance } = rules();
    store.addPolicy({ botId: 'b', tool: 'Bash', pattern: 'ls', decision: 'allow', scope: 'always', expiresAt: 2000 });
    store.addPolicy({ botId: 'b', tool: 'Bash', pattern: 'pwd', decision: 'allow', scope: 'always' });
    expect(broker.matchPolicy('b', 'Bash', 'ls')).toBe('allow');
    advance(1500);
    expect(broker.matchPolicy('b', 'Bash', 'ls')).toBeNull();
    expect(store.listPolicies('b').map((p) => p.pattern)).toEqual(['pwd']);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approval_policies')!.n).toBe(2);
    store.prunePolicies(['b']);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approval_policies')!.n).toBe(1);
  });
});

describe('migration 190-191 on a pre-existing database', () => {
  it('upgrades a database that has approval rules but neither the columns nor the table', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mach-')), 'hub.db');
    const old = new Db(file);
    old.run("INSERT INTO approval_policies (id, bot_id, tool, pattern, decision, scope, created_at) VALUES ('p1','b','Bash','ls','allow','always',1)");
    // Rewind to what a pre-B4 database looks like.
    old.raw.exec('DROP TABLE machine_policies; ALTER TABLE approval_policies DROP COLUMN machine; ALTER TABLE approval_policies DROP COLUMN expires_at;');
    old.raw.exec('DELETE FROM schema_version WHERE version IN (190, 191)');
    old.raw.close();

    const db = new Db(file);
    expect(db.schemaVersions()).toEqual(expect.arrayContaining([190, 191]));
    const store = new ApprovalStore(db);
    expect(store.getPolicy('p1')).toMatchObject({ pattern: 'ls', machine: null, expiresAt: null });
    expect(store.listPolicies('b')).toHaveLength(1);
    expect(new Machines(db).setPolicy('pc', 'never')).toBe(true);
    expect(new Machines(db).policy('pc')).toBe('never');
    db.raw.close();
  });
});
