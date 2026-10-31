import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ControlStatus, Message, TakeoverPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ComputersRepo } from '../db/computers.js';
import { events } from '../events.js';
import { ComputerManager, type ComputerEndpoint, type Systemctl } from './ComputerManager.js';
import { ComputerControlService, SHARED_SCREEN_IN_USE, USER_HAS_CONTROL, COMPUTER_PAUSED, type VncControl } from './ComputerControl.js';
import { takeoverTool, TAKEOVER_PARKED } from '../agent/takeoverTool.js';
import { createHub, type Hub } from '../hub.js';
import { screenViewerPath } from '../api/screenSession.js';

/** P2 2.1 / 2.3: control state, x11vnc view-only, request_takeover and the hand-back note. */

function fakeSystemctl(): Systemctl {
  const active = new Set<string>();
  return { start: async (u) => { active.add(u); }, stop: async (u) => { active.delete(u); }, isActive: async (u) => active.has(u) };
}
function fakeVnc() {
  const calls: { display: string; on: boolean }[] = [];
  const vnc: VncControl = { setViewOnly: async (ep: ComputerEndpoint, on: boolean) => { calls.push({ display: ep.display, on }); } };
  return { vnc, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(enabled: boolean, opts: { takeoverWaitMs?: number; now?: () => number } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-control-'));
  const computers = new ComputerManager(new ComputersRepo(db), {
    enabled, dir, dataDir: dir, systemctl: fakeSystemctl(), probe: async () => true, startTimeoutMs: 20, pollMs: 1,
  });
  const { vnc, calls } = fakeVnc();
  const control = new ComputerControlService({ computers, repos, vnc, ...opts });
  const mk = (handle: string) => repos.createBot({ name: handle, handle, title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Browser', 'Desktop'], maxBudgetUsd: 2 });
  return { db, repos, computers, control, calls, mk, dir };
}

describe('control state', () => {
  it('defaults to agent and blocks the computer tools while the user has control or the bot is paused', () => {
    const { control, mk } = setup(true);
    const a = mk('alpha');
    expect(control.get(a.id)).toMatchObject({ control: 'agent', holder: null, takeover: null });
    expect(control.blockedReason(a.id)).toBeNull();
    expect(control.viewOnly(a.id)).toBe(true);
    control.set(a.id, 'user', { holder: 'dev-1' });
    expect(control.get(a.id)).toMatchObject({ control: 'user', holder: 'dev-1' });
    expect(control.blockedReason(a.id)).toBe(USER_HAS_CONTROL);
    expect(control.viewOnly(a.id)).toBe(false);
    control.set(a.id, 'paused');
    expect(control.blockedReason(a.id)).toBe(COMPUTER_PAUSED);
    control.set(a.id, 'agent');
    expect(control.get(a.id).holder).toBeNull();
  });

  it('emits computer.control on every change', () => {
    const { control, mk } = setup(true);
    const a = mk('alpha');
    const seen: ControlStatus[] = [];
    const off = events.onEvent((ev) => { if (ev.type === 'computer.control') seen.push(ev.status); });
    control.set(a.id, 'user');
    control.set(a.id, 'agent');
    off();
    expect(seen.map((s) => s.control)).toEqual(['user', 'agent']);
  });

  it('toggles x11vnc view-only on a live computer (viewonly with the agent, noviewonly with the user)', async () => {
    const { control, computers, calls, mk } = setup(true);
    const a = mk('alpha');
    await computers.ensureRunning(a.id);
    const display = computers.existingEndpoint(a.id)!.display;
    control.set(a.id, 'user');
    control.set(a.id, 'agent');
    control.set(a.id, 'paused');
    await tick();
    expect(calls).toEqual([{ display, on: false }, { display, on: true }, { display, on: true }]);
    // A computer that comes up (re)gets the current state.
    control.start();
    events.emitEvent({ type: 'computer.state', status: computers.status(a.id) });
    await tick();
    expect(calls.at(-1)).toEqual({ display, on: true });
    control.stop();
  });

  it('on the one shared screen, a person in control stops every bot', () => {
    const { control, mk } = setup(false);
    const a = mk('alpha');
    const b = mk('beta');
    control.set(a.id, 'user');
    expect(control.blockedReason(a.id)).toBe(USER_HAS_CONTROL);
    expect(control.blockedReason(b.id)).toBe(SHARED_SCREEN_IN_USE);
    expect(control.viewOnly(null)).toBe(false);
    control.set(a.id, 'agent');
    expect(control.blockedReason(b.id)).toBeNull();
    expect(control.viewOnly(null)).toBe(true);
  });

  it('pause holds waiters until resumed; a hand-back note without a takeover waits for the next turn', async () => {
    const { control, mk } = setup(true);
    const a = mk('alpha');
    control.set(a.id, 'paused');
    let resumed = false;
    void control.waitUnpaused(a.id).then(() => { resumed = true; });
    await tick();
    expect(resumed).toBe(false);
    control.set(a.id, 'user');
    await tick();
    expect(resumed).toBe(true);
    control.set(a.id, 'agent', { note: 'cookies accepted' });
    expect(control.takeNote(a.id)).toBe('cookies accepted');
    expect(control.takeNote(a.id)).toBeUndefined();
  });
});

describe('request_takeover', () => {
  const tool = (s: ReturnType<typeof setup>, botId: string, roomId: string, parks: string[], signal = new AbortController().signal) => {
    const bot = s.repos.getBot(botId)!;
    const room = s.repos.getRoom(roomId)!;
    return takeoverTool({
      bot, room, turnId: 't1', hop: 0, causeId: 'cause-1', runId: 'run-1', repos: s.repos, control: s.control, signal,
      setState: () => undefined, park: (why) => parks.push(why),
    });
  };
  const card = (s: ReturnType<typeof setup>, roomId: string): Message => s.repos.messagesAfter(roomId, 0).find((m) => m.kind === 'takeover')!;

  it('posts a card, gives the user control, waits, and returns the hand-back note', async () => {
    const s = setup(true);
    const a = s.mk('shopper');
    const room = s.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [a.id], coordinatorBotId: null });
    const parks: string[] = [];
    const pending = tool(s, a.id, room.id, parks).handler({ reason: 'Log in to example.com' });
    await tick();
    expect(s.control.get(a.id)).toMatchObject({ control: 'user', takeover: { roomId: room.id, reason: 'Log in to example.com', parked: false } });
    expect((card(s, room.id).payload as TakeoverPayload).status).toBe('waiting');
    s.control.set(a.id, 'agent', { note: 'Logged in as shop@example.com' });
    const out = await pending;
    expect(out.isError).toBeFalsy();
    expect(JSON.stringify(out.content)).toContain('Logged in as shop@example.com');
    expect(card(s, room.id).payload).toMatchObject({ status: 'done', note: 'Logged in as shop@example.com' });
    expect(parks).toEqual([]);
    expect(s.control.get(a.id)).toMatchObject({ control: 'agent', takeover: null });
  });

  it('parks the turn when nobody hands back in time; the hand-back then resumes the bot with the note', async () => {
    const s = setup(true, { takeoverWaitMs: 10 });
    const a = s.mk('shopper');
    const room = s.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [a.id], coordinatorBotId: null });
    const resumed: { note: string | null; runId: string | null; causeId: string }[] = [];
    s.control.onParkedHandBack = (_b, t, note) => resumed.push({ note, runId: t.runId, causeId: t.causeId });
    const parks: string[] = [];
    const out = await tool(s, a.id, room.id, parks).handler({ reason: 'Solve the captcha' });
    expect(JSON.stringify(out.content)).toContain(TAKEOVER_PARKED);
    expect(parks).toHaveLength(1);
    expect(card(s, room.id).payload).toMatchObject({ status: 'parked' });
    expect(s.control.get(a.id)).toMatchObject({ control: 'user', takeover: { parked: true } });
    s.control.set(a.id, 'agent', { note: 'done' });
    expect(resumed).toEqual([{ note: 'done', runId: 'run-1', causeId: 'cause-1' }]);
    expect(card(s, room.id).payload).toMatchObject({ status: 'done' });
  });

  it('gives a parked takeover up after the max park age (fake clock) and hands control back', async () => {
    let t = 1_000;
    const s = setup(true, { takeoverWaitMs: 5, now: () => t });
    const a = s.mk('shopper');
    const room = s.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [a.id], coordinatorBotId: null });
    const resumed: (string | null)[] = [];
    s.control.onParkedHandBack = (_b, _t, note) => resumed.push(note);
    await tool(s, a.id, room.id, []).handler({ reason: 'Approve the 2FA prompt' });
    t += s.control.maxParkMs - 1;
    expect(s.control.sweep()).toEqual([]);
    t += 2;
    expect(s.control.sweep()).toEqual([a.id]);
    expect(resumed).toEqual([null]);
    expect(s.control.get(a.id)).toMatchObject({ control: 'agent', takeover: null });
    expect(card(s, room.id).payload).toMatchObject({ status: 'expired' });
  });

  it('refuses while the bot is paused', async () => {
    const s = setup(true);
    const a = s.mk('shopper');
    const room = s.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [a.id], coordinatorBotId: null });
    s.control.set(a.id, 'paused');
    expect((await tool(s, a.id, room.id, []).handler({ reason: 'Log in please' })).isError).toBe(true);
  });
});

describe('REST control route and the screen ticket', () => {
  const T = 'c'.repeat(32);
  let hub: Hub;
  let base: string;
  let dir: string;
  const { vnc, calls } = fakeVnc();
  const auth = { authorization: 'Bearer ' + T, 'content-type': 'application/json' };
  const api = async (p: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + p, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    return { status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null, location: r.headers.get('location') };
  };
  let A: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-control-hub-'));
    hub = createHub({
      port: 0, dbFile: ':memory:', skipBootstrap: true, token: T, vnc,
      computers: (db) => new ComputerManager(new ComputersRepo(db), {
        enabled: true, dir, dataDir: dir, systemctl: fakeSystemctl(), probe: async () => true, startTimeoutMs: 20, pollMs: 1,
      }),
    });
    base = 'http://127.0.0.1:' + (await hub.listen());
    A = (await api('/api/bots', 'POST', { name: 'Alpha', handle: 'alpha', allowedTools: ['Browser'] })).json.id;
    expect((await api('/api/computers/' + A + '/wake', 'POST', {})).status).toBe(200);
  });
  afterAll(async () => {
    await hub.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const redeem = async () => {
    const t = await api('/api/screen/ticket', 'POST', { botId: A });
    const r = await fetch(base + t.json.url, { redirect: 'manual' });
    return r.headers.get('location');
  };

  it('the viewer is view-only while the bot has control, and interactive once the user takes over', async () => {
    expect((await api('/api/screen?botId=' + A)).json.url).toBe(screenViewerPath(A, true));
    expect(await redeem()).toBe(screenViewerPath(A, true));

    const put = await api('/api/computers/' + A + '/control', 'PUT', { control: 'user', holder: 'laptop' });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ botId: A, control: 'user', holder: 'laptop' });
    expect((await api('/api/computers/' + A + '/control')).json.control).toBe('user');
    expect((await api('/api/screen?botId=' + A)).json.url).toBe(screenViewerPath(A, false));
    expect(await redeem()).toBe(screenViewerPath(A, false));
    expect(hub.control.blockedReason(A)).toBe(USER_HAS_CONTROL);
    await tick();
    expect(calls.at(-1)).toMatchObject({ on: false });

    expect((await api('/api/computers/' + A + '/control', 'PUT', { control: 'agent', note: 'all yours' })).json.control).toBe('agent');
    expect(hub.control.takeNote(A)).toBe('all yours');
    expect(await redeem()).toBe(screenViewerPath(A, true));
  });

  it('rejects a bad state, an unknown bot and a request without the hub token', async () => {
    expect((await api('/api/computers/' + A + '/control', 'PUT', { control: 'root' })).status).toBe(400);
    expect((await api('/api/computers/nope/control', 'PUT', { control: 'user' })).status).toBe(404);
    const r = await fetch(base + '/api/computers/' + A + '/control', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"control":"user"}' });
    expect(r.status).toBe(401);
    expect(hub.control.get(A).control).toBe('agent');
  });
});
