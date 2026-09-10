import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';
import { buildCodexArgs } from '../providers/codex.js';
import { buildConfigContent } from '../providers/opencode/server.js';

/**
 * BYPASS_PERMISSIONS: no approval card is ever raised for a tool call or a `request_approval`. Fleet
 * changes (create/update/delete a bot, room membership) are deliberately not covered and still ask.
 */

function setup(bypass: boolean) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos, { bypass });
  const ctx = { bot, room, turnId: 'turn-1', hop: 0, causeId: 'c1', setState: () => undefined };
  let cards = 0;
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards++; setTimeout(() => broker.resolve(ev.approval.approvalId, 'deny'), 0); }
  });
  return { broker, ctx, cards: () => cards, off };
}

describe('bypass permissions', () => {
  it('allows a destructive Bash command and an out-of-workspace write without a card', async () => {
    const s = setup(true);
    const signal = new AbortController().signal;
    const bash = await s.broker.decide(s.ctx, 'Bash', { command: 'rm -rf /tmp/anything' }, { signal });
    const write = await s.broker.decide(s.ctx, 'Write', { file_path: '/etc/motd', content: 'hi' }, { signal });
    s.off();
    expect(bash).toEqual({ behavior: 'allow' });
    expect(write).toEqual({ behavior: 'allow' });
    expect(s.cards()).toBe(0);
  });

  it('answers request_approval yes without a card or a grant record', async () => {
    const s = setup(true);
    const r = await s.broker.ask(s.ctx, { action: 'git push', command: 'git push --force' }, new AbortController().signal);
    s.off();
    expect(r.allowed).toBe(true);
    expect(r.approvalId).toBeUndefined();
    expect(s.cards()).toBe(0);
  });

  it('still asks for a fleet change', async () => {
    const s = setup(true);
    const d = await s.broker.askFleetChange(s.ctx, 'delete_bot', { botId: s.ctx.bot.id }, 'delete Codey', new AbortController().signal);
    s.off();
    expect(d.allowed).toBe(false);
    expect(s.cards()).toBe(1);
  });

  it('is off by default in the broker itself (the hub passes BYPASS_PERMISSIONS explicitly)', async () => {
    const s = setup(false);
    const d = await s.broker.decide(s.ctx, 'Bash', { command: 'rm -rf /tmp/anything' }, { signal: new AbortController().signal });
    s.off();
    expect(d.behavior).toBe('deny');
    expect(s.cards()).toBe(1);
  });

  it('opens the Codex and OpenCode sandboxes', () => {
    const base = { workspaceDir: 'C:\\ws', botHome: 'C:\\bots\\b1', model: 'm', mcpUrl: 'http://127.0.0.1:1/mcp', resumeToken: null };
    const full = buildCodexArgs({ ...base, readOnly: false, fullAccess: true });
    expect(full[full.indexOf('--sandbox') + 1]).toBe('danger-full-access');
    expect(full.some((a) => a.startsWith('sandbox_workspace_write'))).toBe(false);
    // A bot without Bash stays read-only even under bypass.
    const ro = buildCodexArgs({ ...base, readOnly: true, fullAccess: true });
    expect(ro[ro.indexOf('--sandbox') + 1]).toBe('read-only');

    const cfg = JSON.parse(buildConfigContent({ mcpUrl: 'http://x', mcpToken: 't', bypass: true }));
    expect(Object.values(cfg.permission).every((v) => v === 'allow')).toBe(true);
  });
});
