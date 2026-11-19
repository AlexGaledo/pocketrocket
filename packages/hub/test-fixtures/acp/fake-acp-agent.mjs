#!/usr/bin/env node
// A fake ACP agent for the adapter tests: newline-delimited JSON-RPC 2.0 on stdio, written by hand (not with the SDK)
// so the tests check the wire format the hub sends, not just that two copies of one library agree.
//
// Knobs (env, handed through AcpProviderOptions.env):
//   FAKE_ACP_RECORD    file: every message the client sent, one JSON per line, plus {"env":[...names]} at start
//   FAKE_ACP_SCENARIO  text | quiet | tool | cancel | limit | notice-limit | crash | silent-write | leave-mode |
//                      tool-only | tool-only-crash   (default text)
//   FAKE_ACP_NO_PLAN   1: offer no read-only (`plan`) mode
//   FAKE_ACP_SET_MODE_FAIL 1: session/set_mode answers with an error
//   FAKE_ACP_IGNORE_PLAN 1: silent-write writes even in `plan` (only a cancel before the write stops it)
//   FAKE_ACP_NO_HTTP   1: do not advertise mcpCapabilities.http
//   FAKE_ACP_RESUME    1: advertise sessionCapabilities.resume
//   FAKE_ACP_AUTH      session/new fails with auth_required (-32000)
//   FAKE_ACP_META_AUTH value reported as _meta.authMethod in initialize
//   FAKE_ACP_PROMPT_USAGE JSON put as `usage` on the session/prompt answer (the unstable ACP token counts)
//   FAKE_ACP_MODEL     session/new offers a `model` select option with this current value
//   FAKE_ACP_KIND / FAKE_ACP_PATH / FAKE_ACP_COMMAND  the tool scenario's permission request; FAKE_ACP_PATH is also
//                      the file silent-write writes
//
// silent-write is agy 1.5.12 in its `default` mode (live G6): it announces an edit and writes FAKE_ACP_PATH without
// any session/request_permission. Like agy's `plan` mode, it does not write while the session is in `plan`, and a
// session/cancel that arrives before the write stops it.
import fs from 'node:fs';

const env = process.env;
const record = (obj) => {
  if (env.FAKE_ACP_RECORD) fs.appendFileSync(env.FAKE_ACP_RECORD, JSON.stringify(obj) + '\n');
};
record({ env: Object.keys(process.env) });

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

let cancelled = null;
let promptId = null;
let mode = 'yolo';
const later = (ms) => new Promise((r) => setTimeout(r, ms));

async function onPrompt(id, params) {
  const sid = params.sessionId;
  const scenario = env.FAKE_ACP_SCENARIO || 'text';
  if (scenario === 'crash') process.exit(3);
  if (scenario === 'limit') {
    send({ id, error: { code: -32603, message: 'RESOURCE_EXHAUSTED: Quota exceeded for this account. Please retry in 120s.' } });
    return;
  }
  if (scenario === 'notice-limit') {
    update(sid, { sessionUpdate: 'notice', severity: 'error', title: 'Usage limit reached', description: 'RESOURCE_EXHAUSTED' });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (scenario === 'cancel') {
    chunk(sid, 'working on it');
    promptId = id;
    if (cancelled) send({ id, result: { stopReason: 'cancelled' } });
    return; // answered when session/cancel arrives
  }
  if (scenario === 'silent-write') {
    update(sid, {
      sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'write_file', kind: 'edit', status: 'pending',
      locations: [{ path: env.FAKE_ACP_PATH }], rawInput: { TargetFile: env.FAKE_ACP_PATH },
    });
    await later(300);
    const wrote = !cancelled && (mode !== 'plan' || env.FAKE_ACP_IGNORE_PLAN === '1');
    if (wrote) fs.writeFileSync(env.FAKE_ACP_PATH, 'probe');
    record({ silentWrite: wrote, mode });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: wrote ? 'completed' : 'failed' });
    if (cancelled) {
      send({ id, result: { stopReason: 'cancelled' } });
      return;
    }
    chunk(sid, wrote ? 'Wrote it.' : 'Plan mode: I would write the file.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (scenario === 'leave-mode') {
    update(sid, { sessionUpdate: 'current_mode_update', currentModeId: 'default' });
    await later(300);
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
    return;
  }
  if (scenario === 'tool-only' || scenario === 'tool-only-crash') {
    // Live G5: a Gemini bot that only called the hub's handoff tool and wrote no answer.
    update(sid, {
      sessionUpdate: 'tool_call', toolCallId: 'h1', title: 'mcp_pocketrocket_handoff', kind: 'other', status: 'in_progress',
      rawInput: { to: 'claude-bot', task: 'answer this' },
    });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'h1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'handed off' } }] });
    if (scenario === 'tool-only-crash') process.exit(3);
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (scenario === 'tool') {
    const kind = env.FAKE_ACP_KIND || 'edit';
    const toolCall = {
      toolCallId: 'tc1',
      title: 'Change a file',
      kind,
      status: 'pending',
      ...(env.FAKE_ACP_PATH ? { locations: [{ path: env.FAKE_ACP_PATH }] } : {}),
      ...(env.FAKE_ACP_COMMAND ? { rawInput: { command: env.FAKE_ACP_COMMAND } } : {}),
    };
    update(sid, { sessionUpdate: 'tool_call', ...toolCall });
    const answer = await ask('session/request_permission', {
      sessionId: sid,
      toolCall,
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    record({ permissionAnswer: answer });
    const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId !== 'no';
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: allowed ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: allowed ? 'file changed' : 'permission denied' } }],
    });
    chunk(sid, allowed ? 'Done.' : 'Could not.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (scenario === 'quiet') {
    // agy on Gemini: an answer, a context size, but no cost and (unless asked) no token counts.
    chunk(sid, 'Hi');
    update(sid, { sessionUpdate: 'usage_update', used: 24368, size: 1048576 });
    send({ id, result: { stopReason: 'end_turn', ...(env.FAKE_ACP_PROMPT_USAGE ? { usage: JSON.parse(env.FAKE_ACP_PROMPT_USAGE) } : {}) } });
    return;
  }
  // text
  chunk(sid, 'Hel');
  chunk(sid, 'lo there');
  update(sid, { sessionUpdate: 'usage_update', used: 12345, size: 200000, cost: { amount: 0.25, currency: 'USD' } });
  send({ id, result: { stopReason: 'end_turn' } });
}

function onMessage(msg) {
  record(msg);
  if (msg.id !== undefined && msg.method === undefined) {
    const r = waiting.get(msg.id);
    waiting.delete(msg.id);
    r?.(msg.result);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            mcpCapabilities: { http: env.FAKE_ACP_NO_HTTP !== '1' },
            ...(env.FAKE_ACP_RESUME === '1' ? { sessionCapabilities: { resume: {} } } : {}),
          },
          agentInfo: { name: 'fake-agy', version: '0.9.1' },
          authMethods: [],
          ...(env.FAKE_ACP_META_AUTH ? { _meta: { authMethod: env.FAKE_ACP_META_AUTH } } : {}),
        },
      });
      return;
    case 'session/new':
      if (env.FAKE_ACP_AUTH) {
        send({ id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      send({
        id,
        result: {
          sessionId: 'sess-1',
          modes: {
            currentModeId: 'yolo',
            availableModes: [
              { id: 'yolo', name: 'YOLO', description: 'run everything without asking' },
              { id: 'default', name: 'Default', description: 'ask before edits and shell' },
              ...(env.FAKE_ACP_NO_PLAN === '1' ? [] : [{ id: 'plan', name: 'Plan', description: 'read only' }]),
            ],
          },
          ...(env.FAKE_ACP_MODEL
            ? {
                configOptions: [
                  {
                    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: env.FAKE_ACP_MODEL,
                    options: [{ value: env.FAKE_ACP_MODEL, name: env.FAKE_ACP_MODEL }],
                  },
                ],
              }
            : {}),
        },
      });
      return;
    case 'session/resume':
      if (params.sessionId === 'gone') send({ id, error: { code: -32002, message: 'Resource not found: ' + params.sessionId } });
      else send({ id, result: {} });
      return;
    case 'session/set_mode':
      if (env.FAKE_ACP_SET_MODE_FAIL === '1') {
        send({ id, error: { code: -32603, message: 'mode change not allowed' } });
        return;
      }
      mode = params.modeId;
      send({ id, result: {} });
      return;
    case 'session/set_config_option':
      send({ id, result: {} });
      return;
    case 'session/prompt':
      void onPrompt(id, params);
      return;
    case 'session/cancel':
      cancelled = true;
      if (promptId !== null) send({ id: promptId, result: { stopReason: 'cancelled' } });
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) onMessage(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
