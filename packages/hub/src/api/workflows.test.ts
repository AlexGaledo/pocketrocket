import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { Bot, Room, WorkflowGraph, WorkflowNode } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import type { TurnRequest, TurnResult } from '../agent/BotRunner.js';

/**
 * Workflows 3.3 / 3.4: the REST surface. Statuses (400 / 404 / 409 / 403), the person-only approval card (no bot, no
 * runner token, no WS `approval.decide`, no chat text answers it), phones may see and answer but not build, and the
 * file output node writes only inside the room's files folder.
 */

const TOKEN = 'workflows-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-wf-rest-'));
const roomsDir = path.join(tmp, 'rooms');
let hub: Hub;
let port: number;
const turns: TurnRequest[] = [];
let reply = 'the draft';

beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir,
    dmFilesDir: (id) => path.join(tmp, 'bots', id, 'files'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json'), pollMs: 5, waitMs: 60_000 },
  });
  hub.runner.runTurn = async (req: TurnRequest): Promise<TurnResult> => { turns.push(req); return { ok: true, turnId: 't', finalText: reply, costUsd: 0 }; };
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

let n = 0;
function team() {
  const bot: Bot = hub.repos.createBot({ name: 'w' + n, handle: 'wf-bot-' + n++, title: '', description: 'x', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room: Room = hub.repos.createRoom({ kind: 'group', name: 'WF', memberIds: [bot.id], coordinatorBotId: null });
  return { bot, room };
}
const trig: WorkflowNode = { id: 't', kind: 'trigger', routineId: null, triggerId: null, manual: true };
const line = (...steps: WorkflowNode[]): WorkflowGraph => {
  const nodes = [trig, ...steps];
  return { nodes, edges: nodes.slice(1).map((x, i) => ({ from: nodes[i].id, to: x.id })) };
};
const body = (t: { bot: Bot; room: Room }, graph?: WorkflowGraph, extra: object = {}) => ({
  name: 'Flow', roomId: t.room.id, budgetUsd: 1, graph: graph ?? line({ id: 'a', kind: 'agent', botId: t.bot.id, prompt: 'Draft it' }, { id: 'ok', kind: 'approval', title: 'Send?' }, { id: 'o', kind: 'output', target: 'room' }), ...extra,
});

async function pairDevice() {
  const minted = await request('POST', '/api/devices/pairing', { body: {} });
  const r = await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'phone' } });
  return r.json.token as string;
}

describe('workflows REST', () => {
  it('create, list, get, patch (unsent fields stay), delete; bad input is 400, missing is 404', async () => {
    const t = team();
    const c = await request('POST', '/api/workflows', { body: body(t) });
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ name: 'Flow', enabled: true, budgetUsd: 1, lastRun: null });
    expect((await request('GET', '/api/workflows')).json.map((w: { id: string }) => w.id)).toContain(c.json.id);
    expect((await request('GET', '/api/workflows/' + c.json.id)).json.name).toBe('Flow');

    const p = await request('PATCH', '/api/workflows/' + c.json.id, { body: { name: 'Renamed' } });
    expect(p.json).toMatchObject({ name: 'Renamed', budgetUsd: 1, enabled: true, roomId: t.room.id });
    expect((await request('PATCH', '/api/workflows/' + c.json.id, { body: { enabled: false } })).json).toMatchObject({ name: 'Renamed', enabled: false });
    expect((await request('PATCH', '/api/workflows/' + c.json.id, { body: { budgetUsd: -1 } })).status).toBe(400);

    expect((await request('POST', '/api/workflows', { body: { name: '' } })).status).toBe(400);
    expect((await request('POST', '/api/workflows', { body: body(t, { nodes: [trig], edges: [] }) })).status).toBe(400);
    expect((await request('POST', '/api/workflows', { body: { ...body(t), roomId: 'nope' } })).status).toBe(400);
    expect((await request('GET', '/api/workflows/nope')).status).toBe(404);
    expect((await request('PATCH', '/api/workflows/nope', { body: { name: 'x' } })).status).toBe(404);
    expect((await request('DELETE', '/api/workflows/nope')).status).toBe(404);
    expect((await request('POST', '/api/workflows/nope/run')).status).toBe(404);
    expect((await request('GET', '/api/workflow-runs/nope')).status).toBe(404);

    expect((await request('DELETE', '/api/workflows/' + c.json.id)).status).toBe(200);
    expect((await request('GET', '/api/workflows/' + c.json.id)).status).toBe(404);
  });

  it('needs the hub token', async () => {
    expect((await request('GET', '/api/workflows', { token: null })).status).toBe(401);
    expect((await request('GET', '/api/workflow-cards', { token: 'wrong' })).status).toBe(401);
  });

  it('Run now: a run, then an approval card; only a decision moves it; a second run is a 409 while it waits', async () => {
    const t = team();
    const c = (await request('POST', '/api/workflows', { body: body(t) })).json;
    const r = await request('POST', '/api/workflows/' + c.id + '/run');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'running', manual: true });
    await until(() => hub.workflowRepo.getRun(r.json.id)?.status === 'waiting');
    expect((await request('POST', '/api/workflows/' + c.id + '/run')).status).toBe(409);
    expect((await request('DELETE', '/api/workflows/' + c.id)).status).toBe(409);

    const cards = (await request('GET', '/api/workflow-cards')).json;
    expect(cards.find((x: { runId: string }) => x.runId === r.json.id)).toMatchObject({ title: 'Send?', draft: 'the draft', canSendBack: true });
    const detail = (await request('GET', '/api/workflow-runs/' + r.json.id)).json;
    expect(detail.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done', 'waiting', 'pending']);
    expect(detail).not.toHaveProperty('graph');

    expect((await request('POST', '/api/workflow-runs/' + r.json.id + '/decision', { body: { decision: 'maybe' } })).status).toBe(400);
    expect((await request('POST', '/api/workflow-runs/' + r.json.id + '/decision', { body: { decision: 'send_back' } })).status).toBe(400); // a note is required
    expect((await request('POST', '/api/workflow-runs/' + r.json.id + '/decision', { body: { decision: 'approve' } })).status).toBe(200);
    await until(() => hub.workflowRepo.getRun(r.json.id)?.status === 'success');
    expect((await request('POST', '/api/workflow-runs/' + r.json.id + '/decision', { body: { decision: 'approve' } })).status).toBe(409);
    expect((await request('GET', '/api/workflows/' + c.id + '/runs?limit=5')).json[0]).toMatchObject({ id: r.json.id, status: 'success' });
    expect((await request('POST', '/api/workflow-runs/' + r.json.id + '/cancel')).status).toBe(409);
    expect((await request('POST', '/api/workflow-runs/' + r.json.id + '/retry')).status).toBe(409);
  });

  it('cancel stops a waiting run; retry refuses a run that did not error', async () => {
    const t = team();
    const c = (await request('POST', '/api/workflows', { body: body(t) })).json;
    const r = (await request('POST', '/api/workflows/' + c.id + '/run')).json;
    await until(() => hub.workflowRepo.getRun(r.id)?.status === 'waiting');
    expect((await request('POST', '/api/workflow-runs/' + r.id + '/retry')).status).toBe(409);
    expect((await request('POST', '/api/workflow-runs/' + r.id + '/cancel')).json.status).toBe('cancelled');
    expect((await request('GET', '/api/workflow-cards')).json.some((x: { runId: string }) => x.runId === r.id)).toBe(false);
  });
});

describe('the approval card is person-only', () => {
  async function waiting() {
    const t = team();
    const c = (await request('POST', '/api/workflows', { body: body(t) })).json;
    const r = (await request('POST', '/api/workflows/' + c.id + '/run')).json;
    await until(() => hub.workflowRepo.getRun(r.id)?.status === 'waiting');
    return { t, runId: r.id as string };
  }

  it('the PC runner token, a bad token and no token cannot answer it', async () => {
    const { runId } = await waiting();
    const minted = await request('POST', '/api/pc-runner/token', { body: {} });
    const runnerToken = minted.json.token as string;
    const path_ = '/api/workflow-runs/' + runId + '/decision';
    expect((await request('POST', path_, { token: runnerToken, body: { decision: 'approve' } })).status).toBe(403);
    expect((await request('POST', path_, { token: 'wrong', body: { decision: 'approve' } })).status).toBe(401);
    expect((await request('POST', path_, { token: null, body: { decision: 'approve' } })).status).toBe(401);
    expect(hub.workflowRepo.getRun(runId)?.status).toBe('waiting');
    await request('DELETE', '/api/pc-runner');
  });

  it('a bot message, a cta button and chat text leave it waiting', async () => {
    const { t, runId } = await waiting();
    hub.repos.insertMessage({ roomId: t.room.id, authorType: 'bot', authorId: t.bot.id, kind: 'text', text: 'approve ' + runId, payload: null, causeId: null, hop: 0, turnId: null });
    await request('POST', '/api/rooms/' + t.room.id + '/messages', { body: { text: 'approve ' + runId + ' @' + t.bot.handle } });
    await new Promise((r) => setTimeout(r, 60));
    expect(hub.workflowRepo.getRun(runId)?.status).toBe('waiting');
  });

  it('a WebSocket approval.decide (the tool-approval answer) does not answer it, with the run id or anything else', async () => {
    const { runId } = await waiting();
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(TOKEN));
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    for (const decision of ['allow', 'always', 'deny']) ws.send(JSON.stringify({ type: 'approval.decide', approvalId: runId, decision }));
    await new Promise((r) => setTimeout(r, 80));
    ws.close();
    expect(hub.workflowRepo.getRun(runId)?.status).toBe('waiting');
  });

  it('a paired phone sees runs and answers the card, but cannot create, edit, run or delete workflows', async () => {
    const { t, runId } = await waiting();
    const phone = await pairDevice();
    expect((await request('GET', '/api/workflows', { token: phone })).status).toBe(200);
    expect((await request('GET', '/api/workflow-cards', { token: phone })).status).toBe(200);
    expect((await request('GET', '/api/workflow-runs/' + runId, { token: phone })).status).toBe(200);
    expect((await request('POST', '/api/workflows', { token: phone, body: body(t) })).status).toBe(403);
    const wid = hub.workflowRepo.getRun(runId)!.workflowId;
    expect((await request('PATCH', '/api/workflows/' + wid, { token: phone, body: { name: 'x' } })).status).toBe(403);
    expect((await request('DELETE', '/api/workflows/' + wid, { token: phone })).status).toBe(403);
    expect((await request('POST', '/api/workflows/' + wid + '/run', { token: phone })).status).toBe(403);
    expect((await request('POST', '/api/workflow-runs/' + runId + '/cancel', { token: phone })).status).toBe(403);
    expect((await request('POST', '/api/workflow-runs/' + runId + '/decision', { token: phone, body: { decision: 'approve' } })).status).toBe(200);
    await until(() => hub.workflowRepo.getRun(runId)?.status === 'success');
  });
});

describe('output nodes', () => {
  const fileFlow = (t: { bot: Bot; room: Room }, p: string) =>
    body(t, line({ id: 'a', kind: 'agent', botId: t.bot.id, prompt: 'Write the report' }, { id: 'f', kind: 'output', target: 'file', path: p }));
  const roomDir = (t: { room: Room }) => path.join(roomsDir, t.room.id);

  it('file writes the last output into the room files folder, and posts nothing else to the chat', async () => {
    reply = '# Weekly\nall good';
    const t = team();
    const c = (await request('POST', '/api/workflows', { body: fileFlow(t, 'reports/week-1.md') })).json;
    const r = (await request('POST', '/api/workflows/' + c.id + '/run')).json;
    await until(() => hub.workflowRepo.getRun(r.id)?.status === 'success');
    const found = fs.readdirSync(roomDir(t), { recursive: true }).map(String).find((f) => f.replaceAll('\\', '/').endsWith('reports/week-1.md'));
    expect(found).toBeTruthy();
    expect(fs.readFileSync(path.join(roomDir(t), found!), 'utf8')).toBe('# Weekly\nall good');
    expect(hub.workflowRepo.getRun(r.id)!.steps.at(-1)!.output).toBe('Saved to reports/week-1.md');
  });

  it('a path that tries to leave the folder is refused at save (400), and again at Run now if it got into the database anyway', async () => {
    reply = 'x';
    const t = team();
    for (const p of ['../escape.md', '..\\escape.md', '/etc/passwd', 'C:\\Windows\\x.md', 'a/../../escape.md']) {
      expect((await request('POST', '/api/workflows', { body: fileFlow(t, p) })).status, p).toBe(400);
    }
    const c = (await request('POST', '/api/workflows', { body: fileFlow(t, 'ok.md') })).json;
    // Bypass the validation the way a tampered database would.
    hub.workflowRepo.update(c.id, { graph: line({ id: 'a', kind: 'agent', botId: t.bot.id, prompt: 'x' }, { id: 'f', kind: 'output', target: 'file', path: '../../escape.md' }) });
    // Run now checks the stored graph again, so nothing starts.
    expect((await request('POST', '/api/workflows/' + c.id + '/run')).status).toBe(400);
    expect(hub.workflowRepo.activeRun(c.id)).toBeUndefined();
    expect(fs.existsSync(path.join(roomsDir, 'escape.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'escape.md'))).toBe(false);
  });

  it('room posts the last output to the chat as the bot that wrote it', async () => {
    reply = 'hello team';
    const t = team();
    const c = (await request('POST', '/api/workflows', { body: body(t, line({ id: 'a', kind: 'agent', botId: t.bot.id, prompt: 'Say hi' }, { id: 'o', kind: 'output', target: 'room' })) })).json;
    const r = (await request('POST', '/api/workflows/' + c.id + '/run')).json;
    await until(() => hub.workflowRepo.getRun(r.id)?.status === 'success');
    const last = hub.repos.listMessages(t.room.id, { limit: 20 }).at(-1)!;
    expect(last).toMatchObject({ text: 'hello team', authorId: t.bot.id });
  });
});

describe('routines and triggers that a workflow uses', () => {
  it('a routine with a workflow starts a run instead of its prompt, and cannot be deleted while the workflow uses it (409)', async () => {
    reply = 'ran';
    const t = team();
    const routine = hub.repos.createRoutine({ name: 'Mon', botId: t.bot.id, roomId: t.room.id, prompt: 'plain prompt', cron: '0 9 * * 1', onceAt: null, enabled: true } as never);
    const g = line({ id: 'a', kind: 'agent', botId: t.bot.id, prompt: 'Do {{previous}}' });
    g.nodes[0] = { ...trig, routineId: routine.id, manual: false } as WorkflowNode;
    const c = await request('POST', '/api/workflows', { body: body(t, g) });
    expect(c.status).toBe(200);
    const before = turns.length;
    expect((await request('POST', '/api/routines/' + routine.id + '/run')).json.ok).toBe(true);
    await until(() => hub.workflowRepo.lastRun(c.json.id)?.status === 'success');
    expect(turns.length).toBe(before + 1);
    expect(turns.at(-1)!.injected).toContain('[Workflow "Flow"');
    expect(hub.repos.listRuns(routine.id)).toHaveLength(0); // no routine run: the workflow run replaced it
    expect((await request('DELETE', '/api/routines/' + routine.id)).status).toBe(409);
    await request('DELETE', '/api/workflows/' + c.json.id);
    expect((await request('DELETE', '/api/routines/' + routine.id)).status).toBe(200);
  });

  it('a workflow cannot name a routine that does not exist', async () => {
    const t = team();
    const g = line({ id: 'a', kind: 'agent', botId: t.bot.id, prompt: 'x' });
    g.nodes[0] = { ...trig, routineId: 'ghost', manual: false } as WorkflowNode;
    expect((await request('POST', '/api/workflows', { body: body(t, g) })).status).toBe(400);
  });
});
