import { nanoid } from 'nanoid';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { APPROVAL_TIMEOUT_MS, WORKSPACE_DIR, botHome } from '../config.js';
import { events } from '../events.js';
import type { Repos } from '../db/repos.js';
import { isInside, pathsFromInput } from './pathRules.js';
import { classifyBash } from './bashRules.js';
import { DESKTOP_TOOL_NAMES } from '../agent/desktopTools.js';

export interface PermCtx {
  bot: Bot;
  room: Room;
  turnId: string;
  hop: number;
  causeId: string;
  setState: (s: 'blocked' | 'working') => void;
}

type Decision = ApprovalPayload['status'];
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

const HUB_PREFIX = 'mcp__pocketrocket__';
/** Hub tools that never need a card: read-only, or already visible to the user as a room message. */
const SILENT_HUB_TOOLS = new Set([
  'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
  'request_approval', ...DESKTOP_TOOL_NAMES,
]);
/**
 * Fleet-changing hub tools. They are allowed through *this* gate because the tool handler itself raises the
 * approval card (see `agent/botTools.ts`) — that way CLI providers, which reach hub tools over MCP and never
 * touch `decide()`, are gated identically. Before the audit every `mcp__pocketrocket__*` call was allowed
 * unconditionally and a Read-only bot could grant itself Bash (audit 2026-09-09, B6).
 */
const GATED_HUB_TOOLS = new Set(['create_bot', 'update_bot', 'delete_bot', 'add_to_room', 'remove_from_room']);

/** How long a `request_approval` grant stays valid. */
export const GRANT_TTL_MS = 10 * 60 * 1000;

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** approvalId -> what the user actually approved. */
  private grants = new Map<string, ApprovalGrant>();
  /** `<botId>:<toolName>` the user chose "always" for, for the life of this hub process. */
  private alwaysAllowed = new Set<string>();
  constructor(private repos: Repos) {}

  async decide(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string },
  ): Promise<PermissionResult> {
    const roots = [WORKSPACE_DIR, botHome(ctx.bot.id)];
    let reason = '';
    let danger = false;

    if (toolName.startsWith(HUB_PREFIX)) {
      const bare = toolName.slice(HUB_PREFIX.length);
      if (SILENT_HUB_TOOLS.has(bare) || GATED_HUB_TOOLS.has(bare)) return { behavior: 'allow' };
      reason = 'Unknown hub tool: ' + bare;
    } else if (PATH_TOOLS.has(toolName)) {
      const paths = opts.blockedPath ? [opts.blockedPath] : pathsFromInput(toolName, input);
      const outside = paths.filter((p) => !isInside(p, roots, WORKSPACE_DIR));
      if (!outside.length) return { behavior: 'allow' };
      reason = toolName + ' outside workspace: ' + outside.join(', ');
    } else if (toolName === 'Bash') {
      const cmd = String(input.command ?? '');
      const v = classifyBash(cmd, roots);
      if (v.verdict === 'allow' && !opts.blockedPath) return { behavior: 'allow' };
      reason = opts.blockedPath ? 'Bash touches ' + opts.blockedPath : v.reason;
      danger = v.danger;
    } else if (toolName === 'WebSearch' || toolName === 'WebFetch') {
      if (ctx.bot.allowedTools.includes(toolName)) return { behavior: 'allow' };
      reason = toolName + ' not in bot allowlist';
    } else {
      reason = toolName + ' requires approval';
    }
    return this.promptUser(ctx, toolName, input, reason, danger, opts);
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
    const danger = req.command ? classifyBash(req.command, [WORKSPACE_DIR, botHome(ctx.bot.id)]).danger : false;
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
      message: decision === 'timeout'
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
    const key = ctx.bot.id + ':' + toolName;
    if (this.alwaysAllowed.has(key)) return { allowed: true, message: 'Previously approved for this session.' };
    const { decision } = await this.prompt(ctx, toolName, input, reason, false, { signal });
    if (decision === 'always') this.alwaysAllowed.add(key);
    if (decision === 'allow' || decision === 'always') return { allowed: true, message: 'Approved by the user.' };
    return {
      allowed: false,
      message: decision === 'timeout'
        ? 'No response from the user within 10 minutes; the change was not made.'
        : 'The user declined this change. Do not retry it; say so in the room.',
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
      const timer = setTimeout(() => finish('timeout'), APPROVAL_TIMEOUT_MS);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(approvalId, { resolve: finish });
    });

    this.repos.decideApproval(approvalId, decision);
    const updated = this.repos.updateMessage(msg.id, { payload: { ...payload, status: decision } });
    if (updated) events.emitEvent({ type: 'message.update', id: msg.id, roomId: ctx.room.id, patch: { payload: updated.payload } });
    events.emitEvent({ type: 'approval.resolved', approvalId, decision });
    ctx.setState('working');
    return { decision, approvalId };
  }

  resolve(approvalId: string, decision: 'allow' | 'always' | 'deny'): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }
}
