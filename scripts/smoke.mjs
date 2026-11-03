// Smoke test against a running hub: creates a bot + DM, sends a message, prints WS events until turn.end.
//
// Usage: node scripts/smoke.mjs [--port 7788] [--token <hex>] [--data <dir>] ["message text"]
//        HUB=http://127.0.0.1:7791 POCKETROCKET_TOKEN=<hex> node scripts/smoke.mjs "…"
//
// The hub always requires a token now. Resolution order: --token, POCKETROCKET_TOKEN, then the
// `hub-token` file the hub writes into its data dir (--data, POCKETROCKET_DATA, or <repo>/data).
import fs from 'node:fs';
import path from 'node:path';
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
const port = flag('port');
const dataFlag = flag('data');

/** The token the running hub minted, from <data>/hub-token. */
function tokenFromDataDir() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = dataFlag ? path.resolve(dataFlag) : process.env.POCKETROCKET_DATA ? path.resolve(process.env.POCKETROCKET_DATA) : path.join(repoRoot, 'data');
  try {
    const t = fs.readFileSync(path.join(dir, 'hub-token'), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}
const TOKEN = flag('token') ?? process.env.POCKETROCKET_TOKEN ?? tokenFromDataDir();
if (!TOKEN) console.warn('[smoke] no token found (--token, POCKETROCKET_TOKEN or <data>/hub-token); expect 401s');
const BASE = port ? 'http://127.0.0.1:' + port : (process.env.HUB ?? 'http://127.0.0.1:7788');
const text = argv[0] ?? 'Create a file hello.txt in the workspace containing "hi from pocketrocket", then tell me its full path.';

const authHeaders = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...authHeaders }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + JSON.stringify(j));
  return j;
}

const health = await api('GET', '/api/health');
console.log('health', health);
let bots = await api('GET', '/api/bots');
let bot = bots.find((b) => b.handle === 'smoke');
if (!bot) bot = await api('POST', '/api/bots', { name: 'Smoke', handle: 'smoke', title: 'Smoke tester', description: 'You are a terse test bot.' });
let rooms = await api('GET', '/api/rooms');
let room = rooms.find((r) => r.kind === 'dm' && r.memberIds[0] === bot.id);
if (!room) room = await api('POST', '/api/rooms', { kind: 'dm', name: 'Smoke DM', memberIds: [bot.id], coordinatorBotId: null });
console.log('bot', bot.id, 'room', room.id);

const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
await new Promise((r) => ws.once('open', r));
let streamed = '';
ws.on('message', (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.type === 'hello') return;
  if (ev.type === 'turn.delta') { streamed += ev.text; process.stdout.write(ev.text); return; }
  if (ev.type === 'message.new') console.log('\n[message.new]', ev.message.kind, ev.message.authorType, JSON.stringify(ev.message.text).slice(0, 200), ev.message.payload ? JSON.stringify(ev.message.payload).slice(0, 200) : '');
  else if (ev.type === 'message.update') console.log('[message.update]', ev.id, JSON.stringify(ev.patch).slice(0, 200));
  else if (ev.type === 'approval.request') {
    console.log('[approval.request]', ev.approval.toolName, ev.approval.reason, '-> auto allow');
    ws.send(JSON.stringify({ type: 'approval.decide', approvalId: ev.approval.approvalId, decision: 'allow' }));
  } else console.log('[' + ev.type + ']', JSON.stringify(ev).slice(0, 300));
  if (ev.type === 'turn.end') {
    setTimeout(async () => {
      const sess = await api('GET', '/api/usage?botId=' + bot.id);
      console.log('usage', sess.totals);
      ws.close();
      process.exit(0);
    }, 500);
  }
});
ws.send(JSON.stringify({ type: 'message.send', roomId: room.id, text }));
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 180000);
