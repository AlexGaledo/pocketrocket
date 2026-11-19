import path from 'node:path';
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type { TurnContext } from '../types.js';

/**
 * ACP `session/request_permission` → the PermissionBroker (spec 01 §4.4, §4.8, P2-1b).
 *
 * The broker classifies by Claude tool names, so each ACP request is translated first: `ToolKind` plus `locations`
 * become the path tools (Read/Grep/Edit/Write, one ask per location, so `pathRules.isInside` with its realpath check
 * decides each path), `execute` with a command becomes `Bash` (so `classifyBash` decides), `fetch` with a URL becomes
 * `WebFetch`. Anything the hub cannot read for certain (no locations, no command, an unknown kind) becomes a card.
 */

export type AcpPermCtx = Pick<
  TurnContext,
  'permission' | 'bypassPermissions' | 'strictApprovals' | 'workspaceDir' | 'projectGuard' | 'shipGuard' | 'fileGuard'
>;

/** One broker question an ACP request turns into. */
export interface BrokerAsk {
  tool: string;
  input: Record<string, unknown>;
}

const PATH_KIND_TOOL: Partial<Record<string, string>> = { read: 'Read', search: 'Grep', edit: 'Edit', delete: 'Write', move: 'Write' };
/** Kinds whose paths the broker should check as reads (a read-only root counts as inside). */
const READ_KINDS = new Set(['read', 'search']);
/** The hub's own MCP server as an agent may name its tools: `pocketrocket__send_message`, `mcp__pocketrocket__…`, `pocketrocket/…`. */
const HUB_TOOL = /^(?:mcp__)?pocketrocket(?:__|[./:])([a-z0-9_]+)$/i;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** The shell command a request carries: `rawInput.command` (string or argv array) or `rawInput.cmd`. */
export function commandOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const c = r.command ?? r.cmd;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string') && c.length) return c.join(' ');
  return str(c);
}

/** A tool name for a request the broker cannot classify, specific enough that "allow for this session" covers only it. */
function cardTool(tc: ToolCallUpdate): string {
  const what = (tc.name ?? tc.title ?? 'tool').replace(/\s+/g, ' ').trim().slice(0, 80);
  return 'acp:' + (tc.kind ?? 'other') + ':' + what;
}

function card(tc: ToolCallUpdate): BrokerAsk[] {
  return [{
    tool: cardTool(tc),
    input: {
      title: tc.title ?? tc.name ?? 'tool',
      ...(tc.kind ? { kind: tc.kind } : {}),
      ...(tc.locations?.length ? { paths: tc.locations.map((l) => l.path) } : {}),
      ...(tc.rawInput !== undefined && tc.rawInput !== null ? { rawInput: tc.rawInput } : {}),
    },
  }];
}

/** The broker questions for one ACP permission request. Never empty: what cannot be classified is one card. */
export function brokerAsks(tc: ToolCallUpdate, cwd: string): BrokerAsk[] {
  const kind = tc.kind ?? 'other';
  const pathTool = PATH_KIND_TOOL[kind];
  if (pathTool) {
    const paths = (tc.locations ?? []).map((l) => str(l.path)).filter((p): p is string => !!p);
    if (!paths.length) return card(tc);
    const key = pathTool === 'Grep' ? 'path' : 'file_path';
    return [...new Set(paths.map((p) => path.resolve(cwd, p)))].map((p) => ({ tool: pathTool, input: { [key]: p } }));
  }
  if (kind === 'execute') {
    const cmd = commandOf(tc.rawInput);
    if (!cmd) return card(tc);
    // A working folder of its own is part of what the command touches: classify it as `cd <dir> && <cmd>`.
    const dir = str((tc.rawInput as Record<string, unknown>).cwd);
    return [{ tool: 'Bash', input: { command: dir ? 'cd ' + JSON.stringify(dir) + ' && ' + cmd : cmd } }];
  }
  if (kind === 'fetch') {
    const url = tc.rawInput && typeof tc.rawInput === 'object' ? str((tc.rawInput as Record<string, unknown>).url) : null;
    return url ? [{ tool: 'WebFetch', input: { url } }] : card(tc);
  }
  if (kind === 'other') {
    // The hub's own tools are gated inside their handlers; the broker lets them through by their hub name.
    const hub = HUB_TOOL.exec(tc.name ?? '') ?? HUB_TOOL.exec(tc.title ?? '');
    if (hub) return [{ tool: 'mcp__pocketrocket__' + hub[1], input: (tc.rawInput as Record<string, unknown>) ?? {} }];
  }
  return card(tc);
}

/** Why a guard that holds even with approvals bypassed refuses this request, or null. */
function guardRefusal(asks: BrokerAsk[], ctx: AcpPermCtx): string | null {
  for (const a of asks) {
    if (a.tool === 'Bash') {
      const cmd = String(a.input.command);
      const why = ctx.shipGuard?.(cmd, ctx.workspaceDir) ?? ctx.projectGuard?.('Bash', a.input, ctx.workspaceDir);
      if (why) return why;
    } else if (a.tool === 'Edit' || a.tool === 'Write') {
      const why = ctx.projectGuard?.(a.tool, a.input, ctx.workspaceDir) ?? ctx.fileGuard?.(a.tool, a.input, ctx.workspaceDir);
      if (why) return why;
    }
  }
  return null;
}

function pick(options: PermissionOption[], kinds: PermissionOptionKind[]): RequestPermissionResponse {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Allow picks `allow_once`. `allow_always` only when the agent offers nothing else and the turn is not strict: an
 * "always" would stop the agent asking, and the broker keeps its own session rules anyway. Deny picks `reject_once`,
 * then `reject_always`. With no matching option the request is cancelled, which agents treat as a refusal.
 */
export function allowResponse(options: PermissionOption[], strict: boolean): RequestPermissionResponse {
  return pick(options, strict ? ['allow_once'] : ['allow_once', 'allow_always']);
}
export function denyResponse(options: PermissionOption[]): RequestPermissionResponse {
  return pick(options, ['reject_once', 'reject_always']);
}

/**
 * Answers one `session/request_permission`. Bypass answers `allow_once` without asking, except on strict turns
 * (BotRunner never sets `bypassPermissions` on those). The project, shipping and shared-file guards hold under bypass
 * too, as they do on Claude.
 */
export async function decideAcpPermission(req: RequestPermissionRequest, ctx: AcpPermCtx, signal: AbortSignal): Promise<RequestPermissionResponse> {
  const strict = !!ctx.strictApprovals;
  const asks = brokerAsks(req.toolCall, ctx.workspaceDir);
  if (guardRefusal(asks, ctx)) return denyResponse(req.options);
  if (ctx.bypassPermissions && !strict) return allowResponse(req.options, false);
  for (const a of asks) {
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const verdict = await ctx.permission(a.tool, a.input);
    if (verdict !== 'allow') return denyResponse(req.options);
  }
  if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
  return allowResponse(req.options, strict);
}

// ---------------------------------------------------------------- strict mode

/** Modes that skip asking. Never chosen on a strict turn. */
const PERMISSIVE = /bypass|yolo|danger|full.?access|accept.?edits|auto.?(?:approve|accept|edit)|allow.?all|(?<!un)trust(?:ed)?\b|skip/i;
/** Modes that ask before writes and shell. */
const ASKS = /\bask|always.?ask|manual|untrusted|on.?request|strict|confirm|default|normal|review/i;
/** Modes that cannot write at all: the fallback when nothing asks (spec 01 §4.7 item 7). */
const READ_ONLY = /read.?only|\bplan\b|view.?only/i;

interface ModeLike {
  id: string;
  name: string;
  description?: string | null;
}

function label(m: ModeLike): string {
  return m.id + ' ' + m.name + ' ' + (m.description ?? '');
}

/**
 * The most restrictive mode that still asks, from what the agent offers, or null to keep its current one. Prefers a
 * mode that asks before writes and shell; with none, a read-only one; with neither, nothing (the turn then relies on
 * the agent's permission requests, which is why Gemini stays `best-effort` until the live test shows it asks).
 */
export function strictModeId(modes: ModeLike[], currentId: string | null): string | null {
  const current = modes.find((m) => m.id === currentId);
  if (current && ASKS.test(label(current)) && !PERMISSIVE.test(label(current))) return null;
  const asks = modes.find((m) => ASKS.test(label(m)) && !PERMISSIVE.test(label(m)) && !READ_ONLY.test(label(m)));
  if (asks) return asks.id === currentId ? null : asks.id;
  const ro = modes.find((m) => READ_ONLY.test(label(m)) && !PERMISSIVE.test(label(m)));
  if (ro) return ro.id === currentId ? null : ro.id;
  return null;
}

/** What to switch to for a strict turn: a session mode, or a `mode` config option's value. Null = leave it. */
export function strictModeChange(
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[] | null | undefined,
): { kind: 'mode'; modeId: string } | { kind: 'config'; configId: string; value: string } | null {
  if (modes?.availableModes?.length) {
    const id = strictModeId(modes.availableModes, modes.currentModeId);
    return id ? { kind: 'mode', modeId: id } : null;
  }
  const opt = (configOptions ?? []).find((o) => o.type === 'select' && o.category === 'mode');
  if (opt && opt.type === 'select') {
    const flat = opt.options.flatMap((o) => ('group' in o ? o.options : [o]));
    const id = strictModeId(flat.map((o) => ({ id: o.value, name: o.name, description: o.description })), opt.currentValue);
    return id ? { kind: 'config', configId: opt.id, value: id } : null;
  }
  return null;
}
