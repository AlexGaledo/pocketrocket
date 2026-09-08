// Group-chat smoke: 3 bots, coordinator, @mention fan-out + handoff. Prints events until all bots idle for 8s.
import WebSocket from 'ws';
const BASE = process.env.HUB ?? 'http://127.0.0.1:7788';
const text = process.argv[2] ?? '@planner: we need a tiny CLI script `greet.js` in the workspace that prints "hello <name>". Split into: @coder writes it, @reviewer checks it and reports back. Keep every message to 2 sentences.';

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
const want = [
  { name: 'Planner', handle: 'planner', title: 'Coordinator', avatar: '🧭', description: 'You coordinate. Split work, delegate with @handle mentions or handoff tool, then summarize. Never write code yourself. 2 sentences max per message.' },
  { name: 'Coder', handle: 'coder', title: 'Engineer', avatar: '🛠️', description: 'You write code in the workspace when asked. After finishing, @mention whoever should review. 2 sentences max per message.' },
  { name: 'Reviewer', handle: 'reviewer', title: 'Reviewer', avatar: '🧐', description: 'You review files in the workspace and report findings to @planner. Never edit files. 2 sentences max per message.' },
];
const bots = await api('GET', '/api/bots');
const ids = [];
for (const w of want) {
  let b = bots.find((x) => x.handle === w.handle);
  if (!b) b = await api('POST', '/api/bots', w);
  ids.push(b.id);
}
const byId = Object.fromEntries((await api('GET', '/api/bots')).map((b) => [b.id, b]));
let rooms = await api('GET', '/api/rooms');
let room = rooms.find((r) => r.name === 'smoke-team');
if (!room) room = await api('POST', '/api/rooms', { kind: 'group', name: 'smoke-team', memberIds: ids, coordinatorBotId: ids[0] });
console.log('room', room.id, room.memberIds.map((i) => byId[i].handle));

const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
await new Promise((r) => ws.once('open', r));
let idleTimer;
const bump = () => { clearTimeout(idleTimer); idleTimer = setTimeout(done, 12000); };
async function done() {
  const u = await api('GET', '/api/usage?roomId=' + room.id);
  console.log('\nROOM USAGE', u.totals);
  process.exit(0);
}
ws.on('message', (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.type === 'hello' || ev.type === 'turn.delta') return;
  if (ev.roomId && ev.roomId !== room.id && ev.type !== 'bot.state') return;
  bump();
  const who = (id) => (byId[id]?.handle ?? id);
  if (ev.type === 'message.new') {
    const m = ev.message;
    if (m.roomId !== room.id) return;
    const a = m.authorType === 'user' ? 'alex' : m.authorType === 'system' ? 'system' : '@' + who(m.authorId);
    console.log('#' + m.seq, '[' + a + ']', m.kind, 'hop' + m.hop, JSON.stringify(m.kind === 'tool' ? m.payload.name + ' ' + JSON.stringify(m.payload.input).slice(0, 80) : m.text).slice(0, 220));
  } else if (ev.type === 'bot.state') console.log('   state', who(ev.botId), ev.state);
  else if (ev.type === 'turn.start') console.log('   turn.start', who(ev.botId), 'hop', ev.hop);
  else if (ev.type === 'turn.end') console.log('   turn.end', who(ev.botId), ev.error ?? '', '$' + (ev.costUsd ?? 0).toFixed(3));
  else if (ev.type === 'approval.request') { console.log('   APPROVAL', ev.approval.toolName, ev.approval.reason); ws.send(JSON.stringify({ type: 'approval.decide', approvalId: ev.approval.approvalId, decision: 'allow' })); }
  else if (ev.type === 'message.update') { /* quiet */ }
  else console.log('   ' + ev.type, JSON.stringify(ev).slice(0, 160));
});
ws.send(JSON.stringify({ type: 'message.send', roomId: room.id, text }));
bump();
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 420000);
