import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { AUTO_MODEL, type Bot, type BotBackup, type BotState, type CauseKind, type ProviderId, type Room, type ToolPayload } from '@pocketrocket/shared';
import path from 'node:path';
import { ATTACHMENTS_DIR, CLAUDE_EXE, DESKTOP_AVAILABLE, MAX_TURNS_PER_QUERY, MAX_TURN_CONTINUATIONS, ROTATE_IDLE_MS, TURN_CACHE_READ_CAP, WORKSPACE_DIR, botHome, spendCapsOff } from '../config.js';
import { SUPPORT_HANDLE, supportSourceDirs } from '../services/SeedBots.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { fileNote, imageNote, materializeFiles, materializeImages } from './attachments.js';
import { EMPTY_USAGE, steerTurn, type AgentProvider, type ProviderInit, type SteerInput, type TurnContext, type TurnLimit, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { TurnRegistry } from '../mcp/httpServer.js';
import { addSecret, redact, removeSecret } from '../providers/redact.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import type { PcRunner } from '../services/PcRunner.js';
import type { WorkflowRunner } from '../services/WorkflowRunner.js';
import type { PcSessions } from '../services/PcSessions.js';
import type { SessionMoves } from '../services/SessionMoves.js';
import { createHubTools } from './botTools.js';
import { settings } from '../services/SettingsStore.js';
import { ModelRouter, canUpgrade, isAuto, type RouteChoice, type RouteRequest } from './ModelRouter.js';
import type { RoutingRules } from '../services/RoutingRules.js';
import { desktopTools, SHARED_BROWSER_NOTE, SHARED_TAB_NOTE, viewScreenTool } from './desktopTools.js';
import type { ComputerEndpoint, ComputerManager } from '../services/ComputerManager.js';
import type { IntegrationService } from '../services/IntegrationService.js';
import { createIntegrationTools } from '../integrations/tools.js';
import { credentialTools } from './credentialTools.js';
import type { CredentialStore } from '../services/CredentialStore.js';
import type { ProjectService } from '../services/ProjectService.js';
import { folderAccessDenied } from '../permissions/projectGuard.js';
import { buildStateHeader } from '../services/StateHeader.js';
import { fileRootOf, type RoomFiles } from '../rooms/roomFiles.js';
import { SHIP_GUARD_SKILL, defaultBranchPushDenied } from '../permissions/shipGuard.js';
import { reposFileWriteDenied } from '../permissions/projectGuard.js';
import { normaliseRemote } from '@pocketrocket/shared';
import type { ComputerControlService } from '../services/ComputerControl.js';
import { takeoverTool } from './takeoverTool.js';
import type { FormBroker } from '../services/FormBroker.js';
import { turnFailureNote } from './turnFailure.js';
import { outsideMcpFor, registerOutsideMcpSecrets, vpsMountable } from '../services/outsideMcp.js';
import { loadKeyRegistry } from '../services/keyRegistry.js';
import { computerToolGuard } from '../permissions/controlInterlock.js';
import { decisionsWriteDenied, relIn, type FileRevisions, type FileRoot, type RevisionAuthor } from '../services/FileRevisions.js';
import type { MediaStore } from '../services/MediaStore.js';
import { AUTO_MEMORY_MODEL, runPass, type PassOutcome } from '../services/AutoMemory.js';
import { buildSeed, buildSummaryPrompt, cleanSummary, contextUsage, readRoomNotes, rotationNote, rotationReason, SUMMARY_SYSTEM_PROMPT, SWITCH_SEED_LEAD, switchNote } from '../services/SessionRotation.js';

export interface TurnRequest {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  causeId: string;
  injected: string;
  /** Media refs of the pictures a person attached in the unread window (U2a). */
  images?: string[];
  /**
   * A Claude Code command (`/compact`, `/context`...) the person sent as the only new message. A Claude turn sends it
   * raw, as the whole input, so the CLI runs it; other providers get the transcript as usual and answer it themselves.
   */
  slashCommand?: string;
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
  /** What this turn belongs to (`routine:<runId>`, `workflow:<runId>:<nodeId>`), so a parked turn can still settle it when it resumes. */
  ownerRef?: string;
  /** The last turn here was cut off (token brake, step limit): start a fresh, small session instead of resuming the big one. */
  freshSession?: boolean;
  /**
   * M8 (P3-1): run this turn on this provider and model instead of the bot's own: its backup, after the owner pressed
   * Continue on a failover card (or while that press is in force). RoomRouter always sets `strictApprovals` with it.
   */
  providerOverride?: BotBackup;
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
  /** The turn was stopped (Stop, the owner removing the bot), not ended by the provider. */
  stopped?: boolean;
  /** Set when the owner stopped it (Stop, a queue's Send now): the runner posted no failure note (02 task 2.3). */
  stoppedBy?: 'owner';
  /**
   * Steering: uuids of the steers this turn was given (`BotRunner.steer`). `consumedSteers` reached the model;
   * `unansweredSteers` never did (Stop, an error, a turn that ended first), so the router queues them again.
   * Absent when the turn took no steer.
   */
  consumedSteers?: string[];
  unansweredSteers?: string[];
  /** M8: the run ended on this provider limit (P0-1), so the router may offer the failover card. */
  limit?: TurnLimit;
  /** M8: the provider the turn ran on (the bot's own, or `providerOverride`). */
  provider?: ProviderId;
}
/** Bridge P6: one turn of a moved PC session, run at the VPS (BotRunner.runOffloadTurn). */
export interface OffloadTurnRequest {
  /** The room's own member whose tools and permissions the turn uses. */
  bot: Bot;
  room: Room;
  members: Bot[];
  /** The Claude Code session to resume: the PC session's own id. */
  sessionId: string;
  /** The worktree on the VPS: the folder the rewritten session file is filed under. */
  cwd: string;
  model: string;
  prompt: string;
}
export interface OffloadTurnOutcome {
  ok: boolean;
  finalText: string;
  costUsd: number;
  error?: string;
  /** Set when the CLI continued under another id than the one it was asked to resume. */
  sessionId?: string;
}

/** True for a shell command that runs `git push` in any spelling the hub can see: `git push`, `git -C x push`, `git -c a=b push origin`. */
export function pushesToRemote(command: string): boolean {
  return /(^|[\s;&|(`])git\b[^;&|\n]*\bpush\b/i.test(command);
}
export const OFFLOAD_PUSH_DENIED = 'Pushing is off in a turn on the VPS. Your work is committed to the wip branch for you when the turn ends; the owner pulls it back to the PC.';

/** A person's message for a running turn (RoomRouter): its transcript line and the pictures it carries. */
export interface SteerRequest {
  uuid: string;
  text: string;
  /** Media refs, materialized for the bot like a turn's own pictures. */
  images?: string[];
}
/** `accepted` names the turn it joined; `queued` says why it could not (the router queues it instead). */
export type LaneSteerResult = { status: 'accepted'; turnId: string } | { status: 'queued'; reason: 'provider' | 'between-runs' };

/** A lane's running turn as `steer` and `interrupt` see it. */
interface LaneTurn {
  turnId: string;
  /** The provider the turn started on. Steers and Stop go here even if the active provider changes mid-turn. */
  provider: AgentProvider;
  /** A provider run is reading right now. False in the gaps between runs (stale retry, move-up, continuation). */
  running: boolean;
  /** Steers given to this turn and not yet consumed, by uuid: carried into the next run, or returned unanswered. */
  steers: Map<string, SteerInput>;
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
  private laneTurns = new Map<string, LaneTurn>();
  /** turnId to the provider it started on (Stop must reach that one, not whatever is active now). */
  private turnProviders = new Map<string, AgentProvider>();
  private aborts = new Map<string, AbortController>();
  /** Turns the owner stopped (Stop, a queue's Send now): they end with a "stopped by you" note, not a failure. */
  private ownerStops = new Set<string>();
  /**
   * Last init info each provider reported, by provider (GET /api/health reads Claude's; GET /api/debug/last-init
   * returns them all). Keyed so two bots on two providers do not overwrite each other's.
   */
  lastInit: Partial<Record<ProviderId, ProviderInit>> = {};
  /**
   * M6 (P1-6): Claude is set up and not at a limit (ProviderHealth), so the Claude-only rotation summary may run.
   * Set by createHub to `providers.claudeReady`; left unset (unit tests) it counts as ready.
   */
  claudeReady?: () => boolean;
  /** M6: the skill index a session started with, by `botId:roomId`, so a non-Claude prompt stays byte-stable while it is resumed. */
  private skillIndexShown = new Map<string, { name: string; description: string }[]>();
  /** P8: picks the model for bots on `auto`. hub.ts replaces it with one that has the optional classifier. */
  router = new ModelRouter();
  /** P4: set by createHub. Adds the tools of the integrations this bot was granted to every turn. */
  integrations?: IntegrationService;
  /** Set by createHub. Which project folders this bot works in. */
  projects?: ProjectService;
  /** Set by createHub. Which file folder each room uses; a turn may use only its own room's. */
  roomFiles?: RoomFiles;
  /** Bridge P1: who changed each shared file. Set by createHub; absent in most unit tests. */
  revisions?: FileRevisions;
  /** Signature of the state block each (bot, room) last got, so an unchanged one is not repeated every turn. */
  private stateShown = new Map<string, string>();
  /** P2: computer control (take over / hand back / pause). Set by createHub; absent in most unit tests. */
  control?: ComputerControlService;
  /** The owner's PC as a job runner (run_on_pc). Set by createHub; the tool is offered only while it is paired. */
  pcRunner?: PcRunner;
  /** Workflows v1: the bot tools `list_workflows`, `create_workflow` and `update_workflow`. */
  workflows?: WorkflowRunner;
  /** Bridge P4: the PC session mirror, read-only, for @persona's list_pc_sessions and read_pc_session. */
  pcSessions?: PcSessions;
  /** Bridge P6: moved PC sessions, for propose_move and the resume lock in run_on_pc. */
  sessionMoves?: SessionMoves;
  /** G4: saved logins for `fill_credential`. Set by createHub; absent in most unit tests. */
  credentials?: CredentialStore;
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

  /** U4: waits for the owner's answers to request_form cards. Set by the hub; without it the tool is not offered. */
  forms?: FormBroker;

  /**
   * Stops a turn. `by: 'owner'` (Stop, a queue's Send now) marks it as the owner's choice: the turn then ends without
   * an error event or failure note, and its result says `stoppedBy: 'owner'` so the router posts "stopped by you".
   */
  interrupt(turnId: string, by?: 'owner') {
    const ac = this.aborts.get(turnId);
    if (by === 'owner' && ac) this.ownerStops.add(turnId);
    // Only the provider the turn started on can stop it: with a provider per bot, the default one may not be running it.
    const stopped = this.turnProviders.get(turnId)?.interrupt(turnId) ?? false;
    if (ac) ac.abort();
    return stopped || !!ac;
  }
  /** Stops the turn a bot is running in a room, if any. Returns whether there was one. */
  interruptLane(botId: string, roomId: string, by?: 'owner') {
    const lane = this.laneTurns.get(botId + ':' + roomId);
    return lane ? this.interrupt(lane.turnId, by) : false;
  }
  /**
   * Steering: pushes a person's message into the turn this bot is running in this room. Only while a provider run
   * is reading (never into the gaps between runs, where it would land in a dead query) and only through the
   * provider the turn started on. `accepted` means pushed, not answered: the turn's result says which were consumed,
   * and steers a run leaves unconsumed are carried into the next run of the same turn.
   */
  steer(botId: string, roomId: string, req: SteerRequest): LaneSteerResult {
    const lane = this.laneTurns.get(botId + ':' + roomId);
    // No turn yet (semaphore wait, rotation summary, classifier): the turn about to start will be on the bot's provider.
    const bot = lane ? null : this.repos.getBot(botId);
    if (!(lane?.provider ?? (bot ? this.providerFor(bot) : this.providers.active())).steer) return { status: 'queued', reason: 'provider' };
    if (!lane?.running) return { status: 'queued', reason: 'between-runs' };
    const images = materializeImages(this.media, ATTACHMENTS_DIR, botId, req.images);
    const files = materializeFiles(this.media, ATTACHMENTS_DIR, botId, req.images);
    const input: SteerInput = { uuid: req.uuid, text: req.text + imageNote(images) + fileNote(files), ...(images.length ? { images } : {}) };
    const r = steerTurn(lane.provider, lane.turnId, input);
    if (r.status !== 'accepted') return r;
    lane.steers.set(input.uuid, input);
    return { status: 'accepted', turnId: lane.turnId };
  }
  isActive(turnId: string) {
    return this.activeTurns.has(turnId);
  }
  /** Turns running right now (GET /api/busy). */
  activeTurnCount(): number {
    return this.activeTurns.size;
  }
  /** Interrupt every in-flight turn (graceful shutdown). */
  interruptAll() {
    for (const id of [...this.activeTurns]) this.interrupt(id);
  }

  /** M6: the provider `bot` runs on. Test doubles of the registry that predate `forBot` get the default one. */
  private providerFor(bot: Bot): AgentProvider {
    return this.providers.forBot ? this.providers.forBot(bot) : this.providers.active();
  }

  /** Model ids a provider offers, plus `auto` (P8), for the bot tools' checks; [] when it has no list. Null = the default provider. */
  private modelIdsOf(id: ProviderId | null): string[] {
    const p = id ? this.providers.get(id) : this.providers.active();
    const ms = p.modelsSync();
    return ms.length ? [...ms.map((m) => m.id), AUTO_MODEL] : [];
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { bot, room } = req;
    const turnId = nanoid(10);
    const budgetUsd = spendCapsOff() ? Infinity : Math.min(bot.maxBudgetUsd, req.causeBudgetUsd ?? Infinity);
    // M8 (P3-1): a failover turn runs on the backup the owner pressed Continue for. The failover service only offers an
    // enabled provider; should it be gone by now the bot's own runs instead (still strict), never some other one.
    const override = req.providerOverride && this.providers.get(req.providerOverride.provider).id === req.providerOverride.provider ? req.providerOverride : undefined;
    const provider = override ? this.providers.get(override.provider) : this.providerFor(bot);
    // M6 (P1-4): the provider that wrote this (bot, room)'s session, read before `getSession` drops a token another one wrote.
    const sessionProvider = this.repos.getSession(bot.id, room.id).provider;
    const session = this.repos.getSession(bot.id, room.id, provider.id);
    const state = this.repos.getSessionState(bot.id, room.id);
    this.memory.ensureHome(bot.id);
    // Session rotation: Claude reports the context size, so a session that grew too large (or went idle while large,
    // or was never measured) starts over, seeded with a summary and the recent messages, instead of being resumed.
    let resumeToken = session.sdkSessionId;
    let seed = '';
    // The room's own file folder (current.md lives there); also used below for the turn's working roots.
    const folder = this.roomFiles?.forBot(room, bot.id) ?? null;
    // M8 (P4-1): any provider that reports the context size rotates on it (Claude, ACP agents); one that reports nothing is never measured.
    const rotateWhy = resumeToken && (provider.id === 'claude' || provider.reportsContextTokens) ? (req.freshSession ? 'cutoff' : rotationReason(state, Date.now())) : null;
    // M6 (P1-4): the bot moved to another provider since its last turn here (the owner changed its provider, or the
    // default it follows). The old session cannot be resumed on the new one, so it starts over seeded with the summary,
    // the room notes and the recent messages, as a rotation does. Switching back seeds again: there is no token per
    // provider, because the session's cost baseline (`costTotal`) is not per provider and resuming an old session on
    // a zero baseline would stop it at once.
    const switched = !!sessionProvider && sessionProvider !== provider.id;
    if (rotateWhy || switched) {
      resumeToken = null;
      // Forgotten now, so a rotated run that dies before it reports a session cannot leave the old one to resume.
      this.repos.saveSession(bot.id, room.id, { sdkSessionId: null, provider: provider.id });
      const note = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: switched ? switchNote(bot.name, provider.label) : rotationNote(bot.name, rotateWhy!, state.contextTokens),
        payload: null, causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: note });
      const summary = (await this.writeSummary(bot, room.id, session.lastSeenSeq, state.summary)) ?? state.summary;
      seed = buildSeed(this.repos, room.id, session.lastSeenSeq, { summary, roomNotes: readRoomNotes(folder?.dir), ...(switched ? { lead: SWITCH_SEED_LEAD } : {}) });
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
    // M6 (P1-7): Claude loads skills from the plugin dir; other providers get them as text, an index in the prompt and
    // `read_skill`. The index is kept with the session, like memory, so the prompt does not change while it is resumed.
    const skillsAsText = provider.id !== 'claude';
    let skillIndex: { name: string; description: string }[] | undefined;
    if (skillsAsText) {
      const key = bot.id + ':' + room.id;
      skillIndex = (keepSnapshot ? this.skillIndexShown.get(key) : undefined) ?? this.skills.skillIndex(bot.id);
      this.skillIndexShown.set(key, skillIndex);
    }
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
    const chatModel = !override && provider.id === 'claude' && req.chatModel && (req.chatModel === AUTO_MODEL || providerModels.some((m) => m.id === req.chatModel)) ? req.chatModel : null;
    // A failover turn runs the backup's model; the composer's pick and the bot's own model are for its own provider.
    const baseBot = override ? { ...bot, model: override.model } : bot;
    const routeBot = chatModel ? { ...baseBot, model: chatModel } : baseBot;
    const routeReq: RouteRequest = {
      bot: routeBot, causeKind, input: req.injected, latestUserText: req.latestUserText, routinePrompt: req.routinePrompt, chosen: !!chatModel, models: providerModels,
      opusSkills: routeBot.model === AUTO_MODEL ? this.skills.opusSkillNames(bot.id) : [],
      fallbackModel: settings.get().defaultModel,
    };
    const picked = await this.router.pick(routeReq);
    let route: RouteChoice = picked;
    const cu = picked.classifierUsage;
    if (cu && (cu.costUsd || cu.inputTokens || cu.outputTokens)) {
      this.usage.record(bot.id, room.id, 'cls-' + nanoid(8), req.causeId, cu, { model: 'claude-haiku-4-5-20251001', routeReason: 'classifier', causeKind, provider: 'claude' });
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
      ownerRef: req.ownerRef, park, controlBlocked,
    };

    // key-registry.json, read once per turn (an edit applies to the next turn), names only.
    const keyRegistry = loadKeyRegistry();
    // Bridge P1: the turn's shared folder as a tracked root, and who this turn writes as.
    const fileRoot: FileRoot | null = folder ? fileRootOf(room, folder) : null;
    const fileAuthor: RevisionAuthor = {
      kind: settings.get().personaBotId === bot.id ? 'persona' : 'bot',
      id: bot.id, label: '@' + bot.handle, machine: process.platform === 'win32' ? 'pc' : 'vps', sessionId: turnId, roomId: room.id,
    };
    // Bridge P2: the folder's current.md and latest decisions go in the turn's input, not the system prompt (which has to
    // stay identical across resumed turns for the cache). Shown on a fresh or rotated session, and again only after
    // one of the two files changed since this bot last saw them in this room.
    let stateHeader = '';
    if (fileRoot && this.revisions) {
      const block = buildStateHeader(fileRoot, this.revisions);
      const key = bot.id + ':' + room.id;
      if (block && (!resumeToken || this.stateShown.get(key) !== block.signature)) {
        stateHeader = block.text;
        this.stateShown.set(key, block.signature);
      }
    }
    const tools = createHubTools({
      fileRoot, fileAuthor, revisions: this.revisions,
      bot, room, members: req.members, turnId, hop: req.hop, causeId: req.causeId,
      repos: this.repos, memory: this.memory, skills: this.skills, media: this.media, projects: this.projects,
      dispatchFromBot: (targets, room, onDone) => this.hooks.dispatchFromBot(room ? { ...req, room } : req, targets, onDone),
      setState: (s) => setState(s),
      // Added below with this bot's own display rather than the shared one (P1).
      desktop: false,
      // `auto` is a valid choice wherever the provider has a list to route within (P8).
      models: providerModels.length ? [...providerModels.map((m) => m.id), AUTO_MODEL] : [],
      // M6 (P1-3): create_bot and update_bot check a model against the provider the target bot runs on.
      modelsFor: (id) => this.modelIdsOf(id),
      skillsAsText,
      forms: this.forms,
      strictApprovals: !!req.strictApprovals,
      requestApproval: bestEffort ? (a) => this.broker.ask(permCtx, a, ac.signal) : undefined,
      // Every provider, not just the best-effort ones: CLI providers reach hub tools over MCP and never go
      // through the SDK's permission callback, so the gate has to live with the tool (audit 2026-09-09, B6).
      confirmFleetChange: (a) => this.broker.askFleetChange(permCtx, a.tool, a.input, a.reason, ac.signal, { evenUnderBypass: a.evenUnderBypass, machine: a.machine }),
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
      workflows: this.workflows,
      pcSessions: this.pcSessions,
      sessionMoves: this.sessionMoves,
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
        bot, room, turnId, hop: req.hop, causeId: req.causeId, ownerRef: req.ownerRef, repos: this.repos, control: this.control,
        signal: ac.signal, setState: (s) => setState(s), park, useComputer,
      }));
    }

    // G4: typing a saved login into this bot's browser. Only where there is a browser, and only with a card each time.
    if (browserOn && computer && this.credentials) {
      tools.push(...credentialTools({
        store: this.credentials, db: this.repos.db, bot, roomId: room.id, cdpUrl: computer.cdpUrl,
        confirm: (a) => this.broker.askCredentialFill(permCtx, a, ac.signal),
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
    const projectRepos = roomProject ? this.projects!.reposFile(roomProject.slug).repos : [];
    // The persona is the owner's admin: it may read every project's folder from any room, read-only. Writes stay
    // limited to the room's own folder (the read-only roots below are mounted read-only in the sandbox and refused
    // by the write guard, bypass or not). The hub's key files are never under a project folder.
    const isPersona = settings.get().personaBotId === bot.id;
    const personaProjectDirs = isPersona && this.projects
      ? this.projects.list().filter((p) => p.slug !== roomProject?.slug && (!folderDir || path.resolve(p.dir) !== path.resolve(folderDir))).map((p) => p.dir)
      : [];
    const mcpToken = this.turns.registerTurn(tools, computerToolGuard(controlBlocked));
    // The per-turn MCP bearer travels in provider config and can surface in a stderr tail; scrub it
    // everywhere until the turn ends (audit 2026-09-09, B22).
    addSecret(mcpToken);
    // A server whose declared needs do not all route to this machine (a tier 3 key, say) is not mounted here.
    const outsideMcp = vpsMountable(outsideMcpFor(bot.handle, room), keyRegistry);
    // Bearer tokens and stdio env values (the owner's API keys): scrubbed from tool output, chat and logs.
    registerOutsideMcpSecrets(outsideMcp);
    const images = materializeImages(this.media, ATTACHMENTS_DIR, bot.id, req.images);
    const files = materializeFiles(this.media, ATTACHMENTS_DIR, bot.id, req.images);
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
        skillIndex,
      }),
      input: req.slashCommand && provider.id === 'claude'
        ? req.slashCommand
        : (stateHeader ? stateHeader + '\n\n' : '') + (seed ? seed + '\n\n' + req.injected : req.injected) + imageNote(images) + fileNote(files),
      ...(images.length ? { images } : {}),
      resumeToken,
      sessionCostUsd: resumeToken ? state.costTotal : 0,
      cacheReadBudget: TURN_CACHE_READ_CAP > 0 ? TURN_CACHE_READ_CAP : undefined,
      workspaceDir: WORKSPACE_DIR,
      botHome: botHome(bot.id),
      tools,
      // Browser/Desktop are dropped for this turn when the bot's computer could not start.
      allowedBuiltins: computerDown ? bot.allowedTools.filter((t) => t !== 'Browser' && t !== 'Desktop') : bot.allowedTools,
      bypassPermissions: bypass,
      strictApprovals: !!req.strictApprovals,
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
      readOnlyDirs: [...(bot.handle === SUPPORT_HANDLE ? supportSourceDirs() : []), ...(images.length || files.length ? [path.dirname((images[0] ?? files[0]).path)] : []), ...personaProjectDirs],
      projectDirs: folderDir ? [folderDir] : [],
      // The safe-shipping skill turns the default-branch check on per bot; a project's repo list turns it on, with the repos'
      // own protected branches, for any bot on that project's chat.
      shipGuard: projectRepos.length || this.repos.botSkillIds(bot.id).some((id) => this.repos.getSkill(id)?.name === SHIP_GUARD_SKILL)
        ? (command, cwd) => defaultBranchPushDenied(command, cwd, undefined, projectRepos.length
            ? (remote) => {
                const want = normaliseRemote(remote);
                return want ? projectRepos.filter((r) => normaliseRemote(r.remote) === want).flatMap((r) => r.protected) : [];
              }
            : undefined)
        : undefined,
      projectGuard: this.projects || this.roomFiles
        ? (name, input, cwd) => folderAccessDenied(name, input, cwd, [
            ...(this.projects
              ? [{ root: this.projects.root, allowed: isPersona ? this.projects.knownSlugs() : roomProject ? [roomProject.slug] : [], known: this.projects.knownSlugs(), listable: isPersona }]
              : []),
            ...(this.roomFiles
              ? [{ root: this.roomFiles.roomsDir, allowed: folder?.kind === 'room' ? [room.id] : [], known: this.repos.listRooms().map((r) => r.id) }]
              : []),
          ])
        : undefined,
      fileGuard: fileRoot || this.projects
        ? (name, input, cwd) => (fileRoot ? decisionsWriteDenied(name, input, cwd, [fileRoot]) : null) ?? (this.projects ? reposFileWriteDenied(name, input, cwd, this.projects.root) : null)
        : undefined,
      fileWritten: fileRoot && this.revisions
        ? (name, input, cwd) => {
            const p = input.file_path ?? input.notebook_path;
            if (typeof p !== 'string' || !p) return;
            const rel = relIn(fileRoot, path.resolve(cwd, p));
            if (rel) this.revisions!.record(fileRoot, rel, { ...fileAuthor, tool: name });
          }
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
      onInit: (info) => { this.lastInit[provider.id] = info; },
      // M5: plan-limit reports feed ProviderHealth (warnings and holds). Test doubles of the registry leave it out.
      onLimit: (r) => this.providers.health?.report(provider.id, r, route.model),
      // M8 (P4-1): a quiet note the provider asked for (an ACP agent compacted its context).
      onNote: (text) => {
        const msg = this.repos.insertMessage({
          roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: bot.name + "'s " + provider.label + ' session ' + text,
          payload: null, causeId: req.causeId, hop: req.hop, turnId,
        });
        events.emitEvent({ type: 'message.new', message: msg });
      },
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
    // Steering: each run gets the steers earlier runs left unconsumed (stale retry, move-up, continuation), and a
    // steer is only pushed while a run is reading.
    const lane: LaneTurn = { turnId, provider, running: false, steers: new Map() };
    const consumedSteers: string[] = [];
    const runProvider = async (c: TurnContext, k: TurnSink) => {
      const carried = [...lane.steers.values()];
      lane.running = true;
      try {
        const o = await provider.runTurn(carried.length ? { ...c, carriedSteers: carried } : c, k);
        for (const u of o.steers?.consumed ?? []) {
          if (lane.steers.delete(u)) consumedSteers.push(u);
        }
        return o;
      } finally {
        lane.running = false;
        flushPending();
      }
    };
    /** What the router needs to settle this turn's steers. */
    const steerResult = () =>
      consumedSteers.length || lane.steers.size ? { consumedSteers: [...consumedSteers], unansweredSteers: [...lane.steers.keys()] } : {};
    this.activeTurns.add(turnId);
    this.aborts.set(turnId, ac);
    this.turnProviders.set(turnId, provider);
    this.laneTurns.set(bot.id + ':' + room.id, lane);
    let ok = false;
    let error: string | undefined;
    let stoppedByOwner = false;
    let limit: TurnLimit | undefined;
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
        if (o.contextTokens !== undefined) {
          this.repos.saveSessionState(bot.id, room.id, { contextTokens: o.contextTokens, contextAt: Date.now(), ...(o.contextWindow ? { contextWindow: o.contextWindow } : {}) });
        }
        // Only turns the provider actually accounted for become usage rows (matches the pre-provider
        // behaviour: a turn that died before any result reported nothing). `accounted` covers a finished run that
        // reports no cost or tokens (Gemini over ACP), which would otherwise never show in Usage.
        const u = o.usage;
        if (o.accounted || u.costUsd || u.inputTokens || u.outputTokens) {
          // P0-4: the model that actually answered (an SDK fallback), not just the one asked for.
          this.usage.record(bot.id, room.id, turnId, req.causeId, u, { model: o.model ?? route.model, routeReason: route.reason, causeKind, provider: provider.id });
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
      // M5: the run ended on a provider limit. ProviderHealth holds it until it resets; the note below says so.
      limit = outcome.limit;
      if (limit) this.providers.health?.hold(provider.id, limit, outcome.model ?? route.model);
    } catch (e) {
      error = redact(String((e as Error).message ?? e));
    } finally {
      stoppedByOwner = this.ownerStops.delete(turnId) && ac.signal.aborted;
      this.activeTurns.delete(turnId);
      this.aborts.delete(turnId);
      this.turnProviders.delete(turnId);
      lane.running = false;
      this.laneTurns.delete(bot.id + ':' + room.id);
      this.turns.unregister(mcpToken);
      removeSecret(mcpToken);
      releaseComputer();
    }

    flushPending();
    // P4-2: the session's context size for the meter, from providers that measure it.
    const ctxUsage = provider.reportsContextTokens ? contextUsage(this.repos.getSessionState(bot.id, room.id)) : undefined;
    const context = ctxUsage ? { context: ctxUsage } : {};
    if (parkedWhy) {
      // Not a failure: the bot is waiting on the user, and a new turn picks it up with their answer.
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        text: bot.name + ' is ' + parkedWhy + ' and will continue after that.', payload: null,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
      events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, ...context });
      setState('done', 'parked');
      return { ok: false, parked: true, turnId, finalText: texts.join('\n\n'), costUsd, model: route.model, modelReason: route.detail, ...steerResult() };
    }
    if (!ok && !error) error = 'Turn ended without a result';
    if (error) error = redact(error);
    if (stoppedByOwner) {
      // 02 task 2.3: a stop the owner asked for is not a failure. No failure note, no error event or state: the router
      // posts one "stopped by you" note once it knows whether unanswered steers or a queue run next.
      events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, stoppedBy: 'owner', ...context });
      setState('done');
      return {
        ok, turnId, finalText: texts.join('\n\n'), costUsd, error, model: route.model, modelReason: route.detail,
        stopped: true, stoppedBy: 'owner', ...steerResult(),
      };
    }
    if (error) {
      const note = turnFailureNote(bot.name, error, ac.signal.aborted, limit ? { ...limit, provider: provider.label } : undefined);
      // M8 (P3-1): a usage limit with no backup set gets no card, only this note and the pointer to set one.
      if (limit?.kind === 'usage' && !override && !bot.backup) {
        note.text += ' Set a backup in ' + bot.name + "'s settings to continue on another provider next time.";
        note.payload = { ...note.payload, setBackup: true };
      }
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system',
        ...note,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
    }
    events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, error, ...context });
    setState(error ? 'error' : 'done');
    return {
      ok, turnId, finalText: texts.join('\n\n'), costUsd, error, model: route.model, modelReason: route.detail,
      ...(ac.signal.aborted ? { stopped: true } : {}), ...steerResult(),
      ...(limit ? { limit } : {}), provider: provider.id,
    };
  }

  /**
   * Bridge P6: one turn of a moved PC session through the Claude provider. It resumes the session's own id in the
   * worktree, on the owner's `offloadModel`, with the hub tools and permissions of `req.bot` in `req.room`. Nothing is posted
   * to the room from here (the caller posts one line when the turn ends) and no (bot, room) session is touched. `git push`
   * is refused for the turn, approvals bypassed or not.
   */
  async runOffloadTurn(req: OffloadTurnRequest): Promise<OffloadTurnOutcome> {
    const { bot, room } = req;
    const turnId = nanoid(10);
    const causeId = nanoid(10);
    const provider = this.providers.get('claude');
    const ac = new AbortController();
    const folder = this.roomFiles?.forBot(room, bot.id) ?? null;
    const folderDir = folder ? this.roomFiles!.ensure(folder) : null;
    const roomProject = folder?.kind === 'project' ? this.projects?.get(folder.projectSlug!) : undefined;
    const bypass = this.broker.bypassed;
    const setState = (st: BotState, note?: string) => this.hooks.setState(bot.id, room.id, st, note);
    const permCtx = {
      bot, room, turnId, hop: 0, causeId, setState: (st: 'blocked' | 'working') => setState(st),
      strictApprovals: false, ownerRef: undefined, park: () => undefined, controlBlocked: () => null,
    };
    const tools = createHubTools({
      bot, room, members: req.members, turnId, hop: 0, causeId,
      repos: this.repos, memory: this.memory, skills: this.skills, media: this.media, projects: this.projects,
      fileRoot: folder ? fileRootOf(room, folder) : null,
      fileAuthor: { kind: 'bot', id: bot.id, label: '@' + bot.handle, machine: 'vps', sessionId: turnId, roomId: room.id },
      revisions: this.revisions,
      dispatchFromBot: () => [],
      setState: (st) => setState(st),
      desktop: false,
      models: [],
      forms: this.forms,
      strictApprovals: false,
      confirmFleetChange: (a) => this.broker.askFleetChange(permCtx, a.tool, a.input, a.reason, ac.signal, { evenUnderBypass: a.evenUnderBypass, machine: a.machine }),
      confirmOutsideHandoff: (a) => this.broker.askOutsideHandoff(permCtx, a.input, a.reason, ac.signal),
      routinesChanged: this.hooks.routinesChanged,
      signal: ac.signal,
      keyRegistry: () => loadKeyRegistry(),
    });
    const mcpToken = this.turns.registerTurn(tools, computerToolGuard(() => null));
    addSecret(mcpToken);
    let reported: string | undefined;
    const texts: string[] = [];
    const sink: TurnSink = {
      onSession: (t) => { if (t) reported = t; },
      onDelta: () => undefined,
      onText: (t) => { texts.push(t); },
      onToolUse: () => undefined,
      onToolResult: () => undefined,
      onState: () => undefined,
    };
    const ctx: TurnContext = {
      turnId, bot, room, members: req.members,
      systemPrompt:
        "You are continuing the owner's Claude Code session on the VPS: the working folder is a git worktree of their repo on a wip branch. " +
        'Work as before. Do not run git push; your changes are committed to the wip branch when this turn ends.',
      input: req.prompt,
      resumeToken: req.sessionId,
      sessionCostUsd: null,
      workspaceDir: req.cwd,
      botHome: botHome(bot.id),
      tools,
      allowedBuiltins: bot.allowedTools,
      bypassPermissions: bypass,
      permission: async (name, input, extra) => {
        const r = await this.broker.decide(permCtx, name, input, { signal: ac.signal, blockedPath: extra?.blockedPath });
        return r.behavior === 'allow' ? 'allow' : 'deny';
      },
      permissionDetailed: (name, input, o) =>
        this.broker.decide(permCtx, name, input, { signal: (o.signal ?? ac.signal) as AbortSignal, suggestions: o.suggestions as never, blockedPath: o.blockedPath }),
      pluginDir: null,
      model: req.model,
      maxBudgetUsd: spendCapsOff() ? Infinity : bot.maxBudgetUsd,
      maxTurns: MAX_TURNS_PER_QUERY,
      signal: ac.signal,
      mcp: { url: this.turns.url(), token: mcpToken },
      projectDirs: folderDir ? [folderDir] : [],
      shipGuard: (command) => (pushesToRemote(command) ? OFFLOAD_PUSH_DENIED : null),
      projectGuard: this.projects || this.roomFiles
        ? (name, input, cwd) => folderAccessDenied(name, input, cwd, [
            ...(this.projects ? [{ root: this.projects.root, allowed: roomProject ? [roomProject.slug] : [], known: this.projects.knownSlugs() }] : []),
            ...(this.roomFiles ? [{ root: this.roomFiles.roomsDir, allowed: folder?.kind === 'room' ? [room.id] : [], known: this.repos.listRooms().map((r) => r.id) }] : []),
          ])
        : undefined,
      fileGuard: this.projects ? (name, input, cwd) => reposFileWriteDenied(name, input, cwd, this.projects!.root) : undefined,
    };
    this.activeTurns.add(turnId);
    this.aborts.set(turnId, ac);
    this.turnProviders.set(turnId, provider);
    setState('working', 'continuing a session on the VPS');
    let outcome: TurnOutcome | null = null;
    let error: string | undefined;
    try {
      outcome = await provider.runTurn(ctx, sink);
      error = outcome.error;
      const u = outcome.usage;
      if (u.costUsd || u.inputTokens || u.outputTokens) this.usage.record(bot.id, room.id, turnId, causeId, u, { model: req.model, routeReason: 'offload', causeKind: 'user', provider: 'claude' });
    } catch (e) {
      error = redact(String((e as Error).message ?? e));
    } finally {
      this.activeTurns.delete(turnId);
      this.aborts.delete(turnId);
      this.turnProviders.delete(turnId);
      this.turns.unregister(mcpToken);
      removeSecret(mcpToken);
      setState(error ? 'error' : 'done');
    }
    const ok = !!outcome?.ok && !error;
    return {
      ok, finalText: texts.join('\n\n'), costUsd: outcome?.costUsd ?? 0, ...(error ? { error: redact(error) } : {}),
      ...(reported && reported !== req.sessionId ? { sessionId: reported } : {}),
    };
  }

  /**
   * Before a rotation: folds the messages that will not be replayed into the room's running summary with one cheap,
   * tool-less Haiku call (the auto-memory pass options), and stores it on the session row. Returns the new summary, or
   * null when there was nothing older than the replayed window or the call failed (the old summary then stays).
   */
  private async writeSummary(bot: Bot, roomId: string, lastSeenSeq: number, previous: string | null): Promise<string | null> {
    // P1-6: a Haiku call on the Claude login, so not while Claude is missing, signed out or at its limit. The seed then
    // carries the previous summary and the recent messages.
    if (this.claudeReady && !this.claudeReady()) return null;
    const prompt = buildSummaryPrompt(this.repos, bot, roomId, lastSeenSeq, previous);
    if (!prompt) return null;
    try {
      const outcome = await this.summarize(prompt, SUMMARY_SYSTEM_PROMPT);
      const u = outcome.usage;
      // Not tied to the cause: like auto-memory, it must not count toward a thread's cost cap.
      if (u.costUsd || u.inputTokens || u.outputTokens) {
        this.usage.record(bot.id, roomId, 'sum-' + nanoid(8), null, u, { model: AUTO_MEMORY_MODEL, routeReason: 'session-summary', causeKind: 'memory', provider: 'claude' });
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
