import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_PREFIX, TurnTracker, chipName, permissionToTool, type OcEvent } from './events.js';
import type { TurnSink } from '../types.js';

// Both fixtures are raw `GET /event` captures from a live `opencode serve` 1.17.6 (free OpenCode Zen model),
// one line per SSE event, heartbeats stripped.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-fixtures', 'opencode');

function load(name: string): OcEvent[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OcEvent);
}

interface Recorded {
  sink: TurnSink;
  deltas: string[];
  texts: string[];
  tools: Array<{ id: string; name: string; input: unknown }>;
  results: Array<{ id: string; output: string; isError: boolean }>;
  states: string[];
  sessions: string[];
}

function recorder(): Recorded {
  const r: Partial<Recorded> = { deltas: [], texts: [], tools: [], results: [], states: [], sessions: [] };
  r.sink = {
    onSession: (t) => r.sessions!.push(t),
    onDelta: (t) => r.deltas!.push(t),
    onText: (t) => r.texts!.push(t),
    onToolUse: (id, name, input) => r.tools!.push({ id, name, input }),
    onToolResult: (id, output, isError) => r.results!.push({ id, output, isError }),
    onState: (s) => r.states!.push(s),
  };
  return r as Recorded;
}

interface Harness {
  rec: Recorded;
  tracker: TurnTracker;
  asks: Array<{ name: string; input: Record<string, unknown>; reason: string }>;
  replies: Array<{ id: string; response: string }>;
  pending: Array<{ tool: string; pending: boolean }>;
  overBudget: number[];
}

function harness(sessionID: string, decision: 'allow' | 'deny' = 'allow', maxBudgetUsd = 5): Harness {
  const rec = recorder();
  const asks: Harness['asks'] = [];
  const replies: Harness['replies'] = [];
  const pending: Harness['pending'] = [];
  const overBudget: number[] = [];
  const tracker = new TurnTracker(
    sessionID,
    {
      sink: rec.sink,
      permission: async (name, input, extra) => {
        asks.push({ name, input, reason: extra.reason });
        return decision;
      },
      reply: async (id, response) => {
        replies.push({ id, response });
      },
      onOverBudget: (c) => overBudget.push(c),
      onMcpToolPending: (tool, p) => pending.push({ tool, pending: p }),
    },
    maxBudgetUsd,
  );
  return { rec, tracker, asks, replies, pending, overBudget };
}

/** Feed a whole capture; permission handling is async, so let the microtask queue drain between events. */
async function play(tracker: TurnTracker, events: OcEvent[], sessionID: string) {
  for (const ev of events) {
    const sid = (ev.properties as { sessionID?: string } | undefined)?.sessionID;
    if (sid !== sessionID) continue;
    tracker.handle(ev);
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('opencode tool name mapping', () => {
  it('capitalises built-ins and strips the MCP server prefix from hub tools', () => {
    expect(chipName('bash')).toBe('Bash');
    expect(chipName('webfetch')).toBe('WebFetch');
    expect(chipName('apply_patch')).toBe('ApplyPatch');
    expect(chipName(MCP_TOOL_PREFIX + 'send_message')).toBe('send_message');
    expect(chipName('something_new')).toBe('SomethingNew');
  });
});

describe('permission ask -> hub tool', () => {
  const noTool = () => undefined;

  it('maps a bash ask to Bash + command', () => {
    const m = permissionToTool(
      { id: 'per_1', sessionID: 's', permission: 'bash', metadata: { command: 'echo hello', description: 'Run echo hello command' } },
      noTool,
    );
    expect(m).toMatchObject({ name: 'Bash', input: { command: 'echo hello' }, reason: 'Run echo hello command' });
  });

  it('maps an edit ask to the triggering tool + file_path', () => {
    const m = permissionToTool(
      {
        id: 'per_2',
        sessionID: 's',
        permission: 'edit',
        metadata: { filepath: 'C:\\ws\\a.txt', diff: 'Index: ...' },
        tool: { messageID: 'msg', callID: 'call-1' },
      },
      (id) => (id === 'call-1' ? 'write' : undefined),
    );
    expect(m).toMatchObject({ name: 'Write', input: { file_path: 'C:\\ws\\a.txt' } });
  });

  it('maps external_directory to the triggering tool so path rules apply', () => {
    const m = permissionToTool(
      {
        id: 'per_3',
        sessionID: 's',
        permission: 'external_directory',
        metadata: { filepath: 'C:\\Users\\alex\\Desktop\\pr-test.txt', parentDir: 'C:\\Users\\alex\\Desktop' },
        tool: { messageID: 'msg', callID: 'call-2' },
      },
      () => 'read',
    );
    expect(m.name).toBe('Read');
    expect(m.input.file_path).toBe('C:\\Users\\alex\\Desktop\\pr-test.txt');
  });

  it('falls back to the triggering tool call input when a read ask carries empty metadata', () => {
    // Verified on opencode 1.17.6: `read` asks arrive with `metadata: {}` and only a project-relative pattern.
    const m = permissionToTool(
      { id: 'per_4', sessionID: 's', permission: 'read', patterns: ['data\\workspace\\probe1.txt'], metadata: {}, tool: { messageID: 'm', callID: 'c' } },
      () => 'read',
      () => ({ filePath: 'C:\\ws\\data\\workspace\\probe1.txt' }),
    );
    expect(m).toMatchObject({ name: 'Read', input: { file_path: 'C:\\ws\\data\\workspace\\probe1.txt' } });
    // With no tool input either, the project-relative pattern is still better than nothing.
    expect(
      permissionToTool({ id: 'p', sessionID: 's', permission: 'read', patterns: ['a\\b.txt'], metadata: {} }, () => 'read').input.file_path,
    ).toBe('a\\b.txt');
  });

  it('maps webfetch and unknown permissions', () => {
    expect(permissionToTool({ id: 'p', sessionID: 's', permission: 'webfetch', metadata: { url: 'https://x.dev' } }, noTool)).toMatchObject({
      name: 'WebFetch',
      input: { url: 'https://x.dev' },
    });
    expect(permissionToTool({ id: 'p', sessionID: 's', permission: 'doom_loop', metadata: { n: 3 } }, noTool)).toMatchObject({
      name: 'DoomLoop',
      input: { n: 3 },
    });
  });
});

describe('TurnTracker over a captured MCP + external_directory run', () => {
  const SESSION = 'ses_f7ea9b779ffeKFmruU6kUzF4XN';

  it('reports text, tool chips, the permission ask, cost and the idle terminator', async () => {
    const h = harness(SESSION, 'deny');
    await play(h.tracker, load('events-mcp-external.jsonl'), SESSION);
    await h.tracker.finished;

    // Reasoning deltas never reach the room; only the assistant's visible text part does.
    expect(h.rec.deltas).toEqual(['done']);
    expect(h.rec.texts).toEqual(['done']);

    expect(h.rec.tools.map((t) => t.name)).toEqual(['ping_probe', 'Write']);
    expect(h.rec.tools[0].input).toEqual({ note: 'hi' });
    expect(h.rec.results).toEqual([
      { id: 'call-9e4c4f55-91d2-4ccb-8f92-43d6cb24b862', output: 'The user rejected permission to use this specific tool call.', isError: true },
      { id: 'call-85ab9ed3-f924-46d2-b963-dd345651f7bb', output: 'pong {"note":"hi"}', isError: false },
    ]);

    // The out-of-project write raised exactly one ask, mapped onto the Write tool, and was rejected.
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ name: 'Write', input: { file_path: 'C:\\Users\\alex\\Desktop\\pr-test.txt' } });
    expect(h.replies).toEqual([{ id: 'per_081576943001sXj3pt4sY2XhoP', response: 'reject' }]);

    // The MCP call was flagged for the bridge while it was in flight, then cleared.
    expect(h.pending).toEqual([
      { tool: 'pocketrocket_ping_probe', pending: true },
      { tool: 'pocketrocket_ping_probe', pending: true },
      { tool: 'pocketrocket_ping_probe', pending: false },
    ]);

    expect(h.tracker.totals()).toEqual({ costUsd: 0.0125, inputTokens: 12587, outputTokens: 82, cacheReadTokens: 7, cacheWriteTokens: 3 });
    expect(h.tracker.error).toBeUndefined();
  });

  it('answers `once` when the broker allows', async () => {
    const h = harness(SESSION, 'allow');
    await play(h.tracker, load('events-mcp-external.jsonl'), SESSION);
    expect(h.replies).toEqual([{ id: 'per_081576943001sXj3pt4sY2XhoP', response: 'once' }]);
  });

  it('aborts when the accumulated cost passes the budget', async () => {
    const h = harness(SESSION, 'allow', 0.001);
    await play(h.tracker, load('events-mcp-external.jsonl'), SESSION);
    expect(h.overBudget).toEqual([0.0125]);
    expect(h.tracker.error).toContain('budget of $0.001 exceeded');
  });
});

describe('TurnTracker over a captured edit + bash run', () => {
  const SESSION = 'ses_f7ea79b3fffeMXSEXtJwG2E635';

  it('raises one ask per gated tool and never posts the echoed user prompt as bot text', async () => {
    const h = harness(SESSION, 'allow');
    const events = load('events-edit-bash.jsonl');
    await play(h.tracker, events, SESSION);
    // The capture was cut before the session went idle; feed the terminator the server sends.
    h.tracker.handle({ type: 'session.idle', properties: { sessionID: SESSION } });
    await h.tracker.finished;

    expect(h.asks.map((a) => a.name)).toEqual(['Write', 'Bash']);
    expect(h.asks[0].input.file_path).toContain('probe1.txt');
    expect(h.asks[1].input).toEqual({ command: 'echo hello' });
    expect(h.replies.map((r) => r.response)).toEqual(['once', 'once']);

    expect(h.rec.tools.map((t) => t.name)).toEqual(['Write', 'Bash']);
    expect(h.rec.results.map((r) => r.output.trim())).toEqual(['Wrote file successfully.', 'hello']);
    expect(h.rec.results.every((r) => !r.isError)).toBe(true);
    // The user's own prompt arrives as a text part on the user message; it must not be echoed back.
    expect(h.rec.texts).toEqual([]);
  });
});

describe('duplicate asks for one action', () => {
  it('shows a single card when OpenCode raises both `edit` and `external_directory` for one write', async () => {
    const h = harness('ses_z', 'allow');
    const base = {
      sessionID: 'ses_z',
      metadata: { filepath: 'C:\\Users\\alex\\Desktop\\pr-test.txt' },
      tool: { messageID: 'msg', callID: 'call-1' },
    };
    h.tracker.handle({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_z',
        part: { id: 'prt_1', type: 'tool', tool: 'write', callID: 'call-1', state: { status: 'pending', input: {} } },
      },
    });
    h.tracker.handle({ type: 'permission.asked', properties: { ...base, id: 'per_1', permission: 'external_directory' } });
    h.tracker.handle({ type: 'permission.asked', properties: { ...base, id: 'per_2', permission: 'edit' } });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.asks).toHaveLength(1);
    // Both permission requests still get answered, with the one decision the user gave.
    expect(h.replies).toEqual([
      { id: 'per_1', response: 'once' },
      { id: 'per_2', response: 'once' },
    ]);
  });
});

describe('TurnTracker terminators', () => {
  it('ends on session.error with the provider message', async () => {
    const h = harness('ses_x');
    h.tracker.handle({ type: 'session.status', properties: { sessionID: 'ses_x', status: { type: 'busy' } } });
    h.tracker.handle({
      type: 'session.error',
      properties: { sessionID: 'ses_x', error: { name: 'ProviderAuthError', data: { message: 'no credentials' } } },
    });
    await h.tracker.finished;
    expect(h.tracker.error).toBe('no credentials');
  });

  it('ignores a session.idle that arrives before the session went busy', async () => {
    const h = harness('ses_y');
    let done = false;
    void h.tracker.finished.then(() => (done = true));
    h.tracker.handle({ type: 'session.idle', properties: { sessionID: 'ses_y' } });
    await Promise.resolve();
    expect(done).toBe(false);
    h.tracker.finish();
    await h.tracker.finished;
    expect(done).toBe(true);
  });
});
