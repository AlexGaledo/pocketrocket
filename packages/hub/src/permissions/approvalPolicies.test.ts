import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalPolicy } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore, patternMatches } from '../db/approvalStore.js';
import { PermissionBroker, approvalSubject } from './PermissionBroker.js';
import { events } from '../events.js';
import { createHub, type Hub } from '../hub.js';
import { INTEGRATION_WRITE_TOOLS } from '../integrations/toolNames.js';
import { createHubTools } from '../agent/botTools.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';

/**
 * P2 2.4: "always" answers and the user's approval rules live in `approval_policies`. Rules persist across a
 * restart and can be revoked; "Allow for this session" rows do not survive a restart; integration writes
 * keep asking on every call (P4); no bot tool can write a rule.
 */

const signal = () => new AbortController().signal;
/** Answers every card with `decision` and counts them. */
function answer(broker: PermissionBroker, decision: 'allow' | 'always' | 'deny') {
  let cards = 0;
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards++; setTimeout(() => broker.resolve(ev.approval.approvalId, decision), 0); }
  });
  return { cards: () => cards, off };
}

function setup(file = ':memory:') {
  const db = new Db(file);
  const repos = new Repos(db);
  const store = new ApprovalStore(db);
  const broker = new PermissionBroker(repos, { store });
  const bot = repos.getBotByHandle?.('policy') ?? repos.createBot({ name: 'Policy', handle: 'policy', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.listRooms()[0] ?? repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
  return { db, repos, store, broker, bot, room, ctx };
}

describe('pattern matching', () => {
  it('* matches all, a trailing * is a prefix, anything else is exact', () => {
    expect(patternMatches('*', 'anything')).toBe(true);
    expect(patternMatches('npm run *', 'npm run test')).toBe(true);
    expect(patternMatches('npm run *', 'npx something')).toBe(false);
    expect(patternMatches('npm test', 'npm test')).toBe(true);
    expect(patternMatches('npm test', 'npm test && rm -rf /')).toBe(false);
  });
  it('the subject is the command, the path or the URL', () => {
    expect(approvalSubject('Bash', { command: ' git push ', description: 'x' })).toBe('git push');
    expect(approvalSubject('WebFetch', { url: 'https://a.example/x' })).toBe('https://a.example/x');
    expect(approvalSubject('delete_bot', { handle: 'x' })).toBe('*');
  });
});

describe('approval rules in the broker', () => {
  it('an "always" answer becomes a session rule; the same call then needs no card, a different one does', async () => {
    const s = setup();
    const a = answer(s.broker, 'always');
    expect((await s.broker.decide(s.ctx, 'Bash', { command: 'npm run lint' }, { signal: signal() })).behavior).toBe('allow');
    expect((await s.broker.decide(s.ctx, 'Bash', { command: 'npm run lint' }, { signal: signal() })).behavior).toBe('allow');
    expect(a.cards()).toBe(1);
    expect(s.store.listPolicies(s.bot.id, 'session')).toMatchObject([{ tool: 'Bash', pattern: 'npm run lint', decision: 'allow' }]);
    expect(s.store.listPolicies(s.bot.id)).toEqual([]); // not a persisted rule until the user makes it one
    await s.broker.decide(s.ctx, 'Bash', { command: 'npm run lint -- --fix' }, { signal: signal() });
    expect(a.cards()).toBe(2);
    // A command the classifier calls dangerous is allowed once but never remembered.
    await s.broker.decide(s.ctx, 'Bash', { command: 'git push' }, { signal: signal() });
    await s.broker.decide(s.ctx, 'Bash', { command: 'git push' }, { signal: signal() });
    a.off();
    expect(a.cards()).toBe(4);
    expect(s.store.listPolicies(s.bot.id, 'session').map((p) => p.pattern)).toEqual(['npm run lint', 'npm run lint -- --fix']);
  });

  it('a fleet "always" is a session rule for that bot and tool (replacing the old in-memory set)', async () => {
    const s = setup();
    const a = answer(s.broker, 'always');
    expect((await s.broker.askFleetChange(s.ctx, 'create_room', { name: 'x' }, 'r', signal())).allowed).toBe(true);
    expect((await s.broker.askFleetChange(s.ctx, 'create_room', { name: 'y' }, 'r', signal())).allowed).toBe(true);
    a.off();
    expect(a.cards()).toBe(1);
    expect(s.store.listPolicies(s.bot.id, 'session')).toMatchObject([{ tool: 'create_room', pattern: '*' }]);
  });

  it('a deny rule wins over an allow rule, and an allow rule never covers a dangerous command', async () => {
    const s = setup();
    s.store.addPolicy({ botId: s.bot.id, tool: 'Bash', pattern: '*', decision: 'allow', scope: 'always' });
    expect(s.broker.matchPolicy(s.bot.id, 'Bash', 'ls -la')).toBe('allow');
    expect(s.broker.matchPolicy(s.bot.id, 'Bash', 'rm -rf ~', true)).toBeNull();
    s.store.addPolicy({ botId: s.bot.id, tool: 'Bash', pattern: 'git push*', decision: 'deny', scope: 'always' });
    expect(s.broker.matchPolicy(s.bot.id, 'Bash', 'git push origin')).toBe('deny');
    expect((await s.broker.decide(s.ctx, 'Bash', { command: 'git push origin' }, { signal: signal() })).behavior).toBe('deny');
  });

  it('integration writes ignore every rule and still ask on every call, also after "always"', async () => {
    const s = setup();
    const tool = INTEGRATION_WRITE_TOOLS[0];
    s.store.addPolicy({ botId: s.bot.id, tool, pattern: '*', decision: 'allow', scope: 'always' });
    const a = answer(s.broker, 'always');
    await s.broker.askIntegrationWrite(s.ctx, tool, { to: 'x' }, 'send', signal());
    await s.broker.askIntegrationWrite(s.ctx, tool, { to: 'x' }, 'send', signal());
    a.off();
    expect(a.cards()).toBe(2);
    expect(s.store.listPolicies(s.bot.id, 'session')).toEqual([]);
  });

  it('persisted rules survive a reopen; session rules are dropped at start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-pol-'));
    const file = path.join(dir, 'hub.db');
    const s1 = setup(file);
    s1.store.addPolicy({ botId: s1.bot.id, tool: 'Bash', pattern: 'npm test', decision: 'allow', scope: 'always' });
    s1.store.addPolicy({ botId: s1.bot.id, tool: 'Bash', pattern: 'npm run build', decision: 'allow', scope: 'session' });
    s1.db.raw.close();
    const db2 = new Db(file);
    const store2 = new ApprovalStore(db2);
    store2.clearSessionPolicies();
    expect(store2.listPolicies(undefined, 'all').map((p) => p.pattern)).toEqual(['npm test']);
    db2.raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no bot tool can write approval rules or settings', () => {
    const s = setup();
    const names = createHubTools({
      bot: s.bot, room: s.room, members: [s.bot], turnId: 't', hop: 0, causeId: 'c', repos: s.repos,
      memory: new MemoryService(), skills: new SkillService(s.repos), dispatchFromBot: () => [], setState: () => undefined, models: [],
    }).map((t) => t.name);
    expect(names.filter((n) => /polic|rule|approval|setting/i.test(n))).toEqual([]);
  });
});

describe('REST: list, create from a card, revoke', () => {
  const T = 'p'.repeat(32);
  let hub: Hub;
  let base: string;
  const headers = { authorization: 'Bearer ' + T, 'content-type': 'application/json' };
  const api = async (p: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  let botId: string;
  beforeAll(async () => {
    hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: T });
    base = 'http://127.0.0.1:' + (await hub.listen());
    botId = (await api('/api/bots', 'POST', { name: 'Ops', handle: 'ops' })).json.id;
  });
  afterAll(async () => { await hub.shutdown(); });

  it('turns an answered card into a rule, lists it, and revokes it', async () => {
    const bot = hub.repos.getBot(botId)!;
    const room = hub.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
    let approvalId = '';
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') { approvalId = ev.approval.approvalId; setTimeout(() => hub.broker.resolve(approvalId, 'always'), 0); }
    });
    await hub.broker.decide(ctx, 'Bash', { command: 'npm run deploy' }, { signal: signal() });
    off();

    const changed: ApprovalPolicy[][] = [];
    const off2 = events.onEvent((ev) => { if (ev.type === 'policies.changed') changed.push(ev.policies); });
    const created = await api('/api/approval-policies', 'POST', { approvalId });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ botId, tool: 'Bash', pattern: 'npm run deploy', decision: 'allow' });
    expect(created.json.scope).toBeUndefined();
    const list = await api('/api/approval-policies?botId=' + botId);
    expect(list.json).toHaveLength(1);
    expect(hub.broker.matchPolicy(botId, 'Bash', 'npm run deploy')).toBe('allow');

    expect((await api('/api/approval-policies/' + created.json.id, 'DELETE')).status).toBe(200);
    expect((await api('/api/approval-policies?botId=' + botId)).json).toEqual([]);
    expect((await api('/api/approval-policies/' + created.json.id, 'DELETE')).status).toBe(404);
    off2();
    expect(changed.map((c) => c.length)).toEqual([1, 0]);
  });

  it('refuses rules for integration writes, unknown bots, and requests without the token', async () => {
    expect((await api('/api/approval-policies', 'POST', { botId, tool: INTEGRATION_WRITE_TOOLS[0], pattern: '*' })).status).toBe(400);
    expect((await api('/api/approval-policies', 'POST', { botId: 'ghost', tool: 'Bash', pattern: '*' })).status).toBe(404);
    expect((await api('/api/approval-policies', 'POST', { tool: 'Bash' })).status).toBe(400);
    const r = await fetch(base + '/api/approval-policies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId, tool: 'Bash', pattern: '*' }) });
    expect(r.status).toBe(401);
    expect(hub.approvals.listPolicies(botId)).toEqual([]);
  });
});
