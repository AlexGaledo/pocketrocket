import { nanoid } from 'nanoid';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalPayload, Bot, Room } from '@pocketrocket/shared';
import { APPROVAL_TIMEOUT_MS, WORKSPACE_DIR, botHome } from '../config.js';
import { events } from '../events.js';
import type { Repos } from '../db/repos.js';
import { isInside, pathsFromInput } from './pathRules.js';
import { classifyBash } from './bashRules.js';

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

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);

export class PermissionBroker {
  private pending = new Map<string, Pending>();
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

    if (toolName.startsWith('mcp__pocketrocket__')) return { behavior: 'allow' };

    if (PATH_TOOLS.has(toolName)) {
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
    return this.ask(ctx, toolName, input, reason, danger, opts);
  }

  private async ask(
    ctx: PermCtx,
    toolName: string,
    input: Record<string, unknown>,
    reason: string,
    danger: boolean,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
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

  resolve(approvalId: string, decision: 'allow' | 'always' | 'deny'): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }
}
