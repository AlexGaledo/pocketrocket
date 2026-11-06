import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { Bot, Room } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { runOnPcTool, whereToRunTool, type ToolCtx } from '../agent/botTools.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { parseKeyRegistry } from '../services/keyRegistry.js';
import { events } from '../events.js';
import { listAudit } from '../services/AuditLog.js';
import type { ToolOutput } from '../providers/types.js';

/**
 * A job on the owner's PC may only be allowed from a browser signed in with the owner password, never with the
 * hub token alone (a bot that read the token could answer its own card), and run_on_pc only takes needs the
 * key registry puts on the PC.
 */

// Password hashing is slow on purpose.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'pc-approval-test-hub-token';
const PASSWORD = 'pc runner owner password';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-pcapproval-'));

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json'), pollMs: 5 },
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Promise<{ status: number; json: any; cookie: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] });
      });
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

/** A browser session cookie from the owner password; sets the password (hub token, first time only) when none is set. */
async function sessionCookie(): Promise<string> {
  if (!(await request('GET', '/api/auth/status', { token: null })).json.passwordSet) {
    expect((await request('POST', '/api/auth/password', { body: { password: PASSWORD } })).status).toBe(200);
  }
  const r = await request('POST', '/api/auth/login', { token: null, body: { password: PASSWORD } });
  expect(r.status).toBe(200);
  return r.cookie;
}

function openWs(headers: Record<string, string>): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { host: '127.0.0.1:' + port, ...headers } });
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    // The hello arrives right after open; wait for it so the test can read it.
    ws.on('open', () => setTimeout(() => resolve({ ws, messages }), 50));
    ws.on('error', reject);
  });
}
const tick = () => new Promise((r) => setTimeout(r, 80));
const hello = (messages: any[]) => messages.find((m) => m.type === 'hello');

let n = 0;
function botAndRoom(): { bot: Bot; room: Room } {
  const bot = hub.repos.createBot({ name: 'PA' + n, handle: 'pa-bot-' + n++, title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const room = hub.repos.createRoom({ kind: 'dm', name: 'PA chat', memberIds: [bot.id], coordinatorBotId: null });
  return { bot, room };
}

/** Raises a card through the hub's own broker (the one the socket answers) and returns its id and pending answer. */
async function card(tool: string, input: Record<string, unknown>) {
  const { bot, room } = botAndRoom();
  let release!: (p: { approvalId: string; signInRequired?: boolean }) => void;
  const seen = new Promise<{ approvalId: string; signInRequired?: boolean }>((r) => (release = r));
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request' && ev.botId === bot.id) release(ev.approval);
  });
  const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
  const answer = hub.broker.askFleetChange(ctx, tool, input, 'r', new AbortController().signal, { evenUnderBypass: true });
  const payload = await seen;
  off();
  return { id: payload.approvalId, answer, payload };
}

describe('who may approve a job on the PC', () => {
  it('the hub token cannot allow a run_on_pc card, only deny it; the card stays open after a refused allow', async () => {
    const { id, answer, payload } = await card('run_on_pc', { folder: 'site', prompt: 'p' });
    expect(payload.signInRequired).toBe(true);
    const { ws, messages } = await openWs({ authorization: 'Bearer ' + TOKEN });
    expect(hello(messages)?.signedIn).toBe(false);
    for (const decision of ['allow', 'always']) ws.send(JSON.stringify({ type: 'approval.decide', approvalId: id, decision }));
    await tick();
    const errors = messages.filter((m) => m.type === 'error' && m.context === id);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toMatch(/signed in with your password/);
    expect(hub.repos.db.get('SELECT status FROM approvals WHERE id=?', id)?.status).toBe('pending');
    expect(listAudit(hub.repos.db).some((e) => e.action === 'approval.refused_not_signed_in' && e.target === id)).toBe(true);
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: id, decision: 'deny' }));
    expect((await answer).allowed).toBe(false);
    ws.close();
  });

  it('a browser signed in with the owner password can allow it', async () => {
    const cookie = await sessionCookie();
    const { id, answer } = await card('run_on_pc', { folder: 'site', prompt: 'p' });
    const { ws, messages } = await openWs({ cookie });
    expect(hello(messages)?.signedIn).toBe(true);
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: id, decision: 'allow' }));
    expect((await answer).allowed).toBe(true);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    ws.close();
  });

  it('signing out takes effect on an open socket at once', async () => {
    const cookie = await sessionCookie();
    // Hub token plus a live session cookie: the cookie is what counts.
    const { ws, messages } = await openWs({ cookie, authorization: 'Bearer ' + TOKEN });
    expect(hello(messages)?.signedIn).toBe(true);
    const current = (await request('GET', '/api/auth/sessions', { token: null, cookie })).json.current as string;
    expect((await request('DELETE', '/api/auth/sessions/' + current)).status).toBe(200);
    const { id, answer } = await card('run_on_pc', { folder: 'site', prompt: 'p' });
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: id, decision: 'allow' }));
    await tick();
    expect(messages.some((m) => m.type === 'error' && m.context === id && /signed in/.test(m.message))).toBe(true);
    hub.broker.resolve(id, 'deny');
    expect((await answer).allowed).toBe(false);
    ws.close();
  });

  it('a paired device cannot allow it either', async () => {
    const { code } = hub.devices.mintPairingCode();
    const device = hub.devices.redeem(code, 'phone').token;
    const { id, answer } = await card('run_on_pc', { folder: 'site', prompt: 'p' });
    const { ws, messages } = await openWs({ authorization: 'Bearer ' + device });
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: id, decision: 'allow' }));
    await tick();
    expect(messages.some((m) => m.type === 'error' && m.context === id && /signed in/.test(m.message))).toBe(true);
    hub.broker.resolve(id, 'deny');
    expect((await answer).allowed).toBe(false);
    ws.close();
  });

  it('the broker itself refuses an allow without signedIn, so no other caller skips the check', async () => {
    const { id, answer } = await card('run_on_pc', { folder: 'site', prompt: 'p' });
    expect(hub.broker.needsSignIn(id)).toBe(true);
    expect(hub.broker.resolve(id, 'allow')).toBe(false);
    expect(hub.broker.resolve(id, 'always', { device: true })).toBe(false);
    expect(hub.broker.resolve(id, 'allow', { signedIn: true })).toBe(true);
    expect((await answer).allowed).toBe(true);
  });

  it('other cards are unchanged: the hub token allows them', async () => {
    const { id, answer, payload } = await card('create_bot', { name: 'x' });
    expect(payload.signInRequired).toBeUndefined();
    expect(hub.broker.needsSignIn(id)).toBe(false);
    const { ws, messages } = await openWs({ authorization: 'Bearer ' + TOKEN });
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: id, decision: 'allow' }));
    expect((await answer).allowed).toBe(true);
    expect(messages.filter((m) => m.type === 'error')).toEqual([]);
    ws.close();
  });
});

describe('key routing tools', () => {
  const registry = parseKeyRegistry({ keys: {
    'store-p8': { tier: 3, where: ['pc'] },
    'supabase-ro': { tier: 1, where: ['vps'] },
    firecrawl: { tier: 1, where: ['vps', 'pc'] },
  } });
  const textOf = (o: ToolOutput) => o.content.map((c) => ('text' in c ? c.text : '')).join('');

  function ctxFor(cards: Parameters<NonNullable<ToolCtx['confirmFleetChange']>>[0][], paired: boolean): ToolCtx {
    const { bot, room } = botAndRoom();
    return {
      bot, room, members: [bot], turnId: 't', hop: 0, causeId: 'c', repos: hub.repos,
      memory: new MemoryService(), skills: new SkillService(hub.repos), dispatchFromBot: () => [], setState: () => undefined, models: [],
      confirmFleetChange: async (a) => { cards.push(a); return { allowed: false, message: 'no' }; },
      pcRunner: paired ? hub.pcRunner : undefined, keyRegistry: () => registry,
    };
  }

  async function pair() {
    const t = (await request('POST', '/api/pc-runner/token', { body: {} })).json.token as string;
    expect((await request('POST', '/api/pc-runner/heartbeat', { token: t, body: { folders: ['site'] } })).status).toBe(200);
  }

  it('run_on_pc refuses needs the PC does not hold or the registry does not know, before any card', async () => {
    await pair();
    const cards: Parameters<NonNullable<ToolCtx['confirmFleetChange']>>[0][] = [];
    const ctx = ctxFor(cards, true);
    const t = runOnPcTool(ctx, hub.pcRunner);
    for (const needs of [['supabase-ro'], ['made-up'], ['store-p8', 'made-up']]) {
      const out = (await t.handler({ folder: 'site', prompt: 'p', needs })) as ToolOutput;
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/The PC does not hold/);
    }
    expect(cards).toEqual([]);
    // A need the PC holds reaches the card, and the card shows it.
    const out = (await t.handler({ folder: 'site', prompt: 'p', needs: ['store-p8', 'firecrawl'] })) as ToolOutput;
    expect(out.isError).toBe(true);
    expect(cards).toEqual([expect.objectContaining({ tool: 'run_on_pc', input: { folder: 'site', prompt: 'p', needs: ['store-p8', 'firecrawl'] } })]);
    expect(cards[0].reason).toContain('using keys: store-p8, firecrawl');
  });

  it('where_to_run answers from the registry and the runner pairing, never asks', async () => {
    await pair();
    const cards: Parameters<NonNullable<ToolCtx['confirmFleetChange']>>[0][] = [];
    const ask = async (paired: boolean, needs: string[]) =>
      JSON.parse(textOf((await whereToRunTool(ctxFor(cards, paired)).handler({ needs })) as ToolOutput));
    expect(await ask(true, ['supabase-ro'])).toMatchObject({ place: 'vps', missing: [] });
    expect(await ask(true, ['store-p8'])).toMatchObject({ place: 'pc', missing: [] });
    expect(await ask(false, ['store-p8'])).toMatchObject({ place: 'blocked' });
    expect(await ask(true, ['made-up'])).toMatchObject({ place: 'blocked', missing: ['made-up'] });
    expect(cards).toEqual([]);
  });
});
