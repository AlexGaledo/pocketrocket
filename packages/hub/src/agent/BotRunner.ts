import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { Bot, BotState, Room, ToolPayload } from '@pocketrocket/shared';
import { CLAUDE_EXE, DESKTOP_AVAILABLE, MAX_TURNS_PER_QUERY, MAX_TURN_CONTINUATIONS, WORKSPACE_DIR, botHome } from '../config.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderInit, TurnContext, TurnOutcome, TurnSink } from '../providers/types.js';
import type { TurnRegistry } from '../mcp/httpServer.js';
import { addSecret, redact, removeSecret } from '../providers/redact.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import { createHubTools } from './botTools.js';

export interface TurnRequest {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  causeId: string;
  injected: string;
}
export interface TurnResult {
  ok: boolean;
  turnId: string;
  finalText: string;
  costUsd: number;
  error?: string;
}
export interface RunnerHooks {
  /** Route mentions produced mid-turn (send_message / handoff tools). Returns handles dispatched. */
  dispatchFromBot: (req: TurnRequest, targets: Bot[]) => string[];
  setState: (botId: string, roomId: string, state: BotState, note?: string) => void;
}

/**
 * Provider-agnostic turn driver: builds the TurnContext, hands it to the active provider, and turns the
 * provider's TurnSink callbacks into messages, tool chips, events and usage rows. Nothing here knows about
 * any particular agent SDK — that lives in providers/<id>.ts.
 */
export class BotRunner {
  private activeTurns = new Set<string>();
  private aborts = new Map<string, AbortController>();
  /** Last init info reported by the active provider (GET /api/health). */
  lastInit: ProviderInit = {};

  constructor(
    private repos: Repos,
    private memory: MemoryService,
    private skills: SkillService,
    private broker: PermissionBroker,
    private usage: UsageTracker,
    private hooks: RunnerHooks,
    private providers: ProviderRegistry,
    private turns: TurnRegistry,
  ) {}

  interrupt(turnId: string) {
    const ac = this.aborts.get(turnId);
    const stopped = this.providers.active().interrupt(turnId);
    if (ac) ac.abort();
    return stopped || !!ac;
  }
  isActive(turnId: string) {
    return this.activeTurns.has(turnId);
  }
  /** Interrupt every in-flight turn (graceful shutdown). */
  interruptAll() {
    for (const id of [...this.activeTurns]) this.interrupt(id);
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { bot, room } = req;
    const turnId = nanoid(10);
    const provider = this.providers.active();
    const session = this.repos.getSession(bot.id, room.id, provider.id);
    this.memory.ensureHome(bot.id);
    const memoryText = this.memory.read(bot.id);
    const identity = this.memory.readIdentity(bot.id) || bot.description;
    const pluginDir = this.skills.materialize(bot.id, bot.handle);
    const setState = (s: BotState, note?: string) => this.hooks.setState(bot.id, room.id, s, note);

    const desktopOn = bot.allowedTools.includes('Desktop') && DESKTOP_AVAILABLE;
    const browserOn = bot.allowedTools.includes('Browser');
    const bestEffort = provider.info.permissions === 'best-effort';
    const ac = new AbortController();
    const permCtx = { bot, room, turnId, hop: req.hop, causeId: req.causeId, setState: (s: 'blocked' | 'working') => setState(s) };

    const tools = createHubTools({
      bot, room, members: req.members, turnId, hop: req.hop, causeId: req.causeId,
      repos: this.repos, memory: this.memory, skills: this.skills,
      dispatchFromBot: (targets) => this.hooks.dispatchFromBot(req, targets),
      setState: (s) => setState(s),
      desktop: desktopOn,
      models: provider.modelsSync().map((m) => m.id),
      requestApproval: bestEffort ? (a) => this.broker.ask(permCtx, a, ac.signal) : undefined,
      // Every provider, not just the best-effort ones: CLI providers reach hub tools over MCP and never go
      // through the SDK's permission callback, so the gate has to live with the tool (audit 2026-09-09, B6).
      confirmFleetChange: (a) => this.broker.askFleetChange(permCtx, a.tool, a.input, a.reason, ac.signal),
    });

    const mcpToken = this.turns.registerTurn(tools);
    // The per-turn MCP bearer travels in provider config and can surface in a stderr tail; scrub it
    // everywhere until the turn ends (audit 2026-09-09, B22).
    addSecret(mcpToken);
    const ctx: TurnContext = {
      turnId, bot, room, members: req.members,
      systemPrompt: buildSystemPrompt({
        bot, room, members: req.members, hop: req.hop, memory: memoryText, identity,
        browser: browserOn, desktop: desktopOn,
        toolPrefix: provider.id === 'claude' ? 'mcp__pocketrocket__' : '',
        requestApproval: bestEffort,
      }),
      input: req.injected,
      resumeToken: session.sdkSessionId,
      workspaceDir: WORKSPACE_DIR,
      botHome: botHome(bot.id),
      tools,
      allowedBuiltins: bot.allowedTools,
      permission: async (name, input, extra) => {
        const r = await this.broker.decide(permCtx, name, input, { signal: ac.signal, blockedPath: extra?.blockedPath });
        return r.behavior === 'allow' ? 'allow' : 'deny';
      },
      permissionDetailed: (name, input, o) =>
        this.broker.decide(permCtx, name, input, {
          signal: (o.signal ?? ac.signal) as AbortSignal,
          suggestions: o.suggestions as never,
          blockedPath: o.blockedPath,
        }),
      pluginDir,
      model: bot.model,
      maxBudgetUsd: bot.maxBudgetUsd,
      maxTurns: MAX_TURNS_PER_QUERY,
      signal: ac.signal,
      mcp: { url: this.turns.url(), token: mcpToken },
    };

    events.emitEvent({ type: 'turn.start', turnId, botId: bot.id, roomId: room.id, causeId: req.causeId, hop: req.hop });
    setState('thinking');

    const texts: string[] = [];
    const toolMsgIds = new Map<string, string>();
    let lastMessageId: string | undefined;

    const sink: TurnSink = {
      onInit: (info) => { this.lastInit = info; },
      onSession: (token) => {
        if (token && token !== session.sdkSessionId) this.repos.saveSession(bot.id, room.id, { sdkSessionId: token, provider: provider.id });
      },
      onDelta: (text) => events.emitEvent({ type: 'turn.delta', turnId, roomId: room.id, botId: bot.id, text }),
      onText: (text) => {
        // NO_REPLY is the sentinel a bot uses to stay silent; swallow it instead of posting it.
        if (/^\W*NO_REPLY\W*$/.test(text.trim())) {
          events.emitEvent({ type: 'bot.state', botId: bot.id, state: 'done', roomId: room.id, note: 'no reply' });
          return;
        }
        texts.push(text);
        const msg = this.repos.insertMessage({
          roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text, payload: null,
          causeId: req.causeId, hop: req.hop, turnId,
        });
        lastMessageId = msg.id;
        events.emitEvent({ type: 'message.new', message: msg });
      },
      onToolUse: (id, name, input) => {
        const payload: ToolPayload = { toolUseId: id, name, input, done: false };
        const msg = this.repos.insertMessage({
          roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'tool', text: name, payload,
          causeId: req.causeId, hop: req.hop, turnId,
        });
        toolMsgIds.set(id, msg.id);
        events.emitEvent({ type: 'message.new', message: msg });
      },
      onToolResult: (id, output, isError) => {
        const msgId = toolMsgIds.get(id);
        if (!msgId) return;
        const cur = this.repos.getMessage(msgId);
        if (!cur || !cur.payload) return;
        const payload: ToolPayload = { ...(cur.payload as ToolPayload), output: redact(output.slice(0, 20000)), isError, done: true };
        this.repos.updateMessage(msgId, { payload });
        events.emitEvent({ type: 'message.update', id: msgId, roomId: room.id, patch: { payload } });
      },
      onState: (s) => setState(s),
    };

    this.activeTurns.add(turnId);
    this.aborts.set(turnId, ac);
    let ok = false;
    let error: string | undefined;
    let costUsd = 0;
    try {
      let outcome = await provider.runTurn(ctx, sink);
      const record = (o: TurnOutcome) => {
        costUsd += o.costUsd;
        // Only turns the provider actually accounted for become usage rows (matches the pre-provider
        // behaviour: a turn that died before any result reported nothing).
        const u = o.usage;
        if (u.costUsd || u.inputTokens || u.outputTokens) this.usage.record(bot.id, room.id, turnId, req.causeId, u);
      };
      record(outcome);

      // Running out of steps is not a failure, it is an unfinished job. Resume the same session and let it
      // keep going rather than handing the user a dead turn -- but bounded, budget-checked and visible, so
      // a bot stuck in a loop still stops instead of quietly costing three times as much.
      for (let attempt = 1; outcome.error === 'error_max_turns' && attempt <= MAX_TURN_CONTINUATIONS; attempt++) {
        if (ac.signal.aborted) break;
        if (costUsd >= bot.maxBudgetUsd) break;
        const note = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
          text: bot.name + ' hit the ' + MAX_TURNS_PER_QUERY + '-step limit; continuing (' + attempt + '/' + MAX_TURN_CONTINUATIONS + ').',
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: note });
        setState('working');
        outcome = await provider.runTurn(
          {
            ...ctx,
            // saveSession already stored whatever the last run reported, so this picks up its context.
            resumeToken: this.repos.getSession(bot.id, room.id, provider.id)?.sdkSessionId ?? ctx.resumeToken,
            input:
              'You stopped because you reached the step limit, not because the work was done. ' +
              'Continue from exactly where you left off and finish the task. Do not start over or re-explain.',
            maxBudgetUsd: bot.maxBudgetUsd - costUsd,
          },
          sink,
        );
        record(outcome);
      }

      ok = outcome.ok;
      error = outcome.error;
    } catch (e) {
      error = redact(String((e as Error).message ?? e));
    } finally {
      this.activeTurns.delete(turnId);
      this.aborts.delete(turnId);
      this.turns.unregister(mcpToken);
      removeSecret(mcpToken);
    }

    if (!ok && !error) error = 'Turn ended without a result';
    if (error) error = redact(error);
    if (error) {
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: bot.name + ' turn ended: ' + error, payload: null,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
    }
    events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, error });
    setState(error ? 'error' : 'done');
    return { ok, turnId, finalText: texts.join('\n\n'), costUsd, error };
  }

  static checkExe(): { ok: boolean; error?: string } {
    return fs.existsSync(CLAUDE_EXE) ? { ok: true } : { ok: false, error: 'claude executable not found at ' + CLAUDE_EXE };
  }
}
