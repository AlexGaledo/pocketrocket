import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASK_EVERY_TIME_TOOLS, DESKTOP_TOOL_NAMES, GATED_TOOLS, HUB_TOOLS, INTEGRATION_READ_TOOLS, INTEGRATION_TOOLS,
  INTEGRATION_WRITE_TOOLS, SIGN_IN_TOOLS, SILENT_TOOLS, type ApprovalPayload,
} from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { PermissionBroker, SIGN_IN_TOOLS as BROKER_SIGN_IN } from './PermissionBroker.js';
import { events } from '../events.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Tool names the hub registers with a string literal: `hubTool('name', ...)`. Integration tools pass a variable. */
function registeredInSource(): Set<string> {
  const found = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bhubTool\(\s*'([a-z][a-z0-9_]*)'/g)) found.add(m[1]);
  }
  return found;
}

/** The public Claude-project connector is its own MCP server with its own token; it is not a `pocketrocket` tool. */
const NOT_ON_THE_POCKETROCKET_SERVER = new Set(['save_project_context']);

describe('hub tool registry (B3)', () => {
  it('lists every tool the hub registers: a new hubTool() must be added to packages/shared/src/tools.ts', () => {
    const missing = [...registeredInSource()].filter((n) => !NOT_ON_THE_POCKETROCKET_SERVER.has(n) && !(n in HUB_TOOLS));
    expect(missing, 'registered in the hub but not in HUB_TOOLS: ' + missing.join(', ')).toEqual([]);
  });

  it('every integration tool is registered, reads silent and writes gated', () => {
    for (const t of Object.values(INTEGRATION_TOOLS)) {
      for (const n of t.read) expect(HUB_TOOLS[n], n).toBe('silent');
      for (const n of t.write) expect(HUB_TOOLS[n], n).toBe('gated');
    }
  });

  it('has no stale entries: each non-integration name is still registered in the hub', () => {
    const inSource = registeredInSource();
    const integration = new Set([...INTEGRATION_READ_TOOLS, ...INTEGRATION_WRITE_TOOLS]);
    const stale = Object.keys(HUB_TOOLS).filter((n) => !integration.has(n) && !inSource.has(n));
    expect(stale, 'in HUB_TOOLS but no hubTool() registers them: ' + stale.join(', ')).toEqual([]);
  });

  it('derives sets identical to the lists the broker used before the registry', () => {
    const silent = [
      'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
      'list_rooms', 'request_approval', 'use_stronger_model', 'desktop_screenshot', 'desktop_click', 'desktop_type',
      'desktop_key', 'desktop_scroll', 'desktop_launch', 'list_routines', 'where_to_run', 'list_machines', 'search_notes', 'write_note',
      'create_task', 'update_task', 'list_tasks', 'search_history', 'recall_memory', 'report_blocked', 'send_feedback', 'request_form',
      'log_decision', 'file_history', 'list_repos',
      ...INTEGRATION_READ_TOOLS,
    ];
    const gated = [
      'create_bot', 'update_bot', 'delete_bot', 'create_room', 'delete_room', 'add_to_room', 'remove_from_room',
      'create_routine', 'update_routine', 'delete_routine', 'dispatch', 'propose_routing_change', ...INTEGRATION_WRITE_TOOLS, 'run_on_pc', 'fill_credential',
    ];
    expect([...SILENT_TOOLS].sort()).toEqual([...silent].sort());
    expect([...GATED_TOOLS].sort()).toEqual([...gated].sort());
    expect([...ASK_EVERY_TIME_TOOLS].sort()).toEqual(['fill_credential', 'propose_routing_change', 'run_on_pc']);
    expect([...SIGN_IN_TOOLS].sort()).toEqual(['fill_credential', 'run_on_pc']);
    expect(BROKER_SIGN_IN).toBe(SIGN_IN_TOOLS);
    expect(DESKTOP_TOOL_NAMES).toHaveLength(6);
  });

  it('no tool is both silent and gated', () => {
    for (const n of SILENT_TOOLS) expect(GATED_TOOLS.has(n), n).toBe(false);
  });
});

describe('fails closed on a tool the registry does not know', () => {
  const signal = new AbortController().signal;
  function setup() {
    const db = new Db(':memory:');
    const repos = new Repos(db);
    const broker = new PermissionBroker(repos, { store: new ApprovalStore(db), bypass: () => false });
    const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: [], maxBudgetUsd: 2 });
    const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
    return { broker, ctx: { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined } };
  }
  async function callAnswering(tool: string, decision: 'allow' | 'deny') {
    const s = setup();
    const cards: ApprovalPayload[] = [];
    const off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') { cards.push(ev.approval); setTimeout(() => s.broker.resolve(ev.approval.approvalId, decision), 0); }
    });
    const result = await s.broker.decide(s.ctx, 'mcp__pocketrocket__' + tool, {}, { signal });
    off();
    return { result, cards };
  }

  it('an unregistered name raises an "Unknown hub tool" card, and a denial refuses it', async () => {
    expect('brand_new_tool' in HUB_TOOLS).toBe(false);
    const denied = await callAnswering('brand_new_tool', 'deny');
    expect(denied.cards).toHaveLength(1);
    expect(denied.cards[0].reason).toBe('Unknown hub tool: brand_new_tool');
    expect(denied.result.behavior).toBe('deny');
  });

  it('inherited object keys are not registered tools', async () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(SILENT_TOOLS.has(n) || GATED_TOOLS.has(n)).toBe(false);
      const r = await callAnswering(n, 'deny');
      expect(r.cards, n).toHaveLength(1);
      expect(r.result.behavior).toBe('deny');
    }
  });

  it('registered silent and gated tools pass without a card; an unlisted one still cards', async () => {
    const silent = await callAnswering('list_bots', 'deny');
    expect(silent.result.behavior).toBe('allow');
    expect(silent.cards).toHaveLength(0);
    const gated = await callAnswering('create_bot', 'deny');
    expect(gated.result.behavior).toBe('allow');
    expect(gated.cards).toHaveLength(0);
    const unlisted = Object.keys(HUB_TOOLS).find((n) => HUB_TOOLS[n] === 'unlisted')!;
    const u = await callAnswering(unlisted, 'deny');
    expect(u.cards).toHaveLength(1);
    expect(u.result.behavior).toBe('deny');
  });
});
