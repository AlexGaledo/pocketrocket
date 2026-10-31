import { nanoid } from 'nanoid';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { APPROVAL_TIMEOUT_MS, WORKSPACE_DIR, botRoots } from '../config.js';
import { events } from '../events.js';
import type { Repos } from '../db/repos.js';
import { isInside, pathsFromInput } from './pathRules.js';
import { bashWritesReadOnly, classifyBash } from './bashRules.js';
import { DESKTOP_TOOL_NAMES } from '../agent/desktopTools.js';
import { INTEGRATION_READ_TOOLS, INTEGRATION_WRITE_TOOLS } from '../integrations/toolNames.js';
import { patternMatches, type ApprovalStore, type ParkedApproval } from '../db/approvalStore.js';
import { isComputerTool } from './controlInterlock.js';

export interface PermCtx {
  bot: Bot;
  room: Room;
  turnId: string;
  hop: number;
  causeId: string;
  setState: (s: 'blocked' | 'working') => void;
  /** P3, decision Q6: a routine/trigger turn. Bypass does not apply to it; every gate still asks. */
  strictApprovals?: boolean;
  // ---- P2 ----
  /** Routine run the turn belongs to, kept on a parked card so the resumed turn can close it. */
  runId?: string;
  /**
   * Ends the turn because a card parked (a strict turn waited `parkAfterMs` with no answer). BotRunner wires
   * it; without it a strict card times out and denies as before.
   */
  park?: (why: string) => void;
  /** Control interlock: why this bot's computer tools must not act now, or null. Checked before bypass. */
  controlBlocked?: () => string | null;
}

type Decision = ApprovalPayload['status'] | 'parked';

/** What a tool call's card is about, matched against an approval rule's pattern (P2). */
export function approvalSubject(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (toolName === 'Bash') return s(input.command) || '*';
  if (PATH_TOOLS.has(toolName)) return pathsFromInput(toolName, input).join(' ') || '*';
  if (toolName === 'WebFetch') return s(input.url) || '*';
  if (toolName === 'WebSearch') return s(input.query) || '*';
  if (toolName === 'request_approval') return s(input.command) || s(input.action) || '*';
  return '*';
}

/** Stable JSON (sorted keys), so the same call retried after a park matches its grant. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stableJson((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

export const PARKED_MESSAGE =
  'Nobody has answered this approval card yet. Your turn ends now: do not retry it or work around it, and say ' +
  'nothing more. When the user answers you get a new turn telling you the answer.';
const INTEGRATION_WRITES = new Set<string>(INTEGRATION_WRITE_TOOLS);
/** A parked card's "allow" is good for one retry of the same call within this window. */
const PARKED_GRANT_TTL_MS = 60 * 60 * 1000;
/** A parked card nobody answers is denied after this long (POCKETROCKET_MAX_PARK_HOURS, default 24). */
export const MAX_PARK_MS = (Number(process.env.POCKETROCKET_MAX_PARK_HOURS) || 24) * 60 * 60 * 1000;
interface Pending {
  resolve: (d: Decision) => void;
}

/** A `request_approval` the user said yes to, with the scope they saw on the card (audit 2026-09-09, B10). */
export interface ApprovalGrant {
  approvalId: string;
  botId: string;
  turnId: string;
  action: string;
  command?: string;
  paths?: string[];
  expiresAt: number;
}

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);
/** P7: the PATH_TOOLS that only read; they alone may reach a read-only root without a card. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

const HUB_PREFIX = 'mcp__pocketrocket__';
/** Hub tools that never need a card: read-only, or already visible to the user as a room message. */
const SILENT_HUB_TOOLS = new Set([
  'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
  'list_rooms', 'request_approval', ...DESKTOP_TOOL_NAMES,
  // P3
  'list_routines',
  // P7: notes live in the bot's own home.
  'search_notes', 'write_note',
  // P4: integration reads (granted per bot; untrusted output is labelled as such).
  ...INTEGRATION_READ_TOOLS,
]);
/**
 * Fleet-changing hub tools. They are allowed through *this* gate because the tool handler itself raises the
 * approval card (see `agent/botTools.ts`) — that way CLI providers, which reach hub tools over MCP and never
 * touch `decide()`, are gated identically. Before the audit every `mcp__pocketrocket__*` call was allowed
 * unconditionally and a Read-only bot could grant itself Bash (audit 2026-09-09, B6).
 */
const GATED_HUB_TOOLS = new Set([
  'create_bot', 'update_bot', 'delete_bot', 'create_room', 'delete_room', 'add_to_room', 'remove_from_room',
  // P3: a routine a bot schedules is autonomous future spend (grok-bot-parity §4).
  'create_routine', 'update_routine', 'delete_routine',
  // P4: integration writes; their handlers call askIntegrationWrite.
  ...INTEGRATION_WRITE_TOOLS,
]);

/** How long a `request_approval` grant stays valid. */
export const GRANT_TTL_MS = 10 * 60 * 1000;

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** approvalId -> what the user actually approved. */
  private grants = new Map<string, ApprovalGrant>();
  /**
   * `<botId>:<toolName>` the user chose "always" for, for the life of this hub process. Only used when no
   * ApprovalStore is wired (unit tests); with one, "always" is a session row in `approval_policies` (P2).
   */
  private alwaysAllowed = new Set<string>();
  /** P2: one-shot grants from a parked card the user allowed: key -> expiry. */
  private parkedGrants = new Map<string, number>();
  /** P2: an answer to a parked card (or its expiry). RoomRouter queues the resumed turn. Set by createHub. */
  onParkedDecision?: (p: ParkedApproval, decision: 'allow' | 'always' | 'deny' | 'timeout') => void;
  /**
   * `bypass`: when it returns true, allow every tool call, every `request_approval` and every fleet change
   * without a card. Nothing raises an approval card at all. A function, not a flag, so it follows the
   * approvals setting live (the hub passes `settings.approvals() === 'bypass'`).
   */
  constructor(
    private repos: Repos,
    private opts: {
      bypass?: () => boolean;
      /** P7: folders bots may read but never write (the knowledge repo). Read live, per decision. */
      readOnlyRoots?: () => string[];
      // ---- P2 ----
      /** Parked approvals and approval rules. Left out (tests), "always" stays in memory and nothing parks. */
      store?: ApprovalStore;
      now?: () => number;
      /** How long a strict (routine/trigger) card waits before its turn parks. Default APPROVAL_TIMEOUT_MS. */
      parkAfterMs?: number;
      /** A parked card unanswered this long is denied. Default MAX_PARK_MS (24 h). */
      maxParkMs?: number;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Whether approvals are bypassed right now. BotRunner reads it once per turn to set up the provider. */
  get bypassed(): boolean {
    return !!this.opts.bypass?.();
  }
  /** Bypass for one turn: never for a strict (routine/trigger) turn, whatever the setting says. */
  bypassedFor(ctx: Pick<PermCtx, 'strictApprovals'>): boolean {
    return this.bypassed && !ctx.strictApprovals;
  }

  async decide(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string },
  ): Promise<PermissionResult> {
    // P2: the control interlock runs before bypass. It is a safety stop, not an approval.
    if (isComputerTool(toolName)) {
      const why = ctx.controlBlocked?.();
      if (why) return { behavior: 'deny', message: why };
    }
    if (this.bypassedFor(ctx)) {
      // Hardening pass: a shell write into a read-only root is refused even in bypass (P7 read-only rule).
      const hit = toolName === 'Bash' ? this.readOnlyShellWrite(String(input.command ?? '')) : null;
      if (hit) return { behavior: 'deny', message: 'The knowledge repo is read-only; this shell command writes there: ' + hit };
      return { behavior: 'allow' };
    }
    const roots = botRoots(ctx.bot.id);
    let reason = '';
    let danger = false;

    if (toolName.startsWith(HUB_PREFIX)) {
      const bare = toolName.slice(HUB_PREFIX.length);
      if (SILENT_HUB_TOOLS.has(bare) || GATED_HUB_TOOLS.has(bare)) return { behavior: 'allow' };
      reason = 'Unknown hub tool: ' + bare;
    } else if (PATH_TOOLS.has(toolName)) {
      const paths = opts.blockedPath ? [opts.blockedPath] : pathsFromInput(toolName, input);
      // P7: a read-only root (the knowledge repo) counts as inside for the read tools only.
      const readOnly = this.opts.readOnlyRoots?.() ?? [];
      const readRoots = READ_TOOLS.has(toolName) ? [...roots, ...readOnly] : roots;
      const outside = paths.filter((p) => !isInside(p, readRoots, WORKSPACE_DIR));
      if (!outside.length) return { behavior: 'allow' };
      const intoReadOnly = readOnly.length > 0 && outside.some((p) => isInside(p, readOnly, WORKSPACE_DIR));
      reason = intoReadOnly
        ? toolName + ' into the read-only knowledge repo: ' + outside.join(', ')
        : toolName + ' outside workspace: ' + outside.join(', ');
    } else if (toolName === 'Bash') {
      const cmd = String(input.command ?? '');
      const v = classifyBash(cmd, roots, { readOnlyRoots: this.opts.readOnlyRoots?.() ?? [] });
      if (v.verdict === 'allow' && !opts.blockedPath) return { behavior: 'allow' };
      reason = opts.blockedPath ? 'Bash touches ' + opts.blockedPath : v.reason;
      danger = v.danger;
    } else if (toolName === 'WebSearch' || toolName === 'WebFetch') {
      if (ctx.bot.allowedTools.includes(toolName)) return { behavior: 'allow' };
      reason = toolName + ' not in bot allowlist';
    } else {
      reason = toolName + ' requires approval';
    }
    const rule = this.matchPolicy(ctx.bot.id, toolName, approvalSubject(toolName, input), danger);
    if (rule === 'allow') return { behavior: 'allow' };
    if (rule === 'deny') return { behavior: 'deny', message: 'An approval rule the user set denies this. Choose another approach or ask in chat.' };
    return this.promptUser(ctx, toolName, input, reason, danger, opts);
  }

  /** A shell command's write into a read-only root (the knowledge repo), if the command line shows one. */
  private readOnlyShellWrite(cmd: string): string | null {
    return bashWritesReadOnly(cmd, WORKSPACE_DIR, this.opts.readOnlyRoots?.() ?? []);
  }

  // ---------- P2: approval rules ----------
  /**
   * The user's rule for this call, if one matches: deny rules first, then allow rules. Allow rules never cover
   * a command the classifier calls dangerous, and nothing covers an integration write (P4: always asks).
   */
  matchPolicy(botId: string, tool: string, subject: string, danger = false): 'allow' | 'deny' | null {
    if (INTEGRATION_WRITES.has(tool)) return null;
    const store = this.opts.store;
    if (!store) return !danger && this.alwaysAllowed.has(botId + ':' + tool) ? 'allow' : null;
    const rules = store.listPolicies(botId, 'all').filter((p) => p.tool === tool && patternMatches(p.pattern, subject));
    if (rules.some((p) => p.decision === 'deny')) return 'deny';
    if (!danger && rules.some((p) => p.decision === 'allow')) return 'allow';
    return null;
  }

  /** "Allow for this session": a session rule (cleared at the next hub start). Never for a write to a third party. */
  private rememberSession(botId: string, tool: string, input: Record<string, unknown>, danger: boolean) {
    if (INTEGRATION_WRITES.has(tool) || danger) return;
    if (!this.opts.store) {
      this.alwaysAllowed.add(botId + ':' + tool);
      return;
    }
    this.opts.store.addPolicy({ botId, tool, pattern: approvalSubject(tool, input), decision: 'allow', scope: 'session' });
  }

  // ---------- P2: parked approvals ----------
  private grantKey(botId: string, tool: string, input: Record<string, unknown>): string {
    const subject = approvalSubject(tool, input);
    return botId + '\u0000' + tool + '\u0000' + (subject !== '*' ? subject : stableJson(input));
  }

  /**
   * The user answered a card whose turn had parked. Records the answer, and an "allow" as a one-shot grant for
   * the same call when the resumed turn retries it. Returns false when no such parked card exists.
   */
  resolveParked(approvalId: string, decision: 'allow' | 'always' | 'deny' | 'timeout'): boolean {
    const store = this.opts.store;
    const p = store?.getParked(approvalId);
    if (!store || !p) return false;
    this.repos.decideApproval(approvalId, decision);
    const input = (p.toolInput ?? {}) as Record<string, unknown>;
    if (decision === 'allow' || decision === 'always') {
      this.parkedGrants.set(this.grantKey(p.botId, p.toolName, input), this.now() + PARKED_GRANT_TTL_MS);
      if (decision === 'always') this.rememberSession(p.botId, p.toolName, input, false);
    }
    if (p.messageId) {
      const cur = this.repos.getMessage(p.messageId);
      if (cur?.payload) {
        const payload = { ...(cur.payload as ApprovalPayload), status: decision, parked: false };
        const updated = this.repos.updateMessage(p.messageId, { payload });
        if (updated) events.emitEvent({ type: 'message.update', id: p.messageId, roomId: p.roomId, patch: { payload: updated.payload } });
      }
    }
    events.emitEvent({ type: 'approval.resolved', approvalId, decision });
    this.onParkedDecision?.(p, decision);
    return true;
  }

  /** Denies parked cards older than `maxParkMs` (run every minute by the hub). Returns their ids. */
  sweepParked(): string[] {
    const store = this.opts.store;
    if (!store) return [];
    const maxAge = this.opts.maxParkMs ?? MAX_PARK_MS;
    const t = this.now();
    const out: string[] = [];
    for (const p of store.listParked()) {
      if (t - p.parkedAt < maxAge) continue;
      if (this.resolveParked(p.id, 'timeout')) out.push(p.id);
    }
    return out;
  }

  /** Parked cards still waiting (REST, tests). */
  parked(): ParkedApproval[] {
    return this.opts.store?.listParked() ?? [];
  }

  /**
   * Public entry for the `request_approval` hub tool: providers without full permission interception ask
   * the user through the same approval cards. `danger` comes from the bash classifier when a command is given.
   *
   * The returned `approvalId` names a recorded grant (`getGrant`) holding exactly the command and paths the
   * card showed, valid for ten minutes. That binding is **advisory**: Codex and Grok run their own tool loop
   * inside their own sandbox, so the hub cannot force the child to run only what was approved. The sandbox
   * (`--sandbox workspace`, Codex's `workspace-write`) is the real control; the grant is the audit record.
   */
  async ask(
    ctx: PermCtx,
    req: { action: string; command?: string; paths?: string[]; reason?: string },
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message: string; approvalId?: string }> {
    if (this.bypassedFor(ctx)) {
      const hit = req.command ? this.readOnlyShellWrite(req.command) : null;
      if (hit) return { allowed: false, message: 'The knowledge repo is read-only; this command writes there: ' + hit };
      return { allowed: true, message: 'Allowed: this hub runs without approval cards.' };
    }
    const danger = req.command ? classifyBash(req.command, botRoots(ctx.bot.id)).danger : false;
    const askInput = { action: req.action, command: req.command, paths: req.paths, reason: req.reason };
    const rule = this.matchPolicy(ctx.bot.id, 'request_approval', approvalSubject('request_approval', askInput), danger);
    if (rule === 'deny') return { allowed: false, message: 'An approval rule the user set denies this. Choose another approach or ask in chat.' };
    if (rule === 'allow') {
      const approvalId = 'rule-' + nanoid(8);
      this.grants.set(approvalId, {
        approvalId, botId: ctx.bot.id, turnId: ctx.turnId, action: req.action, command: req.command, paths: req.paths,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
      return { allowed: true, message: 'Allowed by an approval rule the user set.', approvalId };
    }
    const { decision, approvalId } = await this.prompt(
      ctx, 'request_approval',
      { action: req.action, command: req.command, paths: req.paths, reason: req.reason },
      req.action, danger, { signal },
    );
    if (decision === 'allow' || decision === 'always') {
      this.grants.set(approvalId, {
        approvalId, botId: ctx.bot.id, turnId: ctx.turnId,
        action: req.action, command: req.command, paths: req.paths,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
      return { allowed: true, message: 'Approved by the user.', approvalId };
    }
    return {
      allowed: false,
      message: decision === 'parked' ? PARKED_MESSAGE : decision === 'timeout'
        ? 'No response from the user within 10 minutes. Choose another approach or ask in chat.'
        : 'The user declined this action. Choose another approach or ask in chat.',
      approvalId,
    };
  }

  /** The recorded grant for an approvalId, or null when it is unknown or expired. */
  getGrant(approvalId: string): ApprovalGrant | null {
    const g = this.grants.get(approvalId);
    if (!g) return null;
    if (g.expiresAt <= Date.now()) {
      this.grants.delete(approvalId);
      return null;
    }
    return g;
  }

  /**
   * Approval card for a hub tool that changes the fleet (audit 2026-09-09, B6/B14): create/update/delete a
   * bot, add/remove one from a room. The human confirms, not the bot — a bot-supplied `confirm: true` is not
   * consent, and a bot rewriting another bot's `description` is persistent cross-bot prompt injection.
   * "Always" is remembered per bot + tool for the life of this hub process.
   */
  async askFleetChange(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message: string }> {
    if (this.bypassedFor(ctx)) return { allowed: true, message: 'Allowed: this hub runs without approval cards.' };
    const rule = this.matchPolicy(ctx.bot.id, toolName, approvalSubject(toolName, input));
    if (rule === 'allow') return { allowed: true, message: 'Allowed by an approval rule the user set.' };
    if (rule === 'deny') return { allowed: false, message: 'An approval rule the user set denies this change. Do not retry it; say so in the room.' };
    const { decision } = await this.prompt(ctx, toolName, input, reason, false, { signal });
    if (decision === 'allow' || decision === 'always') return { allowed: true, message: 'Approved by the user.' };
    return {
      allowed: false,
      message: decision === 'parked' ? PARKED_MESSAGE : decision === 'timeout'
        ? 'No response from the user within 10 minutes; the change was not made.'
        : 'The user declined this change. Do not retry it; say so in the room.',
    };
  }

  /**
   * P4: approval card for an integration write (send mail, post to Slack, comment on GitHub, ...). Unlike the
   * other gates this one asks on EVERY call: approvals bypass does not skip it, and "Always" counts as a
   * single allow and is not remembered. Acting as the user towards third parties is never pre-approved
   * (spec §2.5); persisted policies that could relax it belong to P2.
   */
  async askIntegrationWrite(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message: string }> {
    const { decision } = await this.prompt(ctx, toolName, input, reason, false, { signal });
    if (decision === 'allow' || decision === 'always') return { allowed: true, message: 'Approved by the user.' };
    return {
      allowed: false,
      message: decision === 'parked' ? PARKED_MESSAGE : decision === 'timeout'
        ? 'No response from the user within 10 minutes; nothing was sent.'
        : 'The user declined this. Nothing was sent; do not retry it, say so in the room.',
    };
  }

  private async promptUser(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
    danger: boolean,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    const { decision } = await this.prompt(ctx, toolName, input, reason, danger, opts);
    if (decision === 'allow') return { behavior: 'allow' };
    if (decision === 'always') return { behavior: 'allow', updatedPermissions: opts.suggestions };
    // `interrupt` stops the SDK turn right here; BotRunner's park() ends it for every other provider.
    if (decision === 'parked') return { behavior: 'deny', message: PARKED_MESSAGE, interrupt: true };
    return {
      behavior: 'deny',
      message:
        decision === 'timeout'
          ? 'No response from the user within 10 minutes. Choose another approach or ask in chat.'
          : 'The user declined this action. Choose another approach or ask in chat.',
    };
  }

  /** Post the card, block until the user (or the timeout, or an abort) answers, and report the raw decision. */
  private async prompt(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
    danger: boolean,
    opts: { signal: AbortSignal },
  ): Promise<{ decision: Decision; approvalId: string }> {
    // P2: the retry of a call the user allowed on a parked card goes through once, without a second card.
    const gk = this.grantKey(ctx.bot.id, toolName, input);
    const grant = this.parkedGrants.get(gk);
    if (grant !== undefined) {
      this.parkedGrants.delete(gk);
      if (grant > this.now()) return { decision: 'allow', approvalId: 'parked-' + nanoid(8) };
    }
    const approvalId = nanoid(10);
    const payload: ApprovalPayload = { approvalId, toolName, toolInput: input, reason, danger, status: 'pending' };
    const msg = this.repos.insertMessage({
      roomId: ctx.room.id,
      authorType: 'system',
      authorId: ctx.bot.id,
      kind: 'approval',
      text: ctx.bot.name + ' wants to run ' + toolName,
      payload,
      causeId: ctx.causeId,
      hop: ctx.hop,
      turnId: ctx.turnId,
    });
    this.repos.createApproval({ id: approvalId, botId: ctx.bot.id, roomId: ctx.room.id, turnId: ctx.turnId, toolName, toolInput: input, reason });
    events.emitEvent({ type: 'message.new', message: msg });
    events.emitEvent({ type: 'approval.request', roomId: ctx.room.id, botId: ctx.bot.id, messageId: msg.id, approval: payload });
    ctx.setState('blocked');

    const decision = await new Promise<Decision>((resolve) => {
      const finish = (d: Decision) => {
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        this.pending.delete(approvalId);
        resolve(d);
      };
      const onAbort = () => finish('deny');
      // P2: a strict (routine/trigger) turn nobody is watching parks instead of timing out: the card stays
      // pending, the turn ends and frees its slot, and the answer resumes the bot later (resolveParked).
      const canPark = !!(ctx.strictApprovals && ctx.park && this.opts.store);
      const timer = canPark
        ? setTimeout(() => {
            this.opts.store!.park(approvalId, { causeId: ctx.causeId, hop: ctx.hop, runId: ctx.runId ?? null, messageId: msg.id });
            finish('parked');
          }, this.opts.parkAfterMs ?? APPROVAL_TIMEOUT_MS)
        : setTimeout(() => finish('timeout'), APPROVAL_TIMEOUT_MS);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(approvalId, { resolve: finish });
    });

    if (decision === 'parked') {
      const updated = this.repos.updateMessage(msg.id, { payload: { ...payload, parked: true } });
      if (updated) events.emitEvent({ type: 'message.update', id: msg.id, roomId: ctx.room.id, patch: { payload: updated.payload } });
      ctx.park?.('waiting for an answer to "' + toolName + '"');
      return { decision, approvalId };
    }
    this.repos.decideApproval(approvalId, decision);
    if (decision === 'always') this.rememberSession(ctx.bot.id, toolName, input, danger);
    const updated = this.repos.updateMessage(msg.id, { payload: { ...payload, status: decision } });
    if (updated) events.emitEvent({ type: 'message.update', id: msg.id, roomId: ctx.room.id, patch: { payload: updated.payload } });
    events.emitEvent({ type: 'approval.resolved', approvalId, decision });
    ctx.setState('working');
    return { decision, approvalId };
  }

  resolve(approvalId: string, decision: 'allow' | 'always' | 'deny'): boolean {
    const p = this.pending.get(approvalId);
    // P2: no turn is waiting in memory, but a parked one may be.
    if (!p) return this.resolveParked(approvalId, decision);
    p.resolve(decision);
    return true;
  }
}
