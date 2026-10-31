import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { IntegrationVault } from '../services/IntegrationVault.js';
import { IntegrationService } from '../services/IntegrationService.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { events } from '../events.js';
import { createIntegrationTools } from './tools.js';
import { INTEGRATION_TOOLS } from './toolNames.js';
import { fakeFetch } from './fakeFetch.js';

const PAT = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
let dir: string;

async function setup(opts: { bypass?: boolean } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-int-tools-'));
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const f = fakeFetch();
  f.on('GET', 'https://api.github.com/user', () => ({ json: { login: 'octo' }, headers: { 'x-oauth-scopes': 'repo, notifications' } }));
  const svc = new IntegrationService({
    db, fetch: f.fetch, vault: new IntegrationVault({ file: path.join(dir, 'i.json'), keyFile: path.join(dir, 'vault.key') }),
  });
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: 'x', avatar: '🔎', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const other = repos.createBot({ name: 'Nova', handle: 'nova', title: '', description: 'y', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'Scout', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos, { bypass: () => !!opts.bypass });
  const permCtx = { bot, room, turnId: 't1', hop: 0, causeId: 'c1', setState: () => undefined };
  const conn = await svc.connectToken('github', { token: PAT });
  const confirm = (a: { tool: string; reason: string; input: Record<string, unknown> }) =>
    broker.askIntegrationWrite(permCtx, a.tool, a.input, a.reason, new AbortController().signal);
  return { svc, f, bot, other, broker, conn, tools: (botId = bot.id) => createIntegrationTools(svc, botId, confirm) };
}

function answerCards(broker: PermissionBroker, d: 'allow' | 'always' | 'deny') {
  const cards: ApprovalPayload[] = [];
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') {
      cards.push(ev.approval);
      setTimeout(() => broker.resolve(ev.approval.approvalId, d), 0);
    }
  });
  return { cards, off };
}

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('integration tools and per-bot grants', () => {
  it('a bot without a grant gets no integration tools at all', async () => {
    const s = await setup();
    expect(s.tools()).toEqual([]);
    s.svc.setGrants(s.conn.id, [s.other.id]);
    expect(s.tools()).toEqual([]);
    expect(s.tools(s.other.id).map((t) => t.name)).toEqual([...INTEGRATION_TOOLS.github.read, ...INTEGRATION_TOOLS.github.write]);
  });

  it('only the granted provider shows up', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    const names = s.tools().map((t) => t.name);
    expect(names).toContain('github_notifications');
    expect(names.some((n) => n.startsWith('gmail_') || n.startsWith('slack_'))).toBe(false);
  });

  it('revoking the grant (or disconnecting) removes the tools from the next turn', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    expect(s.tools().length).toBeGreaterThan(0);
    s.svc.setGrants(s.conn.id, []);
    expect(s.tools()).toEqual([]);
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    s.svc.disconnect(s.conn.id);
    expect(s.tools()).toEqual([]);
  });

  it('grants of deleted bots are pruned', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id, s.other.id]);
    s.svc.pruneGrants([s.bot.id]);
    expect(s.svc.repo.get(s.conn.id)?.botIds).toEqual([s.bot.id]);
  });

  it('read tools run silently, label output as untrusted and never contain the token', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    s.f.on('GET', 'https://api.github.com/notifications', (c) => {
      expect(c.headers.authorization).toBe('Bearer ' + PAT);
      // a hostile payload that echoes the token back
      return { json: [{ id: '1', reason: 'mention', unread: true, updated_at: 'now', subject: { title: 'leak ' + PAT, type: 'Issue', url: null }, repository: { full_name: 'o/r' } }] };
    });
    const { cards, off } = answerCards(s.broker, 'deny');
    const out = await s.tools().find((t) => t.name === 'github_notifications')!.handler({});
    off();
    expect(cards).toHaveLength(0);
    const txt = (out.content[0] as { text: string }).text;
    expect(txt).toMatch(/^\[Content from GitHub, written by third parties/);
    expect(txt).toContain('[redacted]');
    expect(txt).not.toContain(PAT);
  });
});

describe('integration write tools are gated', () => {
  it('raise a card and send nothing when declined', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    let posted = 0;
    s.f.on('POST', 'https://api.github.com/repos/o/r/issues/7/comments', () => { posted++; return { json: { html_url: 'https://github.com/o/r/issues/7#c' } }; });
    const { cards, off } = answerCards(s.broker, 'deny');
    const out = await s.tools().find((t) => t.name === 'github_comment')!.handler({ repo: 'o/r', number: 7, body: 'hello' });
    off();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolName: 'github_comment', toolInput: { repo: 'o/r', number: 7, body: 'hello' } });
    expect(cards[0].reason).toContain('o/r#7');
    expect(out.isError).toBe(true);
    expect(posted).toBe(0);
  });

  it('send once allowed', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    let posted = 0;
    s.f.on('POST', 'https://api.github.com/repos/o/r/issues/7/comments', (c) => { posted++; expect(JSON.parse(c.body)).toEqual({ body: 'hello' }); return { json: { html_url: 'https://github.com/o/r/issues/7#c' } }; });
    const { off } = answerCards(s.broker, 'allow');
    const out = await s.tools().find((t) => t.name === 'github_comment')!.handler({ repo: 'o/r', number: 7, body: 'hello' });
    off();
    expect(out.isError).toBeFalsy();
    expect(posted).toBe(1);
  });

  it('still ask when approvals are bypassed, and "always" is not remembered', async () => {
    const s = await setup({ bypass: true });
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    s.f.on('POST', 'https://api.github.com/repos/o/r/issues', () => ({ json: { number: 1, title: 't', state: 'open', html_url: 'u', updated_at: 'x' } }));
    const { cards, off } = answerCards(s.broker, 'always');
    const tool = s.tools().find((t) => t.name === 'github_create_issue')!;
    await tool.handler({ repo: 'o/r', title: 't' });
    await tool.handler({ repo: 'o/r', title: 't' });
    off();
    expect(cards).toHaveLength(2);
  });

  it('refuse when no approval card can be shown', async () => {
    const s = await setup();
    s.svc.setGrants(s.conn.id, [s.bot.id]);
    const out = await createIntegrationTools(s.svc, s.bot.id).find((t) => t.name === 'github_comment')!.handler({ repo: 'o/r', number: 1, body: 'x' });
    expect(out.isError).toBe(true);
    expect(s.f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('the broker lets read tools through silently and keeps write tools on the in-handler gate', async () => {
    const s = await setup();
    const room = { id: 'r', kind: 'dm', name: 'x', memberIds: [], coordinatorBotId: null, createdAt: 0 } as never;
    const ctx = { bot: s.bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
    const signal = new AbortController().signal;
    for (const n of [...INTEGRATION_TOOLS.google.read, ...INTEGRATION_TOOLS.slack.write]) {
      expect(await s.broker.decide(ctx, 'mcp__pocketrocket__' + n, {}, { signal })).toEqual({ behavior: 'allow' });
    }
  });
});

describe('pasted tokens', () => {
  it('rejects the wrong shape before any network call', async () => {
    const s = await setup();
    const before = s.f.calls.length;
    await expect(s.svc.connectToken('slack', { token: 'not-a-slack-token' })).rejects.toThrow(/xoxb-/);
    await expect(s.svc.connectToken('clickup', { token: 'abc' })).rejects.toThrow(/pk_/);
    await expect(s.svc.connectToken('google', { token: 'whatever' })).rejects.toThrow(/OAuth only/);
    expect(s.f.calls.length).toBe(before);
  });

  it('warns that a fine-grained GitHub PAT cannot read notifications', async () => {
    const s = await setup();
    s.f.on('GET', 'https://api.github.com/user', () => ({ json: { login: 'octo' } }));
    const info = await s.svc.connectToken('github', { token: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz' });
    expect(info.warnings.join(' ')).toMatch(/Fine-grained/);
    expect(info.id).toBe(s.conn.id); // replaced in place, grants survive
  });

  it('stores the Slack bot + app tokens, and Socket Mode uses the app token', async () => {
    const s = await setup();
    s.f.on('POST', 'https://slack.com/api/auth.test', (c) => {
      expect(c.headers.authorization).toBe('Bearer xoxb-1234567890-abcdefghij');
      return { json: { ok: true, team: 'Acme', user: 'crewbot', url: 'https://acme.slack.com/' } };
    });
    s.f.on('POST', 'https://slack.com/api/apps.connections.open', (c) => {
      expect(c.headers.authorization).toBe('Bearer xapp-1-A012-345-abcdef');
      return { json: { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=x' } };
    });
    const info = await s.svc.connectToken('slack', { token: 'xoxb-1234567890-abcdefghij', appToken: 'xapp-1-A012-345-abcdef' });
    expect(info).toMatchObject({ accountLabel: 'Acme · crewbot', hasAppToken: true });
    expect(await s.svc.client('slack').openSocketModeUrl()).toMatch(/^wss:/);
  });

  it('a refused token is reported and nothing is stored', async () => {
    const s = await setup();
    s.f.on('GET', 'https://api.clickup.com/api/v2/user', () => ({ status: 401, json: { err: 'Token invalid', ECODE: 'OAUTH_025' } }));
    await expect(s.svc.connectToken('clickup', { token: 'pk_123_ABCDEFGHIJKLMNOPQRST' })).rejects.toThrow(/Token invalid/);
    expect(s.svc.repo.byProvider('clickup')).toBeUndefined();
  });
});
