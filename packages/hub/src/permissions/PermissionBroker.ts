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
import { routingFileWrite } from './readOnlyRoots.js';
import { redact } from '../providers/redact.js';

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
  // A rule for an outside hand-off is per pair: this bot to that one.
  if (toolName === 'handoff') return s(input.to_bot) || '*';
  if (toolName === 'read_room' || toolName === 'send_message') return s(input.room) || '*';
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
  'list_rooms', 'request_approval', 'use_stronger_model', ...DESKTOP_TOOL_NAMES,
  // P3
  'list_routines',
  // Key routing: reads key-registry.json, names only.
  'where_to_run',
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
  // Its handler calls askRoutingChange.
  'propose_routing_change',
  // P4: integration writes; their handlers call askIntegrationWrite.
  ...INTEGRATION_WRITE_TOOLS,
  // A Claude Code job on the owner's PC; its handler calls askFleetChange with evenUnderBypass.
  'run_on_pc',
]);

/** Answered once per card: no "for this session", and no rule can pre-approve it. */
const ASK_EVERY_TIME = new Set(['propose_routing_change', 'run_on_pc']);

/**
 * Cards only a browser signed in with the owner's password may allow. The hub token is not enough: it sits in
 * DATA_DIR, where a bot under bypass can read it and answer its own card over the socket. Anyone may deny.
 * Keyed by tool name, so a parked card keeps the rule across a restart.
 */
export const SIGN_IN_TOOLS: ReadonlySet<string> = new Set(['run_on_pc']);
export const SIGN_IN_MESSAGE =
  'Only a browser signed in with your password can approve this. The server token is not enough. Sign in, then approve it.';

/** The largest outside MCP call input (as JSON) a card shows; anything bigger is refused, never truncated. */
const OUTSIDE_INPUT_CAP = 8000;

/** How long a `request_approval` grant stays valid. */
export const GRANT_TTL_MS = 10 * 60 * 1000;

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** Cards a paired device answered. It answers once; a standing grant is the desktop's call. */
  private answeredByDevice = new Set<string>();
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
      /** The approvals setting is 'read-only': refuse every write outright, no card, nothing to bypass into. */
      globalReadOnly?: () => boolean;
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
    // Before bypass and before any card: nothing can approve a bot writing the owner's routing rules.
    const refused = routingFileWrite(toolName, input, WORKSPACE_DIR);
    if (refused) return { behavior: 'deny', message: refused };
    // P2: the control interlock runs before bypass. It is a safety stop, not an approval.
    if (isComputerTool(toolName)) {
      const why = ctx.controlBlocked?.();
      if (why) return { behavior: 'deny', message: why };
    }
    // Read-only: ahead of bypass (the two settings are mutually exclusive anyway) and of every card, so a
    // write is refused outright rather than asked about.
    if (this.opts.globalReadOnly?.()) {
      const refusal = this.readOnlyRefusal(ctx, toolName, input);
      if (refusal) return { behavior: 'deny', message: refusal };
    }
    if (this.bypassedFor(ctx)) {
      // Hardening pass: a shell write into a read-only root is refused even in bypass (P7 read-only rule).
      const hit = toolName === 'Bash' ? this.readOnlyShellWrite(String(input.command ?? '')) : null;
      if (hit) return { behavior: 'deny', message: 'The knowledge repo is read-only; this shell command writes there: ' + hit };
      return { behavior: 'allow' };
    }
    const roots = botRoots(ctx.bot.id, ctx.room.id);
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

  /**
   * The global 'read-only' approvals setting: a plain-language refusal for a call that writes anything, or
   * null when the call only reads. `Bash` goes through the same allowlist 'ask' mode uses for "safe enough
   * not to ask" — here that list draws the read/write line instead, so `ls`/`cat`/`grep` pass and anything
   * not on it (including every command classifyBash cannot prove is safe) does not.
   */
  private readOnlyRefusal(ctx: PermCtx, toolName: string, input: Record<string, unknown>): string | null {
    const bare = toolName.startsWith(HUB_PREFIX) ? toolName.slice(HUB_PREFIX.length) : toolName;
    if (GATED_HUB_TOOLS.has(bare)) return 'Read-only mode: fleet, room and integration changes are turned off.';
    if (PATH_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) return 'Read-only mode: ' + toolName + ' cannot write files.';
    if (toolName === 'Bash') {
      const v = classifyBash(String(input.command ?? ''), botRoots(ctx.bot.id, ctx.room.id), { readOnlyRoots: this.opts.readOnlyRoots?.() ?? [] });
      if (v.verdict !== 'allow') return 'Read-only mode: not a known read-only command (' + v.reason + ').';
    }
    return null;
  }

  // ---------- P2: approval rules ----------
  /**
   * The user's rule for this call, if one matches: deny rules first, then allow rules. Allow rules never cover
   * a command the classifier calls dangerous, and nothing covers an integration write (P4: always asks).
   */
  matchPolicy(botId: string, tool: string, subject: string, danger = false): 'allow' | 'deny' | null {
    if (INTEGRATION_WRITES.has(tool)) return null;
    // Asked on every call: a deny rule still refuses, but no allow rule or "always" pre-approves it.
    if (ASK_EVERY_TIME.has(tool)) danger = true;
    const store = this.opts.store;
    if (!store) return !danger && this.alwaysAllowed.has(botId + ':' + tool) ? 'allow' : null;
    const rules = store.listPolicies(botId, 'all').filter((p) => p.tool === tool && patternMatches(p.pattern, subject));
    if (rules.some((p) => p.decision === 'deny')) return 'deny';
    if (!danger && rules.some((p) => p.decision === 'allow')) return 'allow';
    return null;
  }

  /** "Allow for this session": a session rule (cleared at the next hub start). Never for a write to a third party. */
  private rememberSession(botId: string, tool: string, input: Record<string, unknown>, danger: boolean) {
    if (INTEGRATION_WRITES.has(tool) || ASK_EVERY_TIME.has(tool) || danger) return;
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
    this.repos.decideApproval(approvalId, decision, decision === 'timeout' ? null : 'owner');
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
    const refused = req.command ? routingFileWrite('Bash', { command: req.command }, WORKSPACE_DIR) : null;
    if (refused) return { allowed: false, message: refused };
    if (this.opts.globalReadOnly?.()) {
      const v = req.command ? classifyBash(req.command, botRoots(ctx.bot.id, ctx.room.id), { readOnlyRoots: this.opts.readOnlyRoots?.() ?? [] }) : null;
      if (!v || v.verdict !== 'allow') return { allowed: false, message: 'Read-only mode: this hub refuses writes outright. Choose another approach or ask in chat.' };
    }
    if (this.bypassedFor(ctx)) {
      const hit = req.command ? this.readOnlyShellWrite(req.command) : null;
      if (hit) return { allowed: false, message: 'The knowledge repo is read-only; this command writes there: ' + hit };
      return { allowed: true, message: 'Allowed: this hub runs without approval cards.' };
    }
    const danger = req.command ? classifyBash(req.command, botRoots(ctx.bot.id, ctx.room.id)).danger : false;
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
    /** A hand-off that adds a bot to this chat: the owner's call on any hub, because that bot has other logins. */
    opts: { evenUnderBypass?: boolean } = {},
  ): Promise<{ allowed: boolean; message: string }> {
    if (this.opts.globalReadOnly?.()) return { allowed: false, message: 'Read-only mode: fleet and room changes are turned off.' };
    if (this.bypassedFor(ctx) && !opts.evenUnderBypass) return { allowed: true, message: 'Allowed: this hub runs without approval cards.' };
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
   * The first hand-off from this bot to one outside the chat. That bot has different logins and tools, so the card
   * shows under bypass too. Saying yes records an approval rule for the pair, listed and revocable in Settings, so
   * later hand-offs go straight through. A strict (routine, trigger) turn may be acting on forwarded text, so it
   * neither uses nor records the rule; nor does a paired device record one.
   */
  async askOutsideHandoff(
    ctx: PermCtx,
    input: { to_bot: string; task: string; context?: string },
    reason: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message: string }> {
    const strict = !!ctx.strictApprovals;
    const rule = this.matchPolicy(ctx.bot.id, 'handoff', input.to_bot);
    if (rule === 'deny') return { allowed: false, message: 'An approval rule the user set denies this hand-off. Keep the work here.' };
    if (rule === 'allow' && !strict) return { allowed: true, message: 'Already approved for this pair of bots.' };
    const { decision, approvalId } = await this.prompt(ctx, 'handoff', input, reason, false, { signal });
    const byDevice = this.answeredByDevice.delete(approvalId);
    if (decision === 'allow' || decision === 'always') {
      if (!strict && !byDevice && this.opts.store) {
        this.opts.store.addPolicy({ botId: ctx.bot.id, tool: 'handoff', pattern: input.to_bot, decision: 'allow', scope: 'always' });
        events.emitEvent({ type: 'policies.changed', policies: this.opts.store.listPolicies().map(({ scope: _scope, ...p }) => p) });
      }
      return { allowed: true, message: 'Approved by the user.' };
    }
    return {
      allowed: false,
      message: decision === 'parked' ? PARKED_MESSAGE : decision === 'timeout'
        ? 'No response from the user within 10 minutes. Keep the work here.'
        : 'The user wants this kept here. Do the work yourself, and do not retry the hand-off.',
    };
  }

  /**
   * A line a bot proposes for the owner's routing rules. Asks on every call, under bypass too, and no rule can
   * pre-approve it: redirected work runs under another bot's logins, so injected text must not get in unseen.
   */
  async askRoutingChange(ctx: PermCtx, input: { line: string; reason: string }, signal: AbortSignal): Promise<{ allowed: boolean; message: string }> {
    const { decision } = await this.prompt(ctx, 'propose_routing_change', input, 'Add this line to your routing rules', false, { signal });
    if (decision === 'allow' || decision === 'always') return { allowed: true, message: 'Approved by the user.' };
    return { allowed: false, message: 'The user did not add it. Do not propose it again.' };
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
    if (this.opts.globalReadOnly?.()) return { allowed: false, message: 'Read-only mode: nothing is sent to a third party. Do not retry it; say so in the room.' };
    const { decision } = await this.prompt(ctx, toolName, input, reason, false, { signal });
    if (decision === 'allow' || decision === 'always') return { allowed: true, message: 'Approved by the user.' };
    return {
      allowed: false,
      message: decision === 'parked' ? PARKED_MESSAGE : decision === 'timeout'
        ? 'No response from the user within 10 minutes; nothing was sent.'
        : 'The user declined this. Nothing was sent; do not retry it, say so in the room.',
    };
  }

  /**
   * A call to an owner-configured outside MCP server whose `approve` setting asks for a card
   * (services/outsideMcp.ts). Those servers carry the owner's own API keys, so this asks on every call: under
   * bypass too, for a strict turn too, and no approval rule or "always" answer covers it ("always" counts as a
   * single allow and is not remembered). The card shows the server, the tool and the whole input, redacted; an
   * input too long to show in full is refused without a card.
   */
  async askOutsideMcp(
    ctx: PermCtx,
    server: string,
    tool: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message: string }> {
    if (this.opts.globalReadOnly?.()) {
      return { allowed: false, message: 'Read-only mode: outside tools are turned off. Do not retry it; say so in the room.' };
    }
    // Never ask about input the owner cannot see in full: a hidden tail could carry the real payload.
    const shown = redact(JSON.stringify(input ?? {}) ?? '{}');
    if (shown.length > OUTSIDE_INPUT_CAP) {
      return { allowed: false, message: 'Input too large to show for approval (' + shown.length + ' chars); split the call.' };
    }
    const { decision } = await this.prompt(
      ctx, 'mcp__' + server + '__' + tool, { server, tool, input: shown },
      'Outside server "' + server + '" tool "' + tool + '"', false, { signal, once: true },
    );
    if (decision === 'allow' || decision === 'always') return { allowed: true, message: 'Approved by the user.' };
    return {
      allowed: false,
      message: decision === 'parked' ? PARKED_MESSAGE : decision === 'timeout'
        ? 'No response from the user within 10 minutes; the outside tool was not called. Do not retry it; say so in the room.'
        : 'The user declined this outside tool call. Do not retry it; say so in the room.',
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
    /** `once`: an "always" answer allows this call only and is never remembered. */
    opts: { signal: AbortSignal; once?: boolean },
  ): Promise<{ decision: Decision; approvalId: string }> {
    // P2: the retry of a call the user allowed on a parked card goes through once, without a second card.
    const gk = this.grantKey(ctx.bot.id, toolName, input);
    const grant = this.parkedGrants.get(gk);
    if (grant !== undefined) {
      this.parkedGrants.delete(gk);
      if (grant > this.now()) return { decision: 'allow', approvalId: 'parked-' + nanoid(8) };
    }
    const approvalId = nanoid(10);
    const payload: ApprovalPayload = {
      approvalId, toolName, toolInput: input, reason, danger, status: 'pending',
      ...(SIGN_IN_TOOLS.has(toolName) ? { signInRequired: true } : {}),
    };
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

    let aborted = false;
    const decision = await new Promise<Decision>((resolve) => {
      const finish = (d: Decision) => {
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        this.pending.delete(approvalId);
        resolve(d);
      };
      const onAbort = () => { aborted = true; finish('deny'); };
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
    this.repos.decideApproval(approvalId, decision, aborted || decision === 'timeout' ? null : 'owner');
    if (decision === 'always' && !opts.once) this.rememberSession(ctx.bot.id, toolName, input, danger);
    const updated = this.repos.updateMessage(msg.id, { payload: { ...payload, status: decision } });
    if (updated) events.emitEvent({ type: 'message.update', id: msg.id, roomId: ctx.room.id, patch: { payload: updated.payload } });
    events.emitEvent({ type: 'approval.resolved', approvalId, decision });
    ctx.setState('working');
    return { decision, approvalId };
  }

  /** Whether allowing this card needs a signed-in browser (SIGN_IN_TOOLS). Reads the card's row, so parked cards count. */
  needsSignIn(approvalId: string): boolean {
    const row = this.repos.db.get('SELECT tool_name FROM approvals WHERE id=?', approvalId);
    return !!row && SIGN_IN_TOOLS.has(String(row.tool_name));
  }

  /**
   * An answer to a card. `signedIn`: the answer came from a browser signed in with the owner's password, not
   * only the hub token. Without it an allow on a SIGN_IN_TOOLS card is refused (false) and the card stays open.
   */
  resolve(approvalId: string, decision: 'allow' | 'always' | 'deny', opts: { device?: boolean; signedIn?: boolean } = {}): boolean {
    if (decision !== 'deny' && !opts.signedIn && this.needsSignIn(approvalId)) return false;
    const p = this.pending.get(approvalId);
    // P2: no turn is waiting in memory, but a parked one may be.
    if (!p) return this.resolveParked(approvalId, decision);
    if (opts.device) this.answeredByDevice.add(approvalId);
    p.resolve(decision);
    return true;
  }
}
