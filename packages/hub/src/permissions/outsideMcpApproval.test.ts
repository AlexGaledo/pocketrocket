import { describe, expect, it } from 'vitest';
import type { ApprovalPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';
import { addSecret, clearSecrets } from '../providers/redact.js';

/**
 * Calls to an owner-configured outside MCP server with `approve` set raise a card on every call: under bypass,
 * past an "allow" rule, and after an "always" answer. Read-only mode refuses them outright.
 */
const signal = () => new AbortController().signal;

function setup(opts: { bypass?: boolean; readOnly?: boolean } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const store = new ApprovalStore(db);
  const broker = new PermissionBroker(repos, { store, bypass: () => !!opts.bypass, globalReadOnly: () => !!opts.readOnly });
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
  return { broker, store, bot, ctx };
}

function answer(broker: PermissionBroker, decision: 'allow' | 'always' | 'deny') {
  const cards: ApprovalPayload[] = [];
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards.push(ev.approval); setTimeout(() => broker.resolve(ev.approval.approvalId, decision), 0); }
  });
  return { cards, off };
}

describe('askOutsideMcp', () => {
  it('raises a card under bypass, showing server, tool and input', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', { gpu: 'A100', count: 2 }, signal());
    a.off();
    expect(r.allowed).toBe(true);
    expect(a.cards).toHaveLength(1);
    expect(a.cards[0].toolName).toBe('mcp__runpod__create_pod');
    expect(a.cards[0].toolInput).toEqual({ server: 'runpod', tool: 'create_pod', input: '{"gpu":"A100","count":2}' });
    // The card offers no "for this session".
    expect(a.cards[0].once).toBe(true);
  });

  it('is not skipped by an "allow" rule or an earlier "always" answer, and records no rule', async () => {
    const s = setup({ bypass: true });
    s.store.addPolicy({ botId: s.bot.id, tool: 'mcp__runpod__create_pod', pattern: '*', decision: 'allow', scope: 'always' });
    const a = answer(s.broker, 'always');
    expect((await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', {}, signal())).allowed).toBe(true);
    expect((await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', {}, signal())).allowed).toBe(true);
    a.off();
    expect(a.cards).toHaveLength(2);
    expect(s.store.listPolicies(s.bot.id, 'session')).toEqual([]);
  });

  it('denies with a plain message when the owner says no', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'deny');
    const r = await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', {}, signal());
    a.off();
    expect(r).toEqual({ allowed: false, message: 'The user declined this outside tool call. Do not retry it; say so in the room.' });
  });

  it('refuses outright in read-only mode, without a card', async () => {
    const s = setup({ readOnly: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'firecrawl', 'firecrawl_search', { query: 'x' }, signal());
    a.off();
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/Read-only mode/);
    expect(a.cards).toHaveLength(0);
  });

  it('shows the whole input on the card, redacted', async () => {
    clearSecrets();
    addSecret('supabase-service-key-123');
    const s = setup();
    const a = answer(s.broker, 'deny');
    await s.broker.askOutsideMcp(s.ctx, 'supabase', 'execute_sql', { key: 'supabase-service-key-123', sql: 'x'.repeat(5000) }, signal());
    a.off();
    clearSecrets();
    const shown = (a.cards[0].toolInput as { input: string }).input;
    expect(shown).not.toContain('supabase-service-key-123');
    expect(shown).toContain('x'.repeat(5000));
  });

  it('refuses an input too large to show in full, without a card, under bypass too', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'supabase', 'execute_sql', { sql: 'select 1; ' + 'x'.repeat(9000) }, signal());
    a.off();
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/^Input too large to show for approval \(\d+ chars\); split the call\.$/);
    expect(a.cards).toHaveLength(0);
  });
});
