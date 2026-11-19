import {
  PROTOCOL_VERSION,
  RequestError,
  methods,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionResponse,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
} from '@agentclientprotocol/sdk';
import type { ModelInfo, ProviderCheck, ProviderId, ProviderStaticInfo } from '@pocketrocket/shared';
import { VERSION } from '../../config.js';
import { childEnv, type ProviderKind } from '../env.js';
import { addSecret, redact } from '../redact.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnLimit, type TurnOutcome, type TurnSink } from '../types.js';
import type { TurnUsage } from '../../services/UsageTracker.js';
import { limitError } from '../claude.js';
import { hubMcpServer, startAcp, withTimeout, type AcpProcess } from './client.js';
import { AcpEventMapper } from './events.js';
import { decideAcpPermission, strictModeChange } from './permissions.js';

/** Cold start of a closed CLI (first run after boot, an antivirus scan): the same 12 s Claude gets. */
export const ACP_START_TIMEOUT_MS = 12_000;
/** Creating or resuming a session can sign in or load history first. */
const SESSION_TIMEOUT_MS = 60_000;
/** After `session/cancel`, how long the agent gets to answer the prompt with `cancelled` before it is killed. */
const CANCEL_GRACE_MS = 5_000;

/** Everything that makes one ACP agent different from another. `providers/gemini.ts` is the first. */
export interface AcpPreset {
  info: ProviderStaticInfo & { id: ProviderId };
  /** The env allowlist entry the child runs under (`providers/env.ts`). */
  envKind: ProviderKind;
  models: ModelInfo[];
  /** Install / sign-in hint, shown when the CLI is missing or signed out. */
  hint: string;
  /** What the CLI is called in error text ("agy"). */
  cliName: string;
  /** Absolute path to the CLI, or null when it is not installed. */
  findExe(): Promise<string | null>;
  /** Arguments that start the agent in ACP mode (`['acp']`). */
  args: string[];
  /** Extra child env: the API key, when one is set. Allowlisted again by `childEnv`. */
  env(): NodeJS.ProcessEnv;
  /** The provider's limit matcher over an error or notice text; null when it is not a limit. */
  limitOf(text: string): TurnLimit | null;
  check(probe: () => Promise<AcpProbe>): Promise<ProviderCheck>;
}

/** What `initialize` told us, for `check()`. */
export type AcpProbe = { ok: true; init: InitializeResponse; exe: string } | { ok: false; error: string; exe: string | null; timedOut?: boolean };

export interface AcpProviderOptions {
  /** Absolute path to the agent (or a `.mjs` script). Tests point it at the fake agent. */
  exe?: string;
  /** Extra child env (the fake agent's knobs); the allowlist drops anything not named here. */
  env?: NodeJS.ProcessEnv;
}

function messageOf(e: unknown): string {
  if (e instanceof RequestError) return e.message + (e.data !== undefined ? ' ' + JSON.stringify(e.data) : '');
  return String((e as Error)?.message ?? e);
}

/** ACP `auth_required` (-32000). */
function isAuthError(e: unknown): boolean {
  return e instanceof RequestError && e.code === -32000;
}

/** The first prompt of a fresh session carries the system prompt; a resumed one has it already. */
export function buildAcpPrompt(ctx: Pick<TurnContext, 'systemPrompt' | 'input' | 'bot'>, resumed: boolean): string {
  if (!resumed) return ctx.systemPrompt + '\n\n---\n\n' + ctx.input;
  return 'You are @' + ctx.bot.handle + '; room rules unchanged; reply NO_REPLY if nothing to add.\n\n' + ctx.input;
}

/**
 * Generic ACP provider (spec 01 §5 Option A, P2-1a). Spawns the agent once per turn, `initialize`s it, opens or
 * resumes a session with the hub's MCP tools, sends one prompt and streams `session/update` into the TurnSink.
 * `interrupt` sends `session/cancel` and kills the process if it does not stop. Nothing is downloaded or installed.
 */
export class AcpProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly info: ProviderStaticInfo;
  /** M8 (P4-1): `usage_update.used` becomes `contextTokens`, so a session rotates on size as on Claude (0 until the agent reports). */
  readonly reportsContextTokens = true;
  private active = new Map<string, { cancel: () => void }>();

  constructor(private preset: AcpPreset, private opts: AcpProviderOptions = {}) {
    this.id = preset.info.id;
    this.label = preset.info.label;
    this.info = preset.info;
  }

  async models(): Promise<ModelInfo[]> {
    return this.preset.models;
  }
  modelsSync(): ModelInfo[] {
    return this.preset.models;
  }

  private exe(): Promise<string | null> {
    return this.opts.exe ? Promise.resolve(this.opts.exe) : this.preset.findExe();
  }

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return childEnv(this.preset.envKind, { ...this.preset.env(), ...extra, ...this.opts.env });
  }

  private initialize(p: AcpProcess): Promise<InitializeResponse> {
    return withTimeout(
      p.conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // No fs/terminal: the agent keeps its own tools and asks through session/request_permission (P2-5 may change it).
        // `session.compaction` (M8, P4-1): an agent may only report a compaction to a client that asks for it; it becomes a quiet note.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
        clientInfo: { name: 'pocketrocket', version: VERSION },
      }),
      ACP_START_TIMEOUT_MS,
      this.preset.cliName,
    );
  }

  /** Starts the agent, sends `initialize`, stops it. Used by `check()`; never throws. */
  async probe(): Promise<AcpProbe> {
    const exe = await this.exe();
    if (!exe) return { ok: false, error: this.preset.cliName + ' was not found', exe: null };
    let p: AcpProcess;
    try {
      p = startAcp(exe, this.preset.args, { cwd: process.cwd(), env: this.env() }, {
        onUpdate: () => undefined,
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
    } catch (e) {
      return { ok: false, error: messageOf(e), exe };
    }
    try {
      const init = await Promise.race([
        this.initialize(p),
        p.exited.then((code) => {
          throw new Error(p.spawnError() ?? this.preset.cliName + ' exited with code ' + String(code) + tail(p.stderr()));
        }),
      ]);
      return { ok: true, init, exe };
    } catch (e) {
      const error = messageOf(e);
      return { ok: false, error, exe, timedOut: /did not answer within/.test(error) };
    } finally {
      p.stop();
      await Promise.race([p.exited, sleep(3000)]);
    }
  }

  check(): Promise<ProviderCheck> {
    return this.preset.check(() => this.probe());
  }

  interrupt(turnId: string): boolean {
    const a = this.active.get(turnId);
    if (!a) return false;
    a.cancel();
    return true;
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const started = Date.now();
    const cli = this.preset.cliName;
    const mapper = new AcpEventMapper(sink);
    const outcome = (error: string | undefined, extra: Partial<TurnOutcome> = {}): TurnOutcome => ({
      ok: !error,
      error,
      costUsd: 0,
      usage: { ...EMPTY_USAGE, durationMs: Date.now() - started },
      durationMs: Date.now() - started,
      ...(mapper.contextTokens !== undefined ? { contextTokens: mapper.contextTokens } : {}),
      ...(mapper.contextSize ? { contextWindow: mapper.contextSize } : {}),
      ...extra,
    });

    const exe = await this.exe();
    if (!exe) return outcome(cli + ' was not found. ' + this.preset.hint, { limit: { kind: 'down' } });

    addSecret(ctx.mcp.token);
    let sessionId: string | null = null;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let budgetHit = false;
    let p: AcpProcess;
    try {
      p = startAcp(exe, this.preset.args, { cwd: ctx.workspaceDir, env: this.env() }, {
        onUpdate: (n) => {
          if (sessionId && n.sessionId !== sessionId) return;
          mapper.push(n.update);
          // The agent's own dollar figure, when it gives one, is the only cost an ACP run reports.
          if (!budgetHit && ctx.maxBudgetUsd > 0 && ownCost() > ctx.maxBudgetUsd) {
            budgetHit = true;
            cancel();
          }
        },
        onPermission: (req, signal) => decideAcpPermission(req, ctx, AbortSignal.any([signal, ctx.signal])),
      });
    } catch (e) {
      return outcome('could not start ' + cli + ': ' + messageOf(e), { limit: { kind: 'down' } });
    }

    let resumed = false;
    const ownCost = () => {
      const total = mapper.sessionCostUsd ?? 0;
      return resumed ? Math.max(0, total - (ctx.sessionCostUsd ?? 0)) : total;
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (sessionId) void p.conn.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
      else p.stop();
      killTimer = setTimeout(() => p.stop(), CANCEL_GRACE_MS);
    };
    this.active.set(ctx.turnId, { cancel });
    ctx.signal.addEventListener('abort', cancel, { once: true });
    const died = p.exited.then((code) => {
      throw new Error(p.spawnError() ? cli + ' failed to start: ' + p.spawnError() : cli + ' exited with code ' + String(code) + tail(p.stderr()));
    });
    died.catch(() => undefined);

    try {
      sink.onState('thinking');
      const init = await Promise.race([this.initialize(p), died]);
      sink.onInit?.({ model: ctx.model, version: init.agentInfo?.version ?? undefined });
      const caps = init.agentCapabilities ?? {};
      const mcpServers = [hubMcpServer(init, ctx.mcp)];
      const extraDirs = [ctx.botHome, ...(ctx.projectDirs ?? [])];
      const dirs: { additionalDirectories?: string[] } = caps.sessionCapabilities?.additionalDirectories ? { additionalDirectories: extraDirs } : {};

      let modes: SessionModeState | null | undefined;
      let configOptions: SessionConfigOption[] | null | undefined;
      if (ctx.resumeToken && (caps.sessionCapabilities?.resume || caps.loadSession)) {
        const params: LoadSessionRequest = { sessionId: ctx.resumeToken, cwd: ctx.workspaceDir, mcpServers, ...dirs };
        try {
          if (caps.sessionCapabilities?.resume) {
            const r = await Promise.race([withTimeout(p.conn.agent.request(methods.agent.session.resume, params), SESSION_TIMEOUT_MS, cli), died]);
            modes = r.modes;
            configOptions = r.configOptions;
          } else {
            // session/load replays the old conversation as updates: keep it out of the room.
            mapper.muted = true;
            const r = await Promise.race([withTimeout(p.conn.agent.request(methods.agent.session.load, params), SESSION_TIMEOUT_MS, cli), died]);
            modes = r?.modes;
            configOptions = r?.configOptions;
          }
        } catch (e) {
          if (isAuthError(e)) throw e;
          // Worded for BotRunner's stale-session retry: it forgets the token and reruns the input, seeded, fresh.
          return outcome('No conversation found with session ID ' + ctx.resumeToken + ' (' + cli + ': ' + redact(messageOf(e)).slice(0, 200) + ')');
        } finally {
          mapper.muted = false;
        }
        sessionId = ctx.resumeToken;
        resumed = true;
      } else {
        const r: NewSessionResponse = await Promise.race([
          withTimeout(p.conn.agent.request(methods.agent.session.new, { cwd: ctx.workspaceDir, mcpServers, ...dirs }), SESSION_TIMEOUT_MS, cli),
          died,
        ]);
        sessionId = r.sessionId;
        modes = r.modes;
        configOptions = r.configOptions;
      }
      sink.onSession(sessionId);
      if (cancelled) {
        // Stopped while the session was opening: nothing was asked yet.
        return outcome('interrupted');
      }

      // A strict turn starts in the most restrictive mode that still asks (spec 01 §4.4, §4.7 item 7).
      if (ctx.strictApprovals) {
        const change = strictModeChange(modes, configOptions);
        if (change?.kind === 'mode') await p.conn.agent.request(methods.agent.session.setMode, { sessionId, modeId: change.modeId });
        else if (change?.kind === 'config') await p.conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: change.configId, value: change.value });
      }
      // The bot's model, when the agent offers it as a model option. Otherwise the agent keeps its own default.
      const modelOpt = (configOptions ?? []).find((o) => o.type === 'select' && o.category === 'model');
      // The model the agent runs on, for the usage row: the bot's when applied, else the agent's own current one.
      let answeredModel: string | undefined;
      if (modelOpt && modelOpt.type === 'select') {
        answeredModel = modelOpt.currentValue;
        if (modelOpt.currentValue !== ctx.model) {
          const values = modelOpt.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => o.value);
          if (values.includes(ctx.model)) {
            await p.conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: modelOpt.id, value: ctx.model });
            answeredModel = ctx.model;
          }
        }
      }

      const prompt: ContentBlock[] = [{ type: 'text', text: buildAcpPrompt(ctx, resumed) }];
      if (init.agentCapabilities?.promptCapabilities?.image) {
        for (const img of ctx.images ?? []) if (img.data) prompt.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mediaType });
      }
      const res: PromptResponse = await Promise.race([p.conn.agent.request(methods.agent.session.prompt, { sessionId, prompt }), died]);
      mapper.flush();

      const costUsd = ownCost();
      const extra: Partial<TurnOutcome> = {
        costUsd,
        usage: { ...EMPTY_USAGE, ...acpTokens(res), costUsd, durationMs: Date.now() - started },
        // A finished run is a usage row even when the agent reports no cost or tokens (agy on Gemini reports neither).
        accounted: true,
        ...(answeredModel && answeredModel !== ctx.model ? { model: answeredModel } : {}),
        ...(mapper.sessionCostUsd !== undefined ? { sessionCostUsd: mapper.sessionCostUsd } : {}),
      };
      if (budgetHit) return outcome('budget exceeded: $' + costUsd.toFixed(4) + ' over the $' + String(ctx.maxBudgetUsd) + ' cap', extra);
      if (res.stopReason === 'cancelled' || cancelled) return outcome('interrupted', extra);
      if (res.stopReason === 'end_turn') {
        // An agent that reports its quota as a notice and then ends the turn without a word is limited, not done.
        const limit = !mapper.answered ? this.limitFromNotices(mapper.notices) : null;
        return limit ? outcome(limitError(limit), { ...extra, limit }) : outcome(undefined, extra);
      }
      if (res.stopReason === 'max_tokens') return outcome(cli + ' stopped: it reached its output token limit', extra);
      if (res.stopReason === 'max_turn_requests') return outcome(cli + ' stopped: it reached its own step limit', extra);
      if (res.stopReason === 'refusal') return outcome(cli + ' refused to continue', extra);
      return outcome(cli + ' stopped: ' + String(res.stopReason), extra);
    } catch (e) {
      mapper.flush();
      if (cancelled) return outcome('interrupted');
      let msg = messageOf(e);
      // The agent died: its stdout closed first, so the pending request failed as "connection closed". Say how it died.
      if (/connection closed|process exited/i.test(msg)) {
        const code = await Promise.race([p.exited, sleep(1000).then(() => undefined)]);
        if (code !== undefined) msg = p.spawnError() ? cli + ' failed to start: ' + p.spawnError() : cli + ' exited with code ' + String(code) + tail(p.stderr());
      }
      const text = msg + (mapper.notices.length ? ' ' + mapper.notices.join(' ') : '');
      if (isAuthError(e)) {
        const limit: TurnLimit = { kind: 'auth' };
        return outcome(limitError(limit) + '. ' + this.preset.hint, { limit });
      }
      const limit = this.preset.limitOf(text);
      if (limit) return outcome(limitError(limit), { limit });
      return outcome((text.startsWith(cli + ' ') ? '' : cli + ': ') + redact(text).slice(0, 500));
    } finally {
      clearTimeout(killTimer);
      ctx.signal.removeEventListener('abort', cancel);
      this.active.delete(ctx.turnId);
      // One agent process per turn: it goes when the turn ends, and the turn waits (briefly) until it has.
      p.stop();
      await Promise.race([p.exited, sleep(3000)]);
    }
  }

  private limitFromNotices(notices: string[]): TurnLimit | null {
    for (const n of notices) {
      const l = this.preset.limitOf(n);
      if (l) return l;
    }
    return null;
  }
}

/**
 * Token counts from the prompt answer's `usage`, an ACP field still marked unstable (not in the stable
 * `PromptResponse` type), so it is read defensively. Absent or malformed: no counts.
 */
export function acpTokens(res: unknown): Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> | Record<string, never> {
  const u = (res as { usage?: unknown } | null)?.usage;
  if (!u || typeof u !== 'object') return {};
  const n = (k: string) => {
    const v = (u as Record<string, unknown>)[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };
  return { inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), cacheReadTokens: n('cachedReadTokens'), cacheWriteTokens: n('cachedWriteTokens') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

function tail(stderr: string): string {
  const t = stderr.trim();
  return t ? ': ' + redact(t.slice(-500)) : '';
}
