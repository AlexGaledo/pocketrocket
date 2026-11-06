import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { AUTO_MODEL, type Bot, type BotState, type CauseKind, type Room, type ToolPayload } from '@pocketrocket/shared';
import { CLAUDE_EXE, DESKTOP_AVAILABLE, MAX_TURNS_PER_QUERY, MAX_TURN_CONTINUATIONS, WORKSPACE_DIR, botHome, spendCapsOff } from '../config.js';
import { SUPPORT_HANDLE, supportSourceDirs } from '../services/SeedBots.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { EMPTY_USAGE, type ProviderInit, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { TurnRegistry } from '../mcp/httpServer.js';
import { addSecret, redact, removeSecret } from '../providers/redact.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import type { PcRunner } from '../services/PcRunner.js';
import { createHubTools } from './botTools.js';
import { settings } from '../services/SettingsStore.js';
import { ModelRouter, canUpgrade, type RouteChoice, type RouteRequest } from './ModelRouter.js';
import type { RoutingRules } from '../services/RoutingRules.js';
import { desktopTools, SHARED_BROWSER_NOTE, SHARED_TAB_NOTE, viewScreenTool } from './desktopTools.js';
import type { ComputerEndpoint, ComputerManager } from '../services/ComputerManager.js';
import type { IntegrationService } from '../services/IntegrationService.js';
import { createIntegrationTools } from '../integrations/tools.js';
import type { ProjectService } from '../services/ProjectService.js';
import { folderAccessDenied } from '../permissions/projectGuard.js';
import type { RoomFiles } from '../rooms/roomFiles.js';
import { SHIP_GUARD_SKILL, defaultBranchPushDenied } from '../permissions/shipGuard.js';
import type { ComputerControlService } from '../services/ComputerControl.js';
import { takeoverTool } from './takeoverTool.js';
import { turnFailureNote } from './turnFailure.js';
import { outsideMcpFor } from '../services/outsideMcp.js';
import { computerToolGuard } from '../permissions/controlInterlock.js';
import type { MediaStore } from '../services/MediaStore.js';

export interface TurnRequest {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  causeId: string;
  injected: string;
  /** The newest message a person wrote in `injected`. The only text that can ask the router for a stronger model. */
  latestUserText?: string;
  /** On a routine's turn: the routine's own prompt. The only other text that can invoke a skill that asks for Opus. */
  routinePrompt?: string;
  /** The composer's pick for this chat, on a turn a person started here. RoomRouter never sets it on a hand-off or schedule. */
  chatModel?: string;
  /** What is left of the cause's cost cap; the turn spends at most min(bot budget, this). */
  causeBudgetUsd?: number;
  /**
   * P8: what started this turn, for the model router and the usage breakdown. RoomRouter sets 'user', 'bot'
   * or 'routine'; P5 passes 'trigger'. Left out, it is 'bot' for a hop and 'user' otherwise.
   */
  causeKind?: CauseKind;
  /**
   * P3, decision Q6: the turn's cause was not the human (a routine; from P5 a trigger), so approvals apply
   * even when the hub is in bypass mode. RoomRouter sets it from `requiresApprovals(causeId)`.
   */
  strictApprovals?: boolean;
  /** P2: the routine run this turn belongs to, so a parked turn can still close it when it resumes. */
  runId?: string;
}
export interface TurnResult {
  ok: boolean;
  turnId: string;
  finalText: string;
  costUsd: number;
  error?: string;
  /** P8: the model the turn ended on and the router's reason for it. */
  model?: string;
  modelReason?: string;
  /**
   * P2: the turn ended early because it is waiting on the user (a parked approval card, or a takeover not yet
   * handed back). It is resumed by a new turn later; RoomRouter keeps its routine run open.
   */
  parked?: boolean;
}
/**
 * True when a provider refused to resume because the session it was handed no longer exists on disk.
 * Claude Code reports it as `error_during_execution: No conversation found with session ID: <uuid>`.
 */
export function isStaleSessionError(error: string | undefined): boolean {
  return !!error && /no conversation found with session id/i.test(error);
}

export interface RunnerHooks {
  /** Route mentions produced mid-turn (send_message / handoff tools). Returns handles dispatched. */
  dispatchFromBot: (req: TurnRequest, targets: Bot[], onDone?: (r: TurnResult) => void) => string[];
  setState: (botId: string, roomId: string, state: BotState, note?: string) => void;
  /** P3: a routine tool changed the routines table; the hub reschedules (RoutineScheduler.reload). */
  routinesChanged?: () => void;
}

/**
 * Provider-agnostic turn driver: builds the TurnContext, hands it to the active provider, and turns the
 * provider's TurnSink callbacks into messages, tool chips, events and usage rows. Nothing here knows about
 * any particular agent SDK — that lives in providers/<id>.ts.
 */
export class BotRunner {
  private activeTurns = new Set<string>();
  /** `botId:roomId` to its running turn. A lane runs one turn at a time. */
  private laneTurns = new Map<string, string>();
  private aborts = new Map<string, AbortController>();
  /** Last init info reported by the active provider (GET /api/health). */
  lastInit: ProviderInit = {};
  /** P8: picks the model for bots on `auto`. hub.ts replaces it with one that has the optional classifier. */
  router = new ModelRouter();
  /** P4: set by createHub. Adds the tools of the integrations this bot was granted to every turn. */
  integrations?: IntegrationService;
  /** Set by createHub. Which project folders this bot works in. */
  projects?: ProjectService;
  /** Set by createHub. Which file folder each room uses; a turn may use only its own room's. */
  roomFiles?: RoomFiles;
  /** P2: computer control (take over / hand back / pause). Set by createHub; absent in most unit tests. */
  control?: ComputerControlService;
  /** The owner's PC as a job runner (run_on_pc). Set by createHub; the tool is offered only while it is paired. */
  pcRunner?: PcRunner;

  constructor(
    private repos: Repos,
    private memory: MemoryService,
    private skills: SkillService,
    private broker: PermissionBroker,
    private usage: UsageTracker,
    private hooks: RunnerHooks,
    private providers: ProviderRegistry,
    private turns: TurnRegistry,
    /** Per-bot computers (P1). Left out or switched off, Browser and Desktop are refused: no shared screen. */
    private computers?: ComputerManager,
    /** P7: the read-only knowledge repo folder, when one is synced (read per turn). */
    private p7: { knowledgeDir?: () => string | null; routing?: RoutingRules } = {},
    /** Uploaded pictures; `send_message`'s `image_path` is refused when absent (most unit tests). */
    private media?: MediaStore,
  ) {}

  interrupt(turnId: string) {
    const ac = this.aborts.get(turnId);
    const stopped = this.providers.active().interrupt(turnId);
    if (ac) ac.abort();
    return stopped || !!ac;
  }
  /** Stops the turn a bot is running in a room, if any. Returns whether there was one. */
  interruptLane(botId: string, roomId: string) {
    const turnId = this.laneTurns.get(botId + ':' + roomId);
    return turnId ? this.interrupt(turnId) : false;
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
    const budgetUsd = spendCapsOff() ? Infinity : Math.min(bot.maxBudgetUsd, req.causeBudgetUsd ?? Infinity);
    const provider = this.providers.active();
    const session = this.repos.getSession(bot.id, room.id, provider.id);
    this.memory.ensureHome(bot.id);
    const memoryText = this.memory.read(bot.id);
    const identity = this.memory.readIdentity(bot.id) || bot.description;
    const pluginDir = this.skills.materialize(bot.id, bot.handle);
    const setState = (s: BotState, note?: string) => this.hooks.setState(bot.id, room.id, s, note);

    const wantsDesktop = bot.allowedTools.includes('Desktop') && DESKTOP_AVAILABLE;
    const wantsBrowser = bot.allowedTools.includes('Browser');
    // A bot with Browser or Desktop has its own computer, but it only starts when the turn first calls one of those
    // tools (`useComputer`), and is then held busy until the turn ends: a turn that only talks costs no computer.
    // With none on this hub the turn runs without those two tools. They never fall back to one shared screen.
    let computer: ComputerEndpoint | null = null;
    let computerDown: string | undefined;
    let releaseComputer = () => undefined as void;
    let computerStart: Promise<string | null> | null = null;
    /** Starts the computer on the first call of the turn. Returns why it cannot, or null. A failure is retried on the next call. */
    const useComputer = (): Promise<string | null> => (computerStart ??= (async () => {
      if (this.computers!.status(bot.id).state !== 'live') setState('working', 'starting its computer');
      const got = await this.computers!.acquire(bot.id);
      if (got.ok) {
        releaseComputer = got.release;
        return null;
      }
      got.release();
      computerStart = null;
      return 'Your computer could not start: ' + got.reason;
    })());
    if ((wantsDesktop || wantsBrowser) && !this.computers?.enabled) {
      computerDown = 'This hub has no per-bot computers (POCKETROCKET_COMPUTERS is off).';
    } else if (this.computers && (wantsDesktop || wantsBrowser)) {
      const ep = this.computers.endpoint(bot.id);
      if (ep.perBot) computer = ep;
      else computerDown = 'Every computer slot on this server is taken.';
    }
    const desktopOn = wantsDesktop && !computerDown;
    const browserOn = wantsBrowser && !computerDown;
    const computerStatus = computer?.perBot ? this.computers!.status(bot.id) : null;
    // The approvals setting, read once per turn so a change in Settings applies from the next turn. Under
    // bypass nothing asks, so the request_approval tool (and its prompt text) is dropped.
    // A strict turn (routine, trigger) ignores bypass: the provider runs in ask mode and the broker cards.
    const bypass = this.broker.bypassed && !req.strictApprovals;
    const bestEffort = provider.info.permissions === 'best-effort' && !bypass;
    // P8: the model for this turn. Only ever one the active provider lists; the budget above is computed
    // without it and is never raised by it.
    const providerModels = provider.modelsSync();
    const causeKind: CauseKind = req.causeKind ?? (req.hop > 0 ? 'bot' : 'user');
    // The picker offers Claude's models. A pick left over from before a provider switch is ignored, not translated.
    const chatModel = provider.id === 'claude' && req.chatModel && (req.chatModel === AUTO_MODEL || providerModels.some((m) => m.id === req.chatModel)) ? req.chatModel : null;
    const routeBot = chatModel ? { ...bot, model: chatModel } : bot;
    const routeReq: RouteRequest = {
      bot: routeBot, causeKind, input: req.injected, latestUserText: req.latestUserText, routinePrompt: req.routinePrompt, chosen: !!chatModel, models: providerModels,
      opusSkills: routeBot.model === AUTO_MODEL ? this.skills.opusSkillNames(bot.id) : [],
      fallbackModel: settings.get().defaultModel,
    };
    const picked = await this.router.pick(routeReq);
    let route: RouteChoice = picked;
    const cu = picked.classifierUsage;
    if (cu && (cu.costUsd || cu.inputTokens || cu.outputTokens)) {
      this.usage.record(bot.id, room.id, 'cls-' + nanoid(8), req.causeId, cu, { model: 'claude-haiku-4-5-20251001', routeReason: 'classifier', causeKind });
    }
    // In-turn Auto: on Claude, on a thread a person started. A routine or trigger may be reading forwarded text,
    // and that must not be able to buy Opus. The other providers keep their free rules and failure escalation.
    const mayMoveUp = provider.id === 'claude' && !req.strictApprovals && (causeKind === 'user' || causeKind === 'bot') && canUpgrade(routeReq, picked);
    const up: { asked: boolean; next: RouteChoice | null } = { asked: false, next: null };
    const routing = this.p7.routing;
    const mayPropose = !!routing && causeKind === 'user' && req.hop === 0 && !req.strictApprovals;
    const ac = new AbortController();
    // P2: a turn that has to wait for the user (parked card, takeover not handed back) ends itself here; the
    // abort comes a tick later so the tool result that says so is delivered first.
    let parkedWhy: string | null = null;
    const park = (why: string) => {
      if (parkedWhy) return;
      parkedWhy = why;
      setTimeout(() => ac.abort(), 0);
    };
    // P2 control interlock: the user has control of this bot's computer, or paused it.
    const controlBlocked = () => this.control?.blockedReason(bot.id) ?? null;
    const permCtx = {
      bot, room, turnId, hop: req.hop, causeId: req.causeId, setState: (s: 'blocked' | 'working') => setState(s),
      strictApprovals: !!req.strictApprovals,
      runId: req.runId, park, controlBlocked,
    };

    const tools = createHubTools({
      bot, room, members: req.members, turnId, hop: req.hop, causeId: req.causeId,
      repos: this.repos, memory: this.memory, skills: this.skills, media: this.media, projects: this.projects,
      dispatchFromBot: (targets, room, onDone) => this.hooks.dispatchFromBot(room ? { ...req, room } : req, targets, onDone),
      setState: (s) => setState(s),
      // Added below with this bot's own display rather than the shared one (P1).
      desktop: false,
      // `auto` is a valid choice wherever the provider has a list to route within (P8).
      models: providerModels.length ? [...providerModels.map((m) => m.id), AUTO_MODEL] : [],
      requestApproval: bestEffort ? (a) => this.broker.ask(permCtx, a, ac.signal) : undefined,
      // Every provider, not just the best-effort ones: CLI providers reach hub tools over MCP and never go
      // through the SDK's permission callback, so the gate has to live with the tool (audit 2026-09-09, B6).
      confirmFleetChange: (a) => this.broker.askFleetChange(permCtx, a.tool, a.input, a.reason, ac.signal, { evenUnderBypass: a.evenUnderBypass }),
      confirmOutsideHandoff: (a) => this.broker.askOutsideHandoff(permCtx, a.input, a.reason, ac.signal),
      useStrongerModel: mayMoveUp ? (reason) => {
        if (up.asked) return false;
        up.asked = true;
        const why = redact(reason.replace(/\s+/g, ' ').trim());
        up.next = this.router.upgrade(routeReq, why);
        const label = providerModels.find((m) => m.id === up.next!.model)?.label ?? up.next.model;
        const line = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: 'Moved to ' + label + ': ' + why, payload: null,
          causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: line });
        return true;
      } : undefined,
      proposeRouting: mayPropose ? async (line, reason) => {
        try {
          routing!.withLine(line);
          const r = await this.broker.askRoutingChange(permCtx, { line, reason }, ac.signal);
          if (!r.allowed) return { ok: false, message: r.message };
          routing!.write(routing!.withLine(line));
          return { ok: true, message: 'Added to the routing rules.' };
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
      } : undefined,
      routinesChanged: this.hooks.routinesChanged,
      pcRunner: this.pcRunner,
      signal: ac.signal,
    });

    if (desktopOn && computer) {
      tools.push(...desktopTools({ display: computer.display, xauthority: computer.xauthority, home: computer.home, fileRoots: computer.filesDir ? [computer.filesDir] : [], guard: async () => controlBlocked() ?? (await useComputer()) }));
    }
    if (computer && this.computers) tools.push(viewScreenTool(this.computers, req.members, bot.id));
    // P2: a bot with a computer can hand it to the user (log in, captcha) and wait for it back.
    if ((desktopOn || browserOn) && this.control) {
      tools.push(takeoverTool({
        bot, room, turnId, hop: req.hop, causeId: req.causeId, runId: req.runId, repos: this.repos, control: this.control,
        signal: ac.signal, setState: (s) => setState(s), park, useComputer,
      }));
    }

    // P4: integration tools, only for connections granted to this bot. Writes ask on every call (also under bypass).
    if (this.integrations) {
      tools.push(...createIntegrationTools(this.integrations, bot.id, (a) => this.broker.askIntegrationWrite(permCtx, a.tool, a.input, a.reason, ac.signal)));
    }

    // Chats on one computer share its browser, and each browser tool starts on the first tab, so they would drive the
    // same page. A turn needs a tab of its own before it acts, unless it got there first: a turn already at work is
    // never made to move. Closing a tab moves the browser tool on to a neighbour, possibly another chat's, so a close
    // ends the claim. Numbers shift as tabs close, so while shared a tab is only reached as the current one.
    let tabSettled = false;
    const browserTabRule = (name: string, input?: Record<string, unknown>): string | null => {
      if (!name.startsWith('mcp__browser__')) return null;
      const shared = this.computers!.turnsOn(bot.id) > 1;
      if (name.endsWith('browser_tabs')) {
        if (input?.action === 'new') tabSettled = true;
        if (input?.action === 'select' && shared) return SHARED_TAB_NOTE;
        if (input?.action === 'close') {
          if (shared && (input.index !== undefined || !tabSettled)) return SHARED_TAB_NOTE;
          tabSettled = false;
        }
        return null;
      }
      if (tabSettled) return null;
      if (shared) return SHARED_BROWSER_NOTE;
      tabSettled = true;
      return null;
    };

    const knowledgeDir = this.p7.knowledgeDir?.() ?? null;
    // The one file folder this turn may use: its room's. Every other project and room folder stays shut.
    const folder = this.roomFiles?.forBot(room, bot.id) ?? null;
    const folderDir = folder ? this.roomFiles!.ensure(folder) : null;
    const roomProject = folder?.kind === 'project' ? this.projects?.get(folder.projectSlug!) : undefined;
    const mcpToken = this.turns.registerTurn(tools, computerToolGuard(controlBlocked));
    // The per-turn MCP bearer travels in provider config and can surface in a stderr tail; scrub it
    // everywhere until the turn ends (audit 2026-09-09, B22).
    addSecret(mcpToken);
    const outsideMcp = outsideMcpFor(bot.handle, room);
    for (const s of outsideMcp) addSecret(s.token);
    const ctx: TurnContext = {
      turnId, bot, room, members: req.members,
      systemPrompt: buildSystemPrompt({
        owner: this.repos.owner(),
        bot, room, members: req.members, hop: req.hop, memory: memoryText, identity,
        projects: roomProject ? [{ name: roomProject.name, dir: roomProject.dir }] : undefined,
        roomFolder: folder && folder.kind !== 'project' && folderDir ? { kind: folder.kind, dir: folderDir } : undefined,
        browser: browserOn, desktop: desktopOn,
        toolPrefix: provider.id === 'claude' ? 'mcp__pocketrocket__' : '',
        requestApproval: bestEffort,
        fleetGate: !bypass,
        voice: this.memory.readVoice(bot.id),
        notesCount: this.memory.listNotes(bot.id).length,
        knowledgeDir,
        fleet: this.repos.listBots(),
        computer: computer?.perBot && computer.filesDir && computerStatus
          ? { display: computer.display, filesDir: computer.filesDir, diskBytes: computerStatus.diskBytes, quotaBytes: computerStatus.quotaBytes }
          : undefined,
        computerUnavailable: computerDown,
        routing: routing?.promptText(),
        canMoveUp: mayMoveUp,
        canProposeRouting: mayPropose,
      }),
      input: req.injected,
      resumeToken: session.sdkSessionId,
      workspaceDir: WORKSPACE_DIR,
      botHome: botHome(bot.id),
      tools,
      // Browser/Desktop are dropped for this turn when the bot's computer could not start.
      allowedBuiltins: computerDown ? bot.allowedTools.filter((t) => t !== 'Browser' && t !== 'Desktop') : bot.allowedTools,
      bypassPermissions: bypass,
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
      model: route.model,
      maxBudgetUsd: budgetUsd,
      maxTurns: MAX_TURNS_PER_QUERY,
      signal: ac.signal,
      mcp: { url: this.turns.url(), token: mcpToken },
      knowledgeDir,
      readOnlyDirs: bot.handle === SUPPORT_HANDLE ? supportSourceDirs() : undefined,
      projectDirs: folderDir ? [folderDir] : [],
      shipGuard: this.repos.botSkillIds(bot.id).some((id) => this.repos.getSkill(id)?.name === SHIP_GUARD_SKILL) ? defaultBranchPushDenied : undefined,
      projectGuard: this.projects || this.roomFiles
        ? (name, input, cwd) => folderAccessDenied(name, input, cwd, [
            ...(this.projects ? [{ root: this.projects.root, allowed: roomProject ? [roomProject.slug] : [], known: this.projects.knownSlugs() }] : []),
            ...(this.roomFiles
              ? [{ root: this.roomFiles.roomsDir, allowed: folder?.kind === 'room' ? [room.id] : [], known: this.repos.listRooms().map((r) => r.id) }]
              : []),
          ])
        : undefined,
      cdpUrl: computer?.perBot ? computer.cdpUrl : undefined,
      outsideMcp,
      computerFilesDir: computer?.filesDir ?? undefined,
      controlGuard: controlBlocked,
      computerGate: computer ? async (name, input) => (await useComputer()) ?? browserTabRule(name, input) : undefined,
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
          causeId: req.causeId, hop: req.hop, turnId, model: route.model, modelReason: route.detail,
        });
        lastMessageId = msg.id;
        events.emitEvent({ type: 'message.new', message: msg });
      },
      onToolUse: (id, name, input) => {
        if (computer?.perBot && (name.startsWith('mcp__browser__') || name.includes('desktop_'))) this.computers!.touch(bot.id);
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
    this.laneTurns.set(bot.id + ':' + room.id, turnId);
    let ok = false;
    let error: string | undefined;
    let costUsd = 0;
    try {
      // Waking a computer can take a while: the owner may have removed this bot from the room before it got here.
      const removed = room.memberIds.includes(bot.id) && !this.repos.getRoom(room.id)?.memberIds.includes(bot.id);
      let outcome: TurnOutcome = removed
        ? { ok: false, error: 'removed from this chat', costUsd: 0, usage: EMPTY_USAGE, durationMs: 0 }
        : await provider.runTurn(ctx, sink);
      const record = (o: TurnOutcome) => {
        costUsd += o.costUsd;
        // Only turns the provider actually accounted for become usage rows (matches the pre-provider
        // behaviour: a turn that died before any result reported nothing).
        const u = o.usage;
        if (u.costUsd || u.inputTokens || u.outputTokens) {
          this.usage.record(bot.id, room.id, turnId, req.causeId, u, { model: route.model, routeReason: route.reason, causeKind });
        }
      };
      record(outcome);

      // The CLI's session store is not ours: a re-login, a `cleanupPeriodDays` sweep or a redeploy can drop the
      // transcript our `sessions` row still points at, and then every turn in that room dies with
      // "No conversation found with session ID". Forget the token and run the same input once more from a
      // fresh session rather than leaving the bot permanently broken (seen live on the VPS, 2026-09-10).
      if (ctx.resumeToken && !ac.signal.aborted && isStaleSessionError(outcome.error)) {
        this.repos.saveSession(bot.id, room.id, { sdkSessionId: null, provider: provider.id });
        const note = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
          text: bot.name + "'s saved session no longer exists; starting a fresh one (earlier conversation context is lost).",
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: note });
        setState('thinking');
        outcome = await provider.runTurn({ ...ctx, resumeToken: null, maxBudgetUsd: budgetUsd - costUsd }, sink);
        record(outcome);
      }

      // use_stronger_model: the run that asked has ended cleanly, so its session is saved and its cost is counted.
      // The same session carries on with the stronger model. Nothing is stored, so the next turn routes from scratch.
      const moveUp = async () => {
        const next = up.next;
        up.next = null;
        if (!next || next.model === route.model || ac.signal.aborted || outcome.error) return;
        if (costUsd >= budgetUsd) {
          const line = this.repos.insertMessage({
            roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: bot.name + ' used its budget before it could continue.', payload: null,
            causeId: req.causeId, hop: req.hop, turnId,
          });
          events.emitEvent({ type: 'message.new', message: line });
          return;
        }
        route = next;
        setState('working');
        outcome = await provider.runTurn(
          {
            ...ctx,
            resumeToken: this.repos.getSession(bot.id, room.id, provider.id)?.sdkSessionId ?? ctx.resumeToken,
            input:
              'You are now on the stronger model you asked for, for the rest of this turn. Continue from exactly where ' +
              'you left off and finish the task. Do not start over, re-explain, or ask to move up again.',
            maxBudgetUsd: budgetUsd - costUsd,
            model: route.model,
          },
          sink,
        );
        record(outcome);
      };
      await moveUp();

      // Running out of steps is not a failure, it is an unfinished job. Resume the same session and let it
      // keep going rather than handing the user a dead turn -- but bounded, budget-checked and visible, so
      // a bot stuck in a loop still stops instead of quietly costing three times as much.
      for (let attempt = 1; outcome.error?.startsWith('error_max_turns') && attempt <= MAX_TURN_CONTINUATIONS; attempt++) {
        if (ac.signal.aborted) break;
        if (costUsd >= budgetUsd) break;
        // P8: an auto bot retries on Opus. Same remaining budget either way: the router never raises it.
        const next = this.router.escalate(routeReq, route, 'error_max_turns');
        const escalated = next.model !== route.model;
        if (escalated) console.log('[router] ' + bot.handle + ' ' + turnId + ': ' + route.model + ' -> ' + next.model + ' (' + next.detail + ')');
        route = next;
        const note = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
          text: bot.name + ' hit the ' + MAX_TURNS_PER_QUERY + '-step limit; continuing (' + attempt + '/' + MAX_TURN_CONTINUATIONS + ')' +
            (escalated ? ' on ' + route.model + ' (escalated by the model router)' : '') + '.',
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
            maxBudgetUsd: budgetUsd - costUsd,
            model: route.model,
          },
          sink,
        );
        record(outcome);
      }
      // Asked for during a continuation.
      await moveUp();

      ok = outcome.ok;
      error = outcome.error;
    } catch (e) {
      error = redact(String((e as Error).message ?? e));
    } finally {
      this.activeTurns.delete(turnId);
      this.aborts.delete(turnId);
      this.laneTurns.delete(bot.id + ':' + room.id);
      this.turns.unregister(mcpToken);
      removeSecret(mcpToken);
      releaseComputer();
    }

    if (parkedWhy) {
      // Not a failure: the bot is waiting on the user, and a new turn picks it up with their answer.
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: bot.name + ' is ' + parkedWhy + ' and will continue after that.', payload: null,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
      events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd });
      setState('done', 'parked');
      return { ok: false, parked: true, turnId, finalText: texts.join('\n\n'), costUsd, model: route.model, modelReason: route.detail };
    }
    if (!ok && !error) error = 'Turn ended without a result';
    if (error) error = redact(error);
    if (error) {
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', ...turnFailureNote(bot.name, error, ac.signal.aborted),
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
    }
    events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, error });
    setState(error ? 'error' : 'done');
    return { ok, turnId, finalText: texts.join('\n\n'), costUsd, error, model: route.model, modelReason: route.detail };
  }

  /** Feeds GET /api/health, which answers without the hub token, so the error names no path. */
  static checkExe(): { ok: boolean; error?: string } {
    return fs.existsSync(CLAUDE_EXE) ? { ok: true } : { ok: false, error: 'claude executable not found' };
  }
}
