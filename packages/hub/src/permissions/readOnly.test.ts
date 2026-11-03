import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';

/**
 * The 'read-only' approvals setting: a write is refused outright, with no card raised at all — unlike 'ask'
 * (which would raise one) and unlike 'bypass' (which would allow it).
 */
function setup() {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Codey', handle: 'codey', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos, { bypass: () => false, globalReadOnly: () => true });
  const ctx = { bot, room, turnId: 'turn-1', hop: 0, causeId: 'c1', setState: () => undefined };
  let cards = 0;
  const off = events.onEvent((ev) => { if (ev.type === 'approval.request') cards++; });
  return { broker, ctx, cards: () => cards, off };
}

describe('read-only permissions', () => {
  it('refuses a file write and a shell write with no card', async () => {
    const s = setup();
    const signal = new AbortController().signal;
    const write = await s.broker.decide(s.ctx, 'Write', { file_path: 'notes.txt', content: 'hi' }, { signal });
    const bash = await s.broker.decide(s.ctx, 'Bash', { command: 'rm -rf /tmp/x' }, { signal });
    s.off();
    expect(write).toMatchObject({ behavior: 'deny' });
    expect(bash).toMatchObject({ behavior: 'deny' });
    expect(s.cards()).toBe(0);
  });

  it('still allows a read tool and an allowlisted read-only shell command', async () => {
    const s = setup();
    const signal = new AbortController().signal;
    const read = await s.broker.decide(s.ctx, 'Read', { file_path: 'notes.txt' }, { signal });
    const ls = await s.broker.decide(s.ctx, 'Bash', { command: 'ls -la' }, { signal });
    s.off();
    expect(read).toEqual({ behavior: 'allow' });
    expect(ls).toEqual({ behavior: 'allow' });
    expect(s.cards()).toBe(0);
  });

  it('refuses a fleet change and a request_approval write with no card', async () => {
    const s = setup();
    const signal = new AbortController().signal;
    const fleet = await s.broker.askFleetChange(s.ctx, 'create_bot', { name: 'x' }, 'make a bot', signal);
    const ask = await s.broker.ask(s.ctx, { action: 'write a file', command: 'rm -rf /tmp/x' }, signal);
    const askNoCommand = await s.broker.ask(s.ctx, { action: 'do something unclear' }, signal);
    s.off();
    expect(fleet).toMatchObject({ allowed: false });
    expect(ask).toMatchObject({ allowed: false });
    expect(askNoCommand).toMatchObject({ allowed: false });
    expect(s.cards()).toBe(0);
  });

  it('refuses an integration write with no card', async () => {
    const s = setup();
    const signal = new AbortController().signal;
    const out = await s.broker.askIntegrationWrite(s.ctx, 'send_email', { to: 'a@b.com' }, 'send an email', signal);
    s.off();
    expect(out).toMatchObject({ allowed: false });
    expect(s.cards()).toBe(0);
  });
});
