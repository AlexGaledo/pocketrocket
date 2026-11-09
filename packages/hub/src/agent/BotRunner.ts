import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { AUTO_MODEL, type Bot, type BotState, type CauseKind, type Room, type ToolPayload } from '@pocketrocket/shared';
import { CLAUDE_EXE, DESKTOP_AVAILABLE, MAX_TURNS_PER_QUERY, MAX_TURN_CONTINUATIONS, ROTATE_IDLE_MS, TURN_CACHE_READ_CAP, WORKSPACE_DIR, botHome, spendCapsOff } from '../config.js';
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
import { ModelRouter, canUpgrade, isAuto, type RouteChoice, type RouteRequest } from './ModelRouter.js';
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
import { outsideMcpFor, registerOutsideMcpSecrets, vpsMountable } from '../services/outsideMcp.js';
import { loadKeyRegistry } from '../services/keyRegistry.js';
import { computerToolGuard } from '../permissions/controlInterlock.js';
import type { MediaStore } from '../services/MediaStore.js';
import { AUTO_MEMORY_MODEL, runPass, type PassOutcome } from '../services/AutoMemory.js';
import { buildSeed, buildSummaryPrompt, cleanSummary, readRoomNotes, rotationNote, rotationReason, SUMMARY_SYSTEM_PROMPT } from '../services/SessionRotation.js';

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

/** A narration block as a one-line status note: its first line, capped so the status chip stays short. */
export function narrationNote(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > 140 ? line.slice(0, 139).trimEnd() + '…' : line;
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
  /** The one-shot Haiku call that writes the running room summary when a session rotates. Tests replace it. */
  summarize: (prompt: string, systemPrompt: string) => Promise<PassOutcome> = runPass;

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
    const state = this.repos.getSessionState(bot.id, room.id);
    this.memory.ensureHome(bot.id);
    // Session rotation: Claude reports the context size, so a session that grew too large (or went idle while large,
    // or was never measured) starts over, seeded with a summary and the recent messages, instead of being resumed.
    let resumeToken = session.sdkSessionId;
    let seed = '';
    // The room's own file folder (current.md lives there); also used below for the turn's working roots.
    const folder = this.roomFiles?.forBot(room, bot.id) ?? null;
    const rotateWhy = resumeToken && provider.id === 'claude' ? rotationReason(state, Date.now()) : null;
    if (rotateWhy) {
      resumeToken = null;
      // Forgotten now, so a rotated run that dies before it reports a session cannot leave the old one to resume.
      this.repos.saveSession(bot.id, room.id, { sdkSessionId: null, provider: provider.id });
      const note = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: rotationNote(bot.name, rotateWhy, state.contextTokens),
        payload: null, causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: note });
      const summary = (await this.writeSummary(bot, room.id, session.lastSeenSeq, state.summary)) ?? state.summary;
      seed = buildSeed(this.repos, room.id, session.lastSeenSeq, { summary, roomNotes: readRoomNotes(folder?.dir) });
    }
    // The system prompt has to be byte-identical across resumed turns for the prompt cache to hit, but memory.md
    // changes between them (update_memory, auto-memory). A session keeps the memory and identity it started with;
    // they are refreshed on a fresh session, or once the session has been idle long enough that its cache is cold
    // anyway (so an owner's edit still lands in a quiet chat).
    const cold = state.contextAt == null || Date.now() - state.contextAt > ROTATE_IDLE_MS;
    const keepSnapshot = !!resumeToken && !cold && state.memorySnapshot != null && state.identitySnapshot != null;
    const memoryText = keepSnapshot ? state.memorySnapshot! : this.memory.read(bot.id);
    const identity = keepSnapshot ? state.identitySnapshot! : this.memory.readIdentity(bot.id) || bot.description;
    if (!keepSnapshot) this.repos.saveSessionState(bot.id, room.id, { memorySnapshot: memoryText, identitySnapshot: identity });
    // A fresh session's cumulative cost starts at 0, and it starts small.
    if (!resumeToken) this.repos.saveSessionState(bot.id, room.id, { costTotal: 0, contextTokens: 0, contextAt: Date.now() });
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

    // key-registry.json, read once per turn (an edit applies to the next turn), names only.
    const keyRegistry = loadKeyRegistry();
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
      // Offered on every Claude turn and refused here when this turn may not move up: a tool list that changes between
      // turns of one session invalidates the whole prompt cache.
      useStrongerModel: provider.id === 'claude' ? (reason) => {
        if (!mayMoveUp) return 'Not available on this turn: only an Auto bot on Sonnet, on a thread a person started, can move up. Carry on with this model.';
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
      proposeRouting: routing ? async (line, reason) => {
        if (!mayPropose) return { ok: false, message: 'Routing changes can only be proposed on a turn the owner started directly, not on a hand-off or an automation.' };
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
      keyRegistry: () => keyRegistry,
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
    // The one file folder this turn may use (`folder`, above): its room's. Every other project and room folder stays shut.
    const folderDir = folder ? this.roomFiles!.ensure(folder) : null;
    const roomProject = folder?.kind === 'project' ? this.projects?.get(folder.projectSlug!) : undefined;
    const mcpToken = this.turns.registerTurn(tools, computerToolGuard(controlBlocked));
    // The per-turn MCP bearer travels in provider config and can surface in a stderr tail; scrub it
    // everywhere until the turn ends (audit 2026-09-09, B22).
    addSecret(mcpToken);
    // A server whose declared needs do not all route to this machine (a tier 3 key, say) is not mounted here.
    const outsideMcp = vpsMountable(outsideMcpFor(bot.handle, room), keyRegistry);
    // Bearer tokens and stdio env values (the owner's API keys): scrubbed from tool output, chat and logs.
    registerOutsideMcpSecrets(outsideMcp);
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
        keyRegistry,
        // Stable per bot, not per turn: the system prompt must not change between turns of one session (cache).
        // The tools themselves refuse on turns where mayMoveUp / mayPropose is false.
        canMoveUp: provider.id === 'claude' && isAuto(bot),
        canProposeRouting: !!routing,
      }),
      input: seed ? seed + '\n\n' + req.injected : req.injected,
      resumeToken,
      sessionCostUsd: resumeToken ? state.costTotal : 0,
      cacheReadBudget: TURN_CACHE_READ_CAP > 0 ? TURN_CACHE_READ_CAP : undefined,
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
      outsideMcpGate: async (name, input) => {
        const s = outsideMcp.find((x) => name.startsWith('mcp__' + x.name + '__'));
        if (!s) return 'Unknown outside tool: ' + name;
        const r = await this.broker.askOutsideMcp(permCtx, s.name, name.slice(('mcp__' + s.name + '__').length), input, ac.signal);
        return r.allowed ? null : r.message;
      },
      computerFilesDir: computer?.filesDir ?? undefined,
      controlGuard: controlBlocked,
      computerGate: computer ? async (name, input) => (await useComputer()) ?? browserTabRule(name, input) : undefined,
    };

    events.emitEvent({ type: 'turn.start', turnId, botId: bot.id, roomId: room.id, causeId: req.causeId, hop: req.hop });
    setState('thinking');

    const texts: string[] = [];
    const toolMsgIds = new Map<string, string>();
    let lastMessageId: string | undefined;
    // Text is held, not posted, until we know what follows it. A text block followed by a tool call is
    // narration ("Let's click the mascot to test…") — posting each one turned a browser test into dozens of
    // room messages. It becomes the bot's status note instead. Text with no tool call after it is the reply,
    // posted when the turn ends. Only replies count toward finalText, so narration can't @mention-wake bots.
    let pending: string | undefined;
    const postText = (text: string) => {
      texts.push(text);
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text, payload: null,
        causeId: req.causeId, hop: req.hop, turnId, model: route.model, modelReason: route.detail,
      });
      lastMessageId = msg.id;
      events.emitEvent({ type: 'message.new', message: msg });
    };
    const flushPending = () => {
      if (pending !== undefined) postText(pending);
      pending = undefined;
    };

    const sink: TurnSink = {
      onInit: (info) => { this.lastInit = info; },
      onSession: (token) => {
        if (token && token !== session.sdkSessionId) this.repos.saveSession(bot.id, room.id, { sdkSessionId: token, provider: provider.id });
      },
      onDelta: (text) => events.emitEvent({ type: 'turn.delta', turnId, roomId: room.id, botId: bot.id, text }),
      onText: (text) => {
        // NO_REPLY is the sentinel a bot uses to stay silent; swallow it instead of posting it.
        if (/^\W*NO_REPLY\W*$/.test(text.trim())) {
          pending = undefined; // the bot chose silence: whatever it was about to say goes too
          events.emitEvent({ type: 'bot.state', botId: bot.id, state: 'done', roomId: room.id, note: 'no reply' });
          return;
        }
        pending = pending === undefined ? text : pending + '\n\n' + text;
      },
      onToolUse: (id, name, input) => {
        if (pending !== undefined) {
          setState('working', narrationNote(pending));
          pending = undefined;
        }
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

    // Post the held reply as soon as each run returns, not after the turn's bookkeeping: a hand-off started in
    // this run can finish first, and its result must not land above the reply that announced it.
    const runProvider = async (c: TurnContext, k: TurnSink) => {
      try {
        return await provider.runTurn(c, k);
      } finally {
        flushPending();
      }
    };
    this.activeTurns.add(turnId);
    this.aborts.set(turnId, ac);
    this.laneTurns.set(bot.id + ':' + room.id, turnId);
    let ok = false;
    let error: string | undefined;
    let costUsd = 0;
    // Token brake: cache-read tokens summed over every run of this turn (continuations and move-ups included).
    let cacheRead = 0;
    const brakeOn = TURN_CACHE_READ_CAP > 0;
    const braked = () => brakeOn && cacheRead >= TURN_CACHE_READ_CAP;
    /** What the next run of this turn needs: the session's cost baseline and what is left of the token brake. */
    const nextRun = () => ({
      sessionCostUsd: this.repos.getSessionState(bot.id, room.id).costTotal,
      cacheReadBudget: brakeOn ? Math.max(0, TURN_CACHE_READ_CAP - cacheRead) : undefined,
    });
    const brakeNote = () => {
      const line = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: bot.name + ' stopped instead of continuing: this turn already read ' + cacheRead.toLocaleString('en-US') +
          ' cached tokens (limit ' + TURN_CACHE_READ_CAP.toLocaleString('en-US') + '). Send a message to pick it up again.',
        payload: null, causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: line });
    };
    try {
      // Waking a computer can take a while: the owner may have removed this bot from the room before it got here.
      const removed = room.memberIds.includes(bot.id) && !this.repos.getRoom(room.id)?.memberIds.includes(bot.id);
      let outcome: TurnOutcome = removed
        ? { ok: false, error: 'removed from this chat', costUsd: 0, usage: EMPTY_USAGE, durationMs: 0 }
        : await runProvider(ctx, sink);
      const record = (o: TurnOutcome) => {
        costUsd += o.costUsd;
        cacheRead += o.usage.cacheReadTokens;
        // The session's cumulative cost is the next run's baseline; the last call's input size decides rotation.
        if (o.sessionCostUsd !== undefined) this.repos.saveSessionState(bot.id, room.id, { costTotal: o.sessionCostUsd });
        if (o.contextTokens !== undefined) this.repos.saveSessionState(bot.id, room.id, { contextTokens: o.contextTokens, contextAt: Date.now() });
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
        this.repos.saveSessionState(bot.id, room.id, { costTotal: 0, contextTokens: 0, contextAt: Date.now() });
        const note = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
          text: bot.name + "'s saved session no longer exists; starting a fresh one (earlier conversation context is lost).",
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: note });
        setState('thinking');
        // The lost session's recent messages carry over, as on a rotation (unless this turn already seeded them).
        const lostSeed = seed ? '' : buildSeed(this.repos, room.id, session.lastSeenSeq, { summary: state.summary, roomNotes: readRoomNotes(folder?.dir) });
        outcome = await runProvider(
          { ...ctx, ...nextRun(), input: lostSeed ? lostSeed + '\n\n' + ctx.input : ctx.input, resumeToken: null, maxBudgetUsd: budgetUsd - costUsd },
          sink,
        );
        record(outcome);
      }

      // use_stronger_model: the run that asked has ended cleanly, so its session is saved and its cost is counted.
      // The same session carries on with the stronger model. Nothing is stored, so the next turn routes from scratch.
      const moveUp = async () => {
        // A run that ended in an error keeps the request: a step-limit continuation picks it up instead.
        if (outcome.error) return;
        const next = up.next;
        up.next = null;
        if (!next || next.model === route.model || ac.signal.aborted) return;
        if (braked()) {
          brakeNote();
          return;
        }
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
        outcome = await runProvider(
          {
            ...ctx,
            ...nextRun(),
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
        // The token brake holds with dollar caps off: a turn that already read this much is not handed more steps.
        if (braked()) {
          brakeNote();
          break;
        }
        // The router keeps a step-limit continuation on its tier, but a stronger model the bot asked for during the run
        // (use_stronger_model) applies here rather than costing a run of its own afterwards. Same remaining budget
        // either way: neither raises it.
        const asked = up.next && up.next.model !== route.model ? up.next : null;
        if (asked) up.next = null;
        const next = asked ?? this.router.escalate(routeReq, route, 'error_max_turns');
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
        outcome = await runProvider(
          {
            ...ctx,
            ...nextRun(),
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

    flushPending();
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

  /**
   * Before a rotation: folds the messages that will not be replayed into the room's running summary with one cheap,
   * tool-less Haiku call (the auto-memory pass options), and stores it on the session row. Returns the new summary, or
   * null when there was nothing older than the replayed window or the call failed (the old summary then stays).
   */
  private async writeSummary(bot: Bot, roomId: string, lastSeenSeq: number, previous: string | null): Promise<string | null> {
    const prompt = buildSummaryPrompt(this.repos, bot, roomId, lastSeenSeq, previous);
    if (!prompt) return null;
    try {
      const outcome = await this.summarize(prompt, SUMMARY_SYSTEM_PROMPT);
      const u = outcome.usage;
      // Not tied to the cause: like auto-memory, it must not count toward a thread's cost cap.
      if (u.costUsd || u.inputTokens || u.outputTokens) {
        this.usage.record(bot.id, roomId, 'sum-' + nanoid(8), null, u, { model: AUTO_MEMORY_MODEL, routeReason: 'session-summary', causeKind: 'memory' });
      }
      const summary = cleanSummary(outcome);
      if (summary) this.repos.saveSessionState(bot.id, roomId, { summary });
      else console.warn('[rotation ' + bot.handle + '] summary skipped: ' + redact(outcome.error ?? 'empty reply'));
      return summary;
    } catch (e) {
      console.warn('[rotation ' + bot.handle + '] summary failed: ' + redact(String((e as Error).message ?? e)));
      return null;
    }
  }

  /** Feeds GET /api/health, which answers without the hub token, so the error names no path. */
  static checkExe(): { ok: boolean; error?: string } {
    return fs.existsSync(CLAUDE_EXE) ? { ok: true } : { ok: false, error: 'claude executable not found' };
  }
}
