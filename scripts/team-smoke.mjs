// Team-building smoke: one coordinator bot in an otherwise empty group chat creates its own specialists.
//
// Usage: node scripts/team-smoke.mjs [--token <hex>] [--data <dir>] ["message text"]
// The hub always requires a token: --token, then POCKETROCKET_TOKEN, then <data>/hub-token
// (--data, POCKETROCKET_DATA, or <repo>/data).
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const dataFlag = flag('data');
function tokenFromDataDir() {
  const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = dataFlag ? nodePath.resolve(dataFlag) : process.env.POCKETROCKET_DATA ? nodePath.resolve(process.env.POCKETROCKET_DATA) : nodePath.join(repoRoot, 'data');
  try {
    return fs.readFileSync(nodePath.join(dir, 'hub-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
const TOKEN = flag('token') ?? process.env.POCKETROCKET_TOKEN ?? tokenFromDataDir();
if (!TOKEN) console.warn('[team-smoke] no token found (--token, POCKETROCKET_TOKEN or <data>/hub-token); expect 401s');
const authHeaders = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};

const BASE = process.env.HUB ?? 'http://127.0.0.1:7788';
const text = argv[0] ?? 'We have no team yet. Create a @researcher (web tools only) and a @writer, then ask @researcher for 3 one-line facts about pnpm workspaces and have @writer turn them into a single tweet. Keep every message under 3 sentences.';

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...authHeaders }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
let bots = await api('GET', '/api/bots');
let chief = bots.find((b) => b.handle === 'chief');
if (!chief) chief = await api('POST', '/api/bots', { name: 'Chief', handle: 'chief', title: 'Chief of staff', avatar: '🧭', description: 'You coordinate. If a needed role is missing, create it with create_bot. Delegate with @handle, then summarize. Never do specialist work yourself. Max 3 sentences per message.' });
let rooms = await api('GET', '/api/rooms');
let room = rooms.find((r) => r.name === 'team-build');
if (!room) room = await api('POST', '/api/rooms', { kind: 'group', name: 'team-build', memberIds: [chief.id], coordinatorBotId: chief.id });
console.log('room', room.id, 'members', room.memberIds.length);

const byId = {};
const refresh = async () => { for (const b of await api('GET', '/api/bots')) byId[b.id] = b; };
await refresh();
const who = (id) => byId[id]?.handle ?? id;

const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
await new Promise((r) => ws.once('open', r));
let idleTimer;
const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(done, 15000); };
async function done() {
  const r = await api('GET', '/api/rooms').then((rs) => rs.find((x) => x.id === room.id));
  const u = await api('GET', '/api/usage?roomId=' + room.id);
  console.log('\nFINAL members:', r.memberIds.map(who), '| bots on account:', Object.values(byId).map((b) => b.handle));
  console.log('ROOM USAGE $' + u.totals.costUsd.toFixed(3), u.totals.turns, 'turns');
  process.exit(0);
}
ws.on('message', async (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.type === 'hello' || ev.type === 'turn.delta' || ev.type === 'usage.updated' || ev.type === 'message.update') return;
  if (ev.type === 'bots.changed') { await refresh(); console.log('   bots.changed ->', ev.bots.map((b) => '@' + b.handle).join(' ')); bump(); return; }
  if (ev.type === 'rooms.changed') { const r = ev.rooms.find((x) => x.id === room.id); console.log('   rooms.changed -> members', r?.memberIds.map(who)); bump(); return; }
  if (ev.roomId && ev.roomId !== room.id && ev.type !== 'bot.state') return;
  bump();
  if (ev.type === 'message.new') {
    const m = ev.message;
    if (m.roomId !== room.id) return;
    const a = m.authorType === 'user' ? 'alex' : m.authorType === 'system' ? 'system' : '@' + who(m.authorId);
    console.log('#' + m.seq, '[' + a + ']', m.kind, 'hop' + m.hop, JSON.stringify(m.kind === 'tool' ? m.payload.name.replace('mcp__pocketrocket__', '⚡') + ' ' + JSON.stringify(m.payload.input).slice(0, 90) : m.text).slice(0, 230));
  } else if (ev.type === 'turn.end') console.log('   turn.end', who(ev.botId), ev.error ?? '', '$' + (ev.costUsd ?? 0).toFixed(3));
  else if (ev.type === 'approval.request') { console.log('   APPROVAL', ev.approval.toolName, ev.approval.reason); ws.send(JSON.stringify({ type: 'approval.decide', approvalId: ev.approval.approvalId, decision: 'allow' })); }
  else if (ev.type === 'error') console.log('   ERROR', ev.message);
});
ws.send(JSON.stringify({ type: 'message.send', roomId: room.id, text }));
bump();
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 480000);
