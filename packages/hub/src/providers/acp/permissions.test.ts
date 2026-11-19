import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionOption, RequestPermissionRequest, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { WORKSPACE_DIR } from '../../config.js';
import { Db } from '../../db/db.js';
import { Repos } from '../../db/repos.js';
import { events } from '../../events.js';
import { PermissionBroker } from '../../permissions/PermissionBroker.js';
import { brokerAsks, commandOf, decideAcpPermission, readOnlyModeChange, readOnlyViolation, strictModeChange, strictModeId, type AcpPermCtx } from './permissions.js';

/**
 * P2-1b: an ACP `session/request_permission` goes through the real PermissionBroker after it is mapped onto the
 * broker's tool names: path kinds through `pathRules.isInside`, `execute` through `classifyBash`, the rest a card.
 */

const OPTIONS: PermissionOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
];
const OUTSIDE = path.join(os.tmpdir(), 'pr-acp-outside', 'secret.txt');
const INSIDE = path.join(WORKSPACE_DIR, 'notes', 'a.md');

const req = (toolCall: Partial<ToolCallUpdate>, options = OPTIONS): RequestPermissionRequest => ({
  sessionId: 's',
  toolCall: { toolCallId: 'tc', ...toolCall },
  options,
});

function setup(o: { bypass?: boolean; strict?: boolean; answer?: 'allow' | 'deny' } = {}) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Gem', handle: 'gem', title: '', description: 'x', avatar: '🤖', model: 'm', allowedTools: ['Bash', 'WebFetch'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const broker = new PermissionBroker(repos, { bypass: () => !!o.bypass });
  const permCtx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined, strictApprovals: !!o.strict };
  const cards: string[] = [];
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') {
      cards.push(ev.approval.toolName);
      setTimeout(() => broker.resolve(ev.approval.approvalId, o.answer ?? 'deny'), 0);
    }
  });
  const signal = new AbortController().signal;
  // What BotRunner hands an adapter: bypass is off on a strict turn, whatever the setting.
  const ctx: AcpPermCtx = {
    workspaceDir: WORKSPACE_DIR,
    bypassPermissions: !!o.bypass && !o.strict,
    strictApprovals: !!o.strict,
    permission: async (name, input, extra) => {
      const r = await broker.decide(permCtx, name, input, { signal, blockedPath: extra?.blockedPath });
      return r.behavior === 'allow' ? 'allow' : 'deny';
    },
  };
  return { ctx, cards, off, decide: (r: RequestPermissionRequest) => decideAcpPermission(r, ctx, signal) };
}

const selected = (id: string) => ({ outcome: { outcome: 'selected', optionId: id } });

describe('ACP permission mapping', () => {
  it('maps kinds and locations onto the broker tool names', () => {
    expect(brokerAsks({ toolCallId: 'x', kind: 'read', locations: [{ path: INSIDE }] }, WORKSPACE_DIR)).toEqual([{ tool: 'Read', input: { file_path: INSIDE } }]);
    expect(brokerAsks({ toolCallId: 'x', kind: 'search', locations: [{ path: 'src' }] }, WORKSPACE_DIR)).toEqual([{ tool: 'Grep', input: { path: path.join(WORKSPACE_DIR, 'src') } }]);
    expect(brokerAsks({ toolCallId: 'x', kind: 'move', locations: [{ path: INSIDE }, { path: OUTSIDE }] }, WORKSPACE_DIR)).toEqual([
      { tool: 'Write', input: { file_path: INSIDE } },
      { tool: 'Write', input: { file_path: OUTSIDE } },
    ]);
    expect(brokerAsks({ toolCallId: 'x', kind: 'execute', rawInput: { command: ['git', 'status'] } }, WORKSPACE_DIR)).toEqual([{ tool: 'Bash', input: { command: 'git status' } }]);
    expect(brokerAsks({ toolCallId: 'x', kind: 'execute', rawInput: { command: 'ls', cwd: '/etc' } }, WORKSPACE_DIR)).toEqual([{ tool: 'Bash', input: { command: 'cd "/etc" && ls' } }]);
    expect(brokerAsks({ toolCallId: 'x', kind: 'fetch', rawInput: { url: 'https://example.com' } }, WORKSPACE_DIR)).toEqual([{ tool: 'WebFetch', input: { url: 'https://example.com' } }]);
    expect(brokerAsks({ toolCallId: 'x', kind: 'other', name: 'pocketrocket__send_message', rawInput: { text: 'hi' } }, WORKSPACE_DIR)).toEqual([
      { tool: 'mcp__pocketrocket__send_message', input: { text: 'hi' } },
    ]);
    expect(commandOf({ cmd: 'pwd' })).toBe('pwd');
    expect(commandOf({})).toBeNull();
  });

  it('what the hub cannot read for certain becomes a card, never a path tool with no path', () => {
    for (const tc of [
      { toolCallId: 'x', kind: 'edit' as const, title: 'Edit something' },
      { toolCallId: 'x', kind: 'execute' as const, title: 'Run' },
      { toolCallId: 'x', kind: 'fetch' as const, title: 'Fetch' },
      { toolCallId: 'x', kind: 'switch_mode' as const, title: 'Switch to yolo' },
      { toolCallId: 'x', title: 'Mystery' },
    ]) {
      const asks = brokerAsks(tc, WORKSPACE_DIR);
      expect(asks).toHaveLength(1);
      expect(asks[0].tool.startsWith('acp:')).toBe(true);
    }
  });

  it('an edit inside the workspace is allowed without a card', async () => {
    const s = setup();
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: INSIDE }] }))).toEqual(selected('once'));
    s.off();
    expect(s.cards).toEqual([]);
  });

  it('an edit outside the workspace raises a card, and a refused card answers reject_once', async () => {
    const s = setup({ answer: 'deny' });
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: OUTSIDE }] }))).toEqual(selected('no'));
    s.off();
    expect(s.cards).toEqual(['Edit']);
  });

  it('an approved card answers allow_once, never allow_always', async () => {
    const s = setup({ answer: 'allow' });
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: OUTSIDE }] }))).toEqual(selected('once'));
    s.off();
  });

  it('a path that escapes the workspace with .. is still outside', async () => {
    const s = setup();
    const sneaky = path.join(WORKSPACE_DIR, '..', '..', 'escape.txt');
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: sneaky }] }))).toEqual(selected('no'));
    s.off();
    expect(s.cards).toHaveLength(1);
  });

  it('execute goes through classifyBash: a read-only command passes, a destructive one cards', async () => {
    const s = setup();
    expect(await s.decide(req({ kind: 'execute', rawInput: { command: 'ls' } }))).toEqual(selected('once'));
    expect(await s.decide(req({ kind: 'execute', rawInput: { command: 'rm -rf /' } }))).toEqual(selected('no'));
    s.off();
    expect(s.cards).toEqual(['Bash']);
  });

  it('unknown kinds card', async () => {
    const s = setup();
    expect(await s.decide(req({ kind: 'other', title: 'Do a thing' }))).toEqual(selected('no'));
    expect(await s.decide(req({ title: 'No kind at all' }))).toEqual(selected('no'));
    s.off();
    expect(s.cards).toEqual(['acp:other:Do a thing', 'acp:other:No kind at all']);
  });

  it('bypass answers allow_once without a card', async () => {
    const s = setup({ bypass: true });
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: OUTSIDE }] }))).toEqual(selected('once'));
    expect(await s.decide(req({ kind: 'other', title: 'Anything' }))).toEqual(selected('once'));
    s.off();
    expect(s.cards).toEqual([]);
  });

  it('a strict turn under bypass still cards (negative: bypass must not leak into strict turns)', async () => {
    const s = setup({ bypass: true, strict: true });
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: OUTSIDE }] }))).toEqual(selected('no'));
    expect(await s.decide(req({ kind: 'other', title: 'Anything' }))).toEqual(selected('no'));
    s.off();
    expect(s.cards).toHaveLength(2);
  });

  it('a strict turn never picks allow_always, even when the agent offers nothing else', async () => {
    const s = setup({ strict: true });
    const onlyAlways: PermissionOption[] = [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'No', kind: 'reject_once' }];
    expect(await s.decide(req({ kind: 'edit', locations: [{ path: INSIDE }] }, onlyAlways))).toEqual({ outcome: { outcome: 'cancelled' } });
    s.off();
  });

  it('the shipping guard refuses under bypass too', async () => {
    const s = setup({ bypass: true });
    s.ctx.shipGuard = (cmd) => (/git push/.test(cmd) ? 'not on the default branch' : null);
    expect(await s.decide(req({ kind: 'execute', rawInput: { command: 'git push origin main' } }))).toEqual(selected('no'));
    s.off();
  });
});

describe('strict mode choice', () => {
  const m = (id: string, name = id, description?: string) => ({ id, name, description });
  it('prefers a mode that asks, over read-only, and never a permissive one', () => {
    expect(strictModeId([m('yolo', 'YOLO'), m('default', 'Default'), m('plan', 'Plan')], 'yolo')).toBe('default');
    expect(strictModeId([m('yolo'), m('plan', 'Plan', 'read only')], 'yolo')).toBe('plan');
    expect(strictModeId([m('bypassPermissions'), m('acceptEdits')], 'acceptEdits')).toBeNull();
    expect(strictModeId([m('untrusted', 'Untrusted'), m('full', 'Full access')], 'full')).toBe('untrusted');
  });
  it('keeps a current mode that already asks', () => {
    expect(strictModeId([m('default'), m('yolo')], 'default')).toBeNull();
  });
  it('works on a mode config option as well as on session modes', () => {
    expect(
      strictModeChange(null, [
        { type: 'select', id: 'approval', name: 'Approval', category: 'mode', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto-approve' }, { value: 'ask', name: 'Ask' }] },
      ]),
    ).toEqual({ kind: 'config', configId: 'approval', value: 'ask' });
    expect(strictModeChange({ currentModeId: 'yolo', availableModes: [m('yolo'), m('default')] }, null)).toEqual({ kind: 'mode', modeId: 'default' });
    expect(strictModeChange(null, null)).toBeNull();
  });
});

describe('read-only mode for strict turns on an agent that writes without asking', () => {
  const m = (id: string, name = id, description?: string) => ({ id, name, description });
  // agy 1.5.12's modes, live (G7).
  const AGY = [m('default', 'Default', 'Ask before edits and commands, per your permission settings'), m('accept-edits', 'Accept edits'), m('plan', 'Plan')];
  it("picks agy's plan mode, never default or accept-edits", () => {
    expect(readOnlyModeChange({ currentModeId: 'default', availableModes: AGY }, null)).toEqual({ kind: 'mode', modeId: 'plan', current: false });
    expect(readOnlyModeChange({ currentModeId: 'plan', availableModes: AGY }, null)).toEqual({ kind: 'mode', modeId: 'plan', current: true });
  });
  it('NEGATIVE: no read-only mode means none, not the asking one', () => {
    expect(readOnlyModeChange({ currentModeId: 'default', availableModes: AGY.slice(0, 2) }, null)).toBeNull();
    expect(readOnlyModeChange(null, null)).toBeNull();
  });
  it('works on a mode config option', () => {
    expect(
      readOnlyModeChange(null, [
        { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
      ]),
    ).toEqual({ kind: 'config', configId: 'mode', value: 'plan', current: false });
  });
  it('an announced write, a switch_mode call or a mode change is a violation; reads and shell are not', () => {
    expect(readOnlyViolation({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'write_file', kind: 'edit' }, 'plan')).toMatch(/change files \(write_file\)/);
    expect(readOnlyViolation({ sessionUpdate: 'tool_call_update', toolCallId: 'a', kind: 'delete' }, 'plan')).toMatch(/change files/);
    expect(readOnlyViolation({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'exit plan', kind: 'switch_mode' }, 'plan')).toMatch(/leave read-only/);
    expect(readOnlyViolation({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }, 'plan')).toMatch(/left read-only mode \(default\)/);
    expect(readOnlyViolation({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, 'plan')).toBeNull();
    expect(readOnlyViolation({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'view_file', kind: 'read' }, 'plan')).toBeNull();
    expect(readOnlyViolation({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'run_command', kind: 'execute' }, 'plan')).toBeNull();
  });
});
