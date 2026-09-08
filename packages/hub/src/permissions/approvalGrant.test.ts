import { describe, expect, it, vi } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { PermissionBroker, GRANT_TTL_MS } from './PermissionBroker.js';
import { events } from '../events.js';

/**
 * Audit 2026-09-09, B10: `request_approval` returned a bare boolean, so nothing tied the "yes" to what the
 * card actually showed. It now returns an approvalId naming a recorded grant. The binding is advisory —
 * Codex and Grok run their own tool loop and the hub cannot force them — which is why the tool description
 * says so and why this suite asserts the record exists rather than that it is enforced.
 */

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos);
  const ctx = { bot, room, turnId: 'turn-7', hop: 0, causeId: 'c1', setState: () => undefined };
  const answer = (d: 'allow' | 'always' | 'deny') =>
    events.onEvent((ev) => {
      if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, d), 0);
    });
  return { broker, ctx, answer };
}

describe('request_approval grants', () => {
  it('records exactly what the card showed, bound to the bot and turn', async () => {
    const s = setup();
    const off = s.answer('allow');
    const r = await s.broker.ask(
      s.ctx,
      { action: 'delete the build cache', command: 'rm -rf /tmp/build', paths: ['/tmp/build'], reason: 'stale' },
      new AbortController().signal,
    );
    off();
    expect(r.allowed).toBe(true);
    expect(r.approvalId).toBeTruthy();

    const grant = s.broker.getGrant(r.approvalId!)!;
    expect(grant).toMatchObject({
      approvalId: r.approvalId,
      botId: s.ctx.bot.id,
      turnId: 'turn-7',
      action: 'delete the build cache',
      command: 'rm -rf /tmp/build',
      paths: ['/tmp/build'],
    });
    // Ten minutes, matching the approval card's own timeout.
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + GRANT_TTL_MS);
  });

  it('records nothing when the user declines', async () => {
    const s = setup();
    const off = s.answer('deny');
    const r = await s.broker.ask(s.ctx, { action: 'email the customer list' }, new AbortController().signal);
    off();
    expect(r.allowed).toBe(false);
    expect(s.broker.getGrant(r.approvalId!)).toBeNull();
  });

  it('expires a grant after ten minutes', async () => {
    const s = setup();
    const off = s.answer('allow');
    const r = await s.broker.ask(s.ctx, { action: 'write outside the workspace' }, new AbortController().signal);
    off();
    expect(s.broker.getGrant(r.approvalId!)).toBeTruthy();

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + GRANT_TTL_MS + 1);
    expect(s.broker.getGrant(r.approvalId!)).toBeNull();
    vi.restoreAllMocks();
    // Once expired it stays gone, not resurrected by the clock going back.
    expect(s.broker.getGrant(r.approvalId!)).toBeNull();
  });

  it('knows nothing about an id it never issued', () => {
    const s = setup();
    expect(s.broker.getGrant('made-up-id')).toBeNull();
  });
});
