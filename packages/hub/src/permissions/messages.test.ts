import { describe, expect, it } from 'vitest';
import { DEFAULT_ALT, DENY_KINDS, denyMessage, type DenyKind, type DenyOpts } from './messages.js';
import { PARKED_MESSAGE, PermissionBroker } from './PermissionBroker.js';
import { TAKEOVER_PARKED } from '../agent/takeoverTool.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { readOnlyWriteDecision, routingFileWrite } from './readOnlyRoots.js';
import { WORKSPACE_DIR } from '../config.js';

/** The three parts every refusal the model reads must have (B1). */
function parts(msg: string): { outcome: string; noRetry: string; alt: string } {
  const m = /^(.*?\S)\s+(Do not retry (?:it|this))\b[;,:]?\s*(.*)$/s.exec(msg);
  if (!m) throw new Error('no "Do not retry" in: ' + msg);
  return { outcome: m[1], noRetry: m[2], alt: m[3] };
}
function expectThreeParts(msg: string) {
  const p = parts(msg);
  expect(p.outcome.length, 'outcome in: ' + msg).toBeGreaterThan(8);
  expect(p.noRetry).toMatch(/^Do not retry (it|this)$/);
  expect(p.alt.replace(/[.\s]/g, '').length, 'alternative in: ' + msg).toBeGreaterThan(5);
}

const OPTS: DenyOpts[] = [
  {},
  { subject: 'this change', alt: 'say so in the room' },
  { subject: 'this outside tool call', note: 'the outside tool was not called', alt: 'use your own computer' },
  { note: 'nothing was sent.', alt: 'choose another approach.' },
];

describe('denyMessage', () => {
  it('lists every kind', () => {
    expect([...DENY_KINDS].sort()).toEqual(['declined', 'not_allowed', 'off', 'readonly', 'timeout', 'unavailable']);
  });

  for (const kind of ['declined', 'timeout', 'not_allowed', 'unavailable', 'off', 'readonly'] satisfies DenyKind[]) {
    it(kind + ': outcome, "Do not retry", and what to do instead, for every option shape', () => {
      for (const o of OPTS) expectThreeParts(denyMessage(kind, o));
    });
  }

  it('falls back to a default alternative, and never doubles punctuation', () => {
    const m = denyMessage('declined');
    expect(m).toContain(DEFAULT_ALT);
    expect(m).not.toMatch(/\.\./);
    expect(denyMessage('declined', { note: 'nothing was sent.', alt: 'say so.' })).not.toMatch(/\.\./);
  });

  it('keeps the wording callers and tests already rely on', () => {
    expect(denyMessage('declined', { subject: 'this outside tool call', alt: 'say so in the room' }))
      .toBe('The user declined this outside tool call. Do not retry it; say so in the room.');
    expect(denyMessage('timeout', { alt: 'ask in chat' })).toMatch(/^No response from the user within 10 minutes/);
    expect(denyMessage('readonly', { subject: 'fleet changes' })).toMatch(/^Read-only mode:/);
  });

  it('carries the standing stop-signs the model already had', () => {
    expect(PARKED_MESSAGE).toMatch(/do not retry/i);
    expect(TAKEOVER_PARKED).toMatch(/do not retry/i);
  });
});

describe('refusals the broker and its guards actually return', () => {
  const setup = (opts: { readOnly?: boolean } = {}) => {
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const store = new ApprovalStore(db);
    const broker = new PermissionBroker(repos, { store, globalReadOnly: () => !!opts.readOnly });
    const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
    return { broker, store, bot, ctx };
  };
  const signal = new AbortController().signal;

  it('a deny rule, in decide() and ask()', async () => {
    const s = setup();
    s.store.addPolicy({ botId: s.bot.id, tool: 'WebFetch', pattern: '*', decision: 'deny', scope: 'always' });
    const d = await s.broker.decide(s.ctx, 'WebFetch', { url: 'https://example.com' }, { signal });
    expect(d.behavior).toBe('deny');
    expectThreeParts((d as { message: string }).message);
    s.store.addPolicy({ botId: s.bot.id, tool: 'request_approval', pattern: '*', decision: 'deny', scope: 'always' });
    const a = await s.broker.ask(s.ctx, { action: 'do a thing' }, signal);
    expect(a.allowed).toBe(false);
    expectThreeParts(a.message);
  });

  it('every read-only refusal', async () => {
    const s = setup({ readOnly: true });
    const msgs: string[] = [];
    for (const [tool, input] of [['Write', { file_path: 'x.txt' }], ['Bash', { command: 'rm -rf x' }], ['mcp__pocketrocket__create_bot', {}]] as const) {
      const d = await s.broker.decide(s.ctx, tool, { ...input }, { signal });
      expect(d.behavior).toBe('deny');
      msgs.push((d as { message: string }).message);
    }
    msgs.push((await s.broker.ask(s.ctx, { action: 'x', command: 'rm -rf x' }, signal)).message);
    msgs.push((await s.broker.askFleetChange(s.ctx, 'create_bot', {}, 'r', signal)).message);
    msgs.push((await s.broker.askIntegrationWrite(s.ctx, 'slack_post_message', {}, 'r', signal)).message);
    msgs.push((await s.broker.askOutsideMcp(s.ctx, 'srv', 'tool', {}, signal)).message);
    for (const m of msgs) {
      expect(m).toMatch(/^Read-only mode:/);
      expectThreeParts(m);
    }
  });

  it('an oversized outside MCP input', async () => {
    const s = setup();
    const r = await s.broker.askOutsideMcp(s.ctx, 'srv', 'tool', { blob: 'x'.repeat(9000) }, signal);
    expect(r.allowed).toBe(false);
    expectThreeParts(r.message);
  });

  it('the routing.md guard and the knowledge-repo guard', () => {
    const r = routingFileWrite('Bash', { command: 'echo x >> ../routing.md' }, WORKSPACE_DIR);
    expect(r).not.toBeNull();
    expectThreeParts(r!);
    const k = readOnlyWriteDecision('Write', { file_path: WORKSPACE_DIR + '/knowledge/a.md' }, [WORKSPACE_DIR + '/knowledge'], WORKSPACE_DIR, true);
    expect(k?.decision).toBe('deny');
    expectThreeParts(k!.reason);
    const sh = readOnlyWriteDecision('Bash', { command: 'echo x > ' + WORKSPACE_DIR + '/knowledge/a.md' }, [WORKSPACE_DIR + '/knowledge'], WORKSPACE_DIR, true);
    expect(sh?.decision).toBe('deny');
    expectThreeParts(sh!.reason);
  });
});
