import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  createSdkMcpServer, query, tool,
  type Options, type PermissionResult, type SDKMessage, type SDKUserMessage, type PreToolUseHookInput, type PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, ProviderCheck, ProviderStaticInfo } from '@pocketrocket/shared';
import { BASH_MAX_OUTPUT_CHARS, CLAUDE_EXE, DATA_DIR, MAX_MCP_OUTPUT_TOKENS, PLAYWRIGHT_MCP_CLI, VERSION } from '../config.js';
import { browserMcpRoots, sandboxCommand } from './sandbox.js';
import { isOutdatedCliError, updateClaudeCli } from './claudeUpdate.js';
import { childEnv } from './env.js';
import { SESSION_RETENTION_DAYS } from './cliRetention.js';
import { deleteGate } from '../permissions/deleteGate.js';
import { isInside, pathsFromInput } from '../permissions/pathRules.js';
import { READ_ONLY_GUARD_TOOLS, readOnlyWriteDecision, routingFileWrite } from '../permissions/readOnlyRoots.js';
import { secretFileAccess } from '../permissions/secretFiles.js';
import { denyMessage } from '../permissions/messages.js';
import { logError } from './redact.js';
import { outsideMcpNeedsCard } from '../services/outsideMcp.js';
import type { AgentProvider, HubTool, ProviderInit, SteerInput, SteerResult, TurnContext, TurnImage, TurnOutcome, TurnSink } from './types.js';

// Only these may be pre-approved via allowedTools. A bare allowedTools entry auto-approves the tool
// EVERYWHERE and bypasses canUseTool, so file/shell tools must never appear there: reads inside
// cwd/additionalDirectories are already free, edits inside are covered by acceptEdits, and anything
// outside (plus every Bash call) then falls through to the PermissionBroker.
const AUTO_OK = new Set(['WebSearch', 'WebFetch']);
// 'Task' is the subagent tool (the CLI now calls it 'Agent' and keeps 'Task' as an alias; both are passed). Off
// unless the bot has it: a subagent explores in its own context and hands back a short report, which keeps file
// dumps out of the bot's resumed session.
const ALL_BUILTINS = ['Read','Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit', 'Task'];
/** The CLI's own names for a bot-facing built-in. */
const sdkNames = (t: string) => (t === 'Task' ? ['Task', 'Agent'] : [t]);
/**
 * Playwright MCP tools a bot never gets. Each can read what a page holds outside the snapshot, including a
 * password fill_credential just typed: browser_evaluate runs page JavaScript, browser_run_code_unsafe runs
 * Playwright code in the server process, and browser_network_request returns request bodies (a sign-in POST).
 * disallowedTools wins over the `mcp__browser__*` entry in allowedTools, in bypass mode too.
 */
export const BLOCKED_BROWSER_TOOLS = ['browser_evaluate', 'browser_run_code_unsafe', 'browser_network_request'].map((t) => 'mcp__browser__' + t);
/** Anchored, so browser_network_request does not also catch browser_network_requests (a URL list only). */
export const BLOCKED_BROWSER_MATCHER = '^(?:' + BLOCKED_BROWSER_TOOLS.join('|') + ')$';
export const BLOCKED_BROWSER_REASON = 'This browser tool is turned off for bots: it can read what a page holds, including saved passwords. Use browser_snapshot to read the page.';

/**
 * The SDK's `maxBudgetUsd` flag for one run. The SDK checks it against the session's cumulative cost, which on a
 * resumed session includes every earlier turn, so the stored cumulative is added to make it a per-run cap. A resumed
 * session whose cumulative is unknown (from before the hub tracked it) gets no flag rather than one that trips at once;
 * the hub's own checks between runs still hold. undefined = no flag (no budget, or POCKETROCKET_NO_SPEND_CAPS).
 */
export function sdkBudgetUsd(maxBudgetUsd: number, resumed: boolean, sessionCostUsd: number | null | undefined): number | undefined {
  if (!Number.isFinite(maxBudgetUsd)) return undefined;
  if (!resumed) return maxBudgetUsd;
  if (sessionCostUsd == null) return undefined;
  return sessionCostUsd + maxBudgetUsd;
}

/**
 * This run's own cost out of the SDK's cumulative `total_cost_usd`. A cumulative below the baseline means the CLI
 * started a new session after all, so all of it is this run's. An unknown baseline on a resumed (legacy) session
 * counts as 0 rather than billing the session's whole history to one turn.
 */
export function runCostUsd(cumulative: number, resumed: boolean, sessionCostUsd: number | null | undefined): number {
  if (!resumed) return cumulative;
  if (sessionCostUsd == null) return 0;
  return cumulative >= sessionCostUsd ? cumulative - sessionCostUsd : cumulative;
}

/** Input tokens a model call was sent: uncached + cache read + cache write. */
export function callInputTokens(u: { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): number {
  return (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
}

/** The env the Claude Code child runs with: the allowlist plus the hub's own output caps (the allowlist is not widened). */
export function claudeChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return childEnv('claude', {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'pocketrocket/' + VERSION,
    // One huge command output or MCP result would otherwise sit in the resumed session and be re-read every step.
    BASH_MAX_OUTPUT_LENGTH: String(BASH_MAX_OUTPUT_CHARS),
    MAX_MCP_OUTPUT_TOKENS: String(MAX_MCP_OUTPUT_TOKENS),
  }, source);
}

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'balanced, default', default: true },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'hard problems' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'most capable, 2x Opus price' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'cheapest, fastest' },
];

export const CLAUDE_INFO: ProviderStaticInfo = {
  id: 'claude',
  label: 'Claude',
  blurb: 'Runs on your server with your Claude subscription.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['ANTHROPIC_API_KEY'],
  permissions: 'full',
  maturity: 'verified',
};

/** The turn error for a run the token brake stopped. Says "budget", so turnFailure files it as external. */
export function tokenBrakeError(read: number, cap: number): string {
  return 'token_budget: stopped after reading ' + read.toLocaleString('en-US') + ' cached tokens this turn (cap ' +
    cap.toLocaleString('en-US') + ") to save your plan's usage";
}

/** Wrap provider-agnostic hub tools as an in-process SDK MCP server named `pocketrocket`. */
function toolServer(tools: HubTool[]) {
  const wrapped = tools.map((t) =>
    tool(
      t.name,
      t.description,
      t.inputSchema.shape,
      // The SDK validates against the shape and hands back parsed args.
      async (args: unknown) => (await t.handler((args ?? {}) as Record<string, unknown>)) as never,
      t.readOnly ? { annotations: { readOnlyHint: true } } : undefined,
    ),
  );
  // alwaysLoad: keep these schemas in the prompt so bots don't spend a ToolSearch roundtrip every turn.
  return createSdkMcpServer({ name: 'pocketrocket', version: VERSION, alwaysLoad: true, tools: wrapped });
}

/**
 * How long `claude --version` gets. The native binary can take several seconds on a cold start or while
 * antivirus scans it; at the old 2s a perfectly good install was reported as missing.
 */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Install and sign-in instructions, Markdown. Anthropic's native installer puts the binary in ~/.local/bin,
 * which is where CLAUDE_EXE looks; `npm install -g` puts a claude.cmd shim in %APPDATA%\npm that the hub
 * would never find.
 */
const INSTALL_HINT =
  'Install Claude Code with Anthropic\'s installer (Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`; ' +
  'macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`) and sign in with `claude` (subscription), ' +
  'or set ANTHROPIC_API_KEY. Point CLAUDE_EXE at the binary if it lives elsewhere.';

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  /** Raw plan id: "max", "pro", "team", "enterprise". */
  subscriptionType?: string;
  authMethod?: string;
  orgName?: string;
}

/** Parses `claude auth status` output; undefined when it is not the JSON shape this expects. */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== 'boolean') return undefined;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      loggedIn: parsed.loggedIn,
      email: str(parsed.email),
      subscriptionType: str(parsed.subscriptionType),
      authMethod: str(parsed.authMethod),
      orgName: str(parsed.orgName),
    };
  } catch {
    return undefined;
  }
}

/** "max" -> "Max". Known plans get their product spelling; anything newer is just capitalized. */
export function planLabel(subscriptionType: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  const known: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return known[subscriptionType.toLowerCase()] ?? subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/** `claude auth status` as JSON, or undefined when the CLI is too old, times out, or prints something else. */
function authStatus(): Promise<ClaudeAuthStatus | undefined> {
  return new Promise((resolve) => {
    const child = execFile(CLAUDE_EXE, ['auth', 'status'], { timeout: 5000, windowsHide: true }, (_err, stdout) => {
      // A signed-out CLI may exit non-zero and still print the JSON, so the error alone decides nothing.
      resolve(parseAuthStatus(String(stdout)));
    });
    child.on('error', () => resolve(undefined));
  });
}

/**
 * The user turn's content. With pictures it is the text followed by one base64 image block each (the input text already
 * names their paths, see agent/attachments.ts); without, the plain string, byte-for-byte as before.
 */
export function userContent(input: string, images: readonly TurnImage[]) {
  // A picture without `data` was too big to inline (see materializeImages); the input text still names its path.
  const inline = images.filter((i) => i.data);
  if (!inline.length) return input;
  return [
    { type: 'text' as const, text: input },
    ...inline.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data!.toString('base64') } })),
  ];
}

/**
 * The init capability steering relies on: `interrupt()` answers with a receipt naming the uuid-stamped messages that
 * would still run, so Stop can stop them too. Without it a steer queues instead (spike 1.0: CLI 2.1.326 has it).
 */
export const STEER_CAPABILITY = 'interrupt_receipt_v1';
/**
 * After Stop with a steer still queued in the CLI: how long to wait for the interrupted turn's result (it carries the
 * run's cost) before closing anyway. The CLI starts the queued steer about a second after that result (spike 1.0),
 * and the query is closed as soon as that result is read, so the steer never gets to run.
 */
export const STOP_RESULT_WAIT_MS = 5_000;

/** A run's input: the opening message, then whatever `push` adds, until `close`. */
export function inputChannel() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
  }
  return {
    messages: messages(),
    push(m: SDKUserMessage) {
      if (closed) return false;
      queue.push(m);
      wake?.();
      return true;
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

type SdkUuid = NonNullable<SDKUserMessage['uuid']>;
const userMessage = (text: string, images: readonly TurnImage[], uuid: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content: userContent(text, images) }, parent_tool_use_id: null, uuid: uuid as SdkUuid });

/** One turn as `steer` and `interrupt` see it, across the outdated-CLI replay. */
interface LiveTurn {
  /** Every steer this turn was given, by uuid (live pushes and `carriedSteers`). */
  known: Map<string, SteerInput>;
  /** Uuids a result or reply named: in the session's transcript. */
  consumed: Set<string>;
  /** Set while a run reads: pushes a live steer. */
  push?: (s: SteerInput) => void;
  /** Stops the current run (interrupt, receipt, close). */
  stop?: () => void;
  /** This run's init came in, and whether it advertised `STEER_CAPABILITY`. */
  initSeen: boolean;
  steerable: boolean;
  /** The current run decided to end: no more pushes. */
  ending: boolean;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  readonly info = CLAUDE_INFO;
  private live = new Map<string, LiveTurn>();
  /** Last `system/init` message seen; feeds check() and GET /api/health. */
  lastInit: ProviderInit = {};

  async models(): Promise<ModelInfo[]> {
    return MODELS;
  }
  modelsSync(): ModelInfo[] {
    return MODELS;
  }

  async check(): Promise<ProviderCheck> {
    const hint = INSTALL_HINT;
    const exePath = CLAUDE_EXE;
    if (!fs.existsSync(CLAUDE_EXE)) {
      return { ok: false, auth: 'none', exePath, error: 'claude executable not found at ' + CLAUDE_EXE, hint };
    }
    const answer = await new Promise<{ version?: string; timedOut: boolean }>((resolve) => {
      const child = execFile(CLAUDE_EXE, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) resolve({ timedOut: !!(err as { killed?: boolean }).killed });
        else resolve({ version: String(stdout).trim().split('\n')[0] || undefined, timedOut: false });
      });
      child.on('error', () => resolve({ timedOut: false }));
    });
    const { version } = answer;
    if (!version) {
      // The file is there, so this is not an install problem: say it did not respond and let the user retry.
      const error = answer.timedOut
        ? 'claude --version did not answer within ' + VERSION_TIMEOUT_MS / 1000 + 's'
        : 'claude --version failed to run';
      return { ok: false, auth: 'unknown', exePath, unresponsive: true, error, hint };
    }
    if (process.env.ANTHROPIC_API_KEY) return { ok: true, version, auth: 'apiKey', exePath, hint };
    // `claude auth status` prints JSON ({ loggedIn, email, subscriptionType, ... }); without it a CLI that was
    // installed but never signed in looked ready and every turn then failed.
    const status = await authStatus();
    if (status?.loggedIn === false) {
      return { ok: false, version, auth: 'none', exePath, error: 'Claude Code is installed but not signed in.', hint };
    }
    // Older CLIs have no `auth status`: fall back to the init message, where an OAuth login reports
    // apiKeySource 'none' (the expected value for a subscription, not an error).
    const auth = status?.loggedIn || this.lastInit.apiKeySource === undefined || this.lastInit.apiKeySource === 'none'
      ? 'subscription'
      : 'unknown';
    return {
      ok: true, version, auth, exePath, hint,
      account: status?.email,
      plan: planLabel(status?.subscriptionType),
      authMethod: status?.authMethod,
      orgName: status?.orgName,
    };
  }

  interrupt(turnId: string): boolean {
    const live = this.live.get(turnId);
    if (!live?.stop) return false;
    live.stop();
    return true;
  }

  /** Steering needs the interrupt receipt. Known from the last init, so false until the first turn. */
  canSteer(): boolean {
    return !!this.lastInit.capabilities?.includes(STEER_CAPABILITY);
  }

  steer(turnId: string, input: SteerInput): SteerResult {
    const live = this.live.get(turnId);
    // No run reading yet (start-up, the replay's CLI update) or already ending: the caller queues it.
    if (!live?.push || live.ending || !live.initSeen) return { status: 'queued', reason: 'between-runs' };
    if (!live.steerable) return { status: 'queued', reason: 'provider' };
    live.known.set(input.uuid, input);
    live.push(input);
    return { status: 'accepted' };
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const live: LiveTurn = { known: new Map(), consumed: new Set(), initSeen: false, steerable: false, ending: false };
    for (const s of ctx.carriedSteers ?? []) live.known.set(s.uuid, s);
    this.live.set(ctx.turnId, live);
    const done = (outcome: TurnOutcome): TurnOutcome => {
      if (!live.known.size) return outcome;
      const uuids = [...live.known.keys()];
      return { ...outcome, steers: { consumed: uuids.filter((u) => live.consumed.has(u)), pending: uuids.filter((u) => !live.consumed.has(u)) } };
    };
    try {
      const first = await this.runOnce(ctx, sink, live, ctx.carriedSteers ?? []);
      // A model newer than the installed CLI fails on the first request, before any tool runs. Update the CLI
      // and replay the turn once instead of sending the user to a terminal. Only replayed when no tool was
      // called, so nothing runs twice.
      if (!first.outdatedCli || first.usedTools || ctx.signal.aborted) return done(first.outcome);
      sink.onState('working');
      const update = await updateClaudeCli();
      if (!update.ok) {
        const detail = update.output.split('\n').filter((l) => l.trim()).pop();
        return done({
          ...first.outcome,
          error: first.outcome.error + ' Automatic `claude update` failed' + (detail ? ' (' + detail + ')' : '') +
            '. Run `claude update` in a terminal, then try again.',
        });
      }
      if (ctx.signal.aborted) return done(first.outcome);
      sink.onState('thinking');
      // The failed run never reached the model, so every steer this turn was given goes into the replay's opening
      // message, whatever the failed run's result named.
      const carry = [...live.known.values()];
      for (const s of carry) live.consumed.delete(s.uuid);
      return done((await this.runOnce(ctx, sink, live, carry)).outcome);
    } finally {
      live.ending = true;
      this.live.delete(ctx.turnId);
    }
  }

  private async runOnce(
    ctx: TurnContext, sink: TurnSink, live: LiveTurn, carry: SteerInput[],
  ): Promise<{ outcome: TurnOutcome; outdatedCli: boolean; usedTools: boolean }> {
    const started = Date.now();
    const bot = ctx.bot;
    const pluginDir = ctx.pluginDir ?? null;
    const resumed = !!ctx.resumeToken;

    const allowed = ctx.allowedBuiltins.filter((t) => AUTO_OK.has(t));
    const disallowed = ALL_BUILTINS.filter((t) => !ctx.allowedBuiltins.includes(t)).flatMap(sdkNames);
    // "Browser" = Playwright MCP attached over CDP to the Chromium on the bot's own computer (its logged-in
    // profile). With no computer there is no endpoint, and it never falls back to a shared screen.
    const browserOn = ctx.allowedBuiltins.includes('Browser') && !!ctx.cdpUrl && fs.existsSync(PLAYWRIGHT_MCP_CLI);
    const mcpServers: NonNullable<Options['mcpServers']> = { pocketrocket: toolServer(ctx.tools) };
    if (browserOn) {
      mcpServers.browser = {
        type: 'stdio', command: process.execPath,
        // Snapshots hold what fields on the page contain, so they stay in the bot's own home (removed with the
        // bot, left out of backups) instead of the workspace every bot shares.
        args: [
          PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', ctx.cdpUrl!, '--caps', 'vision',
          '--output-dir', path.join(ctx.botHome, 'playwright-output'), '--output-max-size', String(64 * 1024 * 1024),
        ],
      };
    }

    // Owner-configured outside servers (data/mcp-servers.json). Left out of allowedTools on purpose, so
    // outside bypass mode each call reaches canUseTool and the approval broker. The ones whose `approve` asks
    // for a card get it from outsideGuard below, in every mode.
    for (const s of ctx.outsideMcp ?? []) {
      mcpServers[s.name] = s.kind === 'stdio'
        ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
        : { type: 'http', url: s.url, ...(s.token ? { headers: { Authorization: 'Bearer ' + s.token } } : {}) };
    }

    // The opening message carries steers an earlier run never consumed, so they are consumed with it. Its uuid is how
    // results say they answered it; live steers are pushed after it, each under its own uuid.
    const channel = inputChannel();
    const openerUuid = randomUUID();
    const openerText = [ctx.input, ...carry.map((s) => s.text)].join('\n\n');
    channel.push(userMessage(openerText, [...(ctx.images ?? []), ...carry.flatMap((s) => s.images ?? [])], openerUuid));
    /** Live steers pushed into this run; the run reads on until a result names each of them. */
    const runSteers = new Set<string>();
    const consume = (uuids: readonly string[] | undefined) => {
      for (const u of uuids ?? []) {
        if (u === openerUuid) for (const s of carry) live.consumed.add(s.uuid);
        else if (live.known.has(u)) live.consumed.add(u);
      }
    };
    const outstanding = () => [...runSteers].filter((u) => !live.consumed.has(u));
    live.initSeen = false;
    live.steerable = false;
    live.ending = false;

    const decide = async (
      name: string,
      toolInput: Record<string, unknown>,
      o: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string },
    ): Promise<PermissionResult> => {
      if (ctx.permissionDetailed) return (await ctx.permissionDetailed(name, toolInput, o)) as PermissionResult;
      const d = await ctx.permission(name, toolInput, { blockedPath: o.blockedPath });
      return d === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage('declined', { alt: 'choose another approach or say so in the room' }) };
    };

    // P7: writes into the read-only knowledge repo ask (or, under bypass, are denied) before acceptEdits sees them.
    const knowledgeDir = ctx.knowledgeDir ?? null;
    const readOnlyDirs = [...(knowledgeDir ? [knowledgeDir] : []), ...(ctx.readOnlyDirs ?? [])];
    const knowledgeGuard = readOnlyDirs.length
      ? [{
          matcher: READ_ONLY_GUARD_TOOLS.join('|'),
          hooks: [
            async (hookInput: unknown) => {
              const i = hookInput as PreToolUseHookInput;
              const d = readOnlyWriteDecision(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, readOnlyDirs, ctx.workspaceDir, !!ctx.bypassPermissions);
              if (!d) return {};
              return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: d.decision, permissionDecisionReason: d.reason } };
            },
          ],
        }]
      : [];

    // P2: the control interlock. While the user has control of this bot's computer (or it is paused) Browser and
    // desktop calls are denied. It runs in bypass mode too: `mcp__browser__*` is pre-approved in allowedTools,
    // so canUseTool never sees it, and bypass skips canUseTool entirely; a PreToolUse deny holds in both.
    const controlGuard = ctx.controlGuard
      ? [{
          matcher: 'mcp__browser__.*|mcp__pocketrocket__desktop_.*',
          hooks: [
            async (hookInput: unknown) => {
              const i = hookInput as PreToolUseHookInput;
              const why = ctx.controlGuard!() ?? (await ctx.computerGate?.(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>)) ?? null;
              if (!why) return {};
              return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
            },
          ],
        }]
      : [];

    // Outside servers with `approve` set: the owner's card on each call that needs one, under bypass too (bypass
    // skips canUseTool, never a hook). An allowed card answers 'allow', so canUseTool does not ask a second time.
    const gatedOutside = (ctx.outsideMcp ?? []).filter((s) => s.approve !== 'none');
    const outsideGuard = gatedOutside.length
      ? [{
          // Server names are [a-z0-9_-] with no `__` (outsideMcp.ts), so they need no escaping here.
          matcher: 'mcp__(' + gatedOutside.map((s) => s.name).join('|') + ')__.*',
          hooks: [
            async (hookInput: unknown) => {
              const i = hookInput as PreToolUseHookInput;
              const s = gatedOutside.find((g) => i.tool_name.startsWith('mcp__' + g.name + '__'));
              if (!s || !outsideMcpNeedsCard(s, i.tool_name.slice(('mcp__' + s.name + '__').length))) return {};
              const why = ctx.outsideMcpGate
                ? await ctx.outsideMcpGate(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>)
                : 'This outside tool needs the owner\'s approval, and none can be asked for here.';
              return {
                hookSpecificOutput: why
                  ? { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why }
                  : { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'Approved by the owner.' },
              };
            },
          ],
        }]
      : [];

    // No bot writes the owner's routing rules, or touches the hub's key files. Bypass skips canUseTool, and
    // these hold in every mode.
    const guards = [
      {
        // The write tools and Bash for routing.md, plus the read tools for the key files.
        matcher: [...new Set([...READ_ONLY_GUARD_TOOLS, 'Read', 'Glob', 'Grep'])].join('|'),
        hooks: [
          async (hookInput: unknown) => {
            const i = hookInput as PreToolUseHookInput;
            const input = (i.tool_input ?? {}) as Record<string, unknown>;
            const cwd = i.cwd || ctx.workspaceDir;
            const why = routingFileWrite(i.tool_name, input, cwd) ?? secretFileAccess(i.tool_name, input, cwd);
            if (!why) return {};
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
          },
        ],
      },
      // Second line behind disallowedTools for BLOCKED_BROWSER_TOOLS: a hook deny holds in bypass mode too.
      ...(browserOn
        ? [{
            matcher: BLOCKED_BROWSER_MATCHER,
            hooks: [
              async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: BLOCKED_BROWSER_REASON } }),
            ],
          }]
        : []),
      ...outsideGuard,
      ...controlGuard,
      ...knowledgeGuard,
      ...(ctx.shipGuard
        ? [{
            matcher: 'Bash',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.shipGuard!(String((i.tool_input as { command?: unknown } | undefined)?.command ?? ''), i.cwd || ctx.workspaceDir);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
      ...(ctx.fileGuard
        ? [{
            matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.fileGuard!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, i.cwd || ctx.workspaceDir);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
      ...(ctx.projectGuard
        ? [{
            matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Bash',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PreToolUseHookInput;
                const why = ctx.projectGuard!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, i.cwd || ctx.workspaceDir);
                if (!why) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
              },
            ],
          }]
        : []),
    ];

    // Bridge P1: after a file tool wrote, the hub records who changed the file (FileRevisions). It never blocks.
    const afterWrite = ctx.fileWritten
      ? {
          PostToolUse: [{
            matcher: 'Write|Edit|MultiEdit|NotebookEdit',
            hooks: [
              async (hookInput: unknown) => {
                const i = hookInput as PostToolUseHookInput;
                try {
                  ctx.fileWritten!(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, i.cwd || ctx.workspaceDir);
                } catch (e) {
                  logError('[file revisions]', e);
                }
                return {};
              },
            ],
          }],
        }
      : {};

    const options: Options = {
      pathToClaudeCodeExecutable: CLAUDE_EXE,
      // Bridge P7: with settings.sandbox on, the CLI (and the Bash, file tools and Browser MCP it runs) starts inside bubblewrap.
      // Off: spawned as before. On but unusable: this throws and the turn fails closed.
      spawnClaudeCodeProcess: (o) => {
        const sb = sandboxCommand(o, {
          cwd: o.cwd ?? ctx.workspaceDir,
          botHome: ctx.botHome,
          writable: [...(ctx.projectDirs ?? []), ...(ctx.computerFilesDir ? [ctx.computerFilesDir] : []), ...(ctx.sandboxWritableDirs ?? [])],
          readOnly: [...readOnlyDirs, ...(browserOn ? browserMcpRoots(PLAYWRIGHT_MCP_CLI) : [])],
          resumeToken: ctx.resumeToken,
        }, { dataDir: DATA_DIR });
        return spawn(sb?.command ?? o.command, sb?.args ?? o.args, { cwd: sb ? undefined : o.cwd, env: sb?.env ?? o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as never;
      },
      cwd: ctx.workspaceDir,
      // P1: the bot's own computer disk is a working root. P7: the knowledge repo is readable like the bot's
      // home; writes there are stopped by the hook below.
      additionalDirectories: [
        ctx.botHome,
        ...(ctx.computerFilesDir ? [ctx.computerFilesDir] : []),
        ...readOnlyDirs,
        ...(ctx.projectDirs ?? []),
      ],
      resume: ctx.resumeToken ?? undefined,
      model: ctx.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.systemPrompt },
      settingSources: [],
      // Flag settings load even with settingSources: [] (user settings do not), so this is what stops the CLI's
      // 30-day sweep from deleting the session files bots resume from.
      // bashOutputMaxChars is what caps Bash output inline on current CLIs (BASH_MAX_OUTPUT_LENGTH in env covers older ones).
      settings: { cleanupPeriodDays: SESSION_RETENTION_DAYS, bashOutputMaxChars: BASH_MAX_OUTPUT_CHARS },
      plugins: pluginDir ? [{ type: 'local', path: pluginDir }] : undefined,
      skills: pluginDir ? 'all' : [],
      // Approvals bypassed: the SDK skips canUseTool entirely (and the out-of-workspace hook below is left
      // out, since an "ask" there would only route into a broker that allows everything).
      ...(ctx.bypassPermissions
        ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }
        : { permissionMode: 'acceptEdits' as const }),
      // Availability: only the bot's built-ins (+ Skill when a plugin is attached) exist in context.
      // Keeps Task/cron/plan-mode etc. out of the prompt and trims the cached system prompt.
      tools: [...ctx.allowedBuiltins.filter((t) => ALL_BUILTINS.includes(t)).flatMap(sdkNames), ...(pluginDir ? ['Skill'] : [])],
      allowedTools: [...allowed, 'mcp__pocketrocket__*', ...(browserOn ? ['mcp__browser__*'] : [])],
      disallowedTools: [...disallowed, ...(browserOn ? BLOCKED_BROWSER_TOOLS : [])],
      mcpServers,
      strictMcpConfig: true,
      canUseTool: (name, toolInput, o) => decide(name, toolInput, o),
      // Read/Glob/Grep never prompt in Claude Code, so canUseTool would never see them. This hook
      // escalates out-of-workspace paths to "ask", which routes them into canUseTool -> PermissionBroker.
      hooks: ctx.bypassPermissions ? { PreToolUse: guards, ...afterWrite } : {
        ...afterWrite,
        PreToolUse: [
          ...guards,
          // acceptEdits approves rm and mv inside the roots before canUseTool, so this is what raises their card.
          {
            matcher: 'Bash',
            hooks: [
              async (hookInput) => {
                const i = hookInput as PreToolUseHookInput;
                const hit = deleteGate(String((i.tool_input as { command?: unknown } | undefined)?.command ?? ''), i.cwd || ctx.workspaceDir);
                if (!hit) return {};
                return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: hit.reason } };
              },
            ],
          },
          {
            matcher: 'Read|Glob|Grep|NotebookEdit',
            hooks: [
              async (hookInput) => {
                const i = hookInput as PreToolUseHookInput;
                // NotebookEdit writes, so only the read tools see the read-only knowledge root (P7). The bot's
                // own computer disk (P1) is writable like its home.
                const roots = [
                  ctx.workspaceDir,
                  ctx.botHome,
                  ...(ctx.computerFilesDir ? [ctx.computerFilesDir] : []),
                  ...(ctx.projectDirs ?? []),
                  ...(i.tool_name !== 'NotebookEdit' ? readOnlyDirs : []),
                ];
                const paths = pathsFromInput(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>);
                const outside = paths.filter((p) => !isInside(p, roots, ctx.workspaceDir));
                if (process.env.POCKETROCKET_DEBUG) console.log('[hook PreToolUse]', i.tool_name, paths, outside.length ? 'ASK' : 'ok');
                if (!outside.length) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: i.tool_name + ' outside workspace: ' + outside.join(', '),
                  },
                };
              },
            ],
          },
        ],
      },
      includePartialMessages: true,
      maxTurns: ctx.maxTurns,
      // No budget (POCKETROCKET_NO_SPEND_CAPS) is Infinity here, which the CLI flag cannot carry: leave it out.
      // The SDK compares the flag with the session's cumulative cost, so it is offset by what is already spent.
      maxBudgetUsd: sdkBudgetUsd(ctx.maxBudgetUsd, resumed, ctx.sessionCostUsd),
      // Allowlisted env only (audit 2026-09-09, B7): the child never sees POCKETROCKET_TOKEN or another
      // provider's API key, so `env`/`node -e "process.env"` inside a prompt injection yields nothing useful.
      env: claudeChildEnv(),
      stderr: (d) => { if (process.env.POCKETROCKET_DEBUG) process.stderr.write('[claude ' + bot.handle + '] ' + d); },
    };

    let ok = false;
    let error: string | undefined;
    let costUsd = 0;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let modelUsage: unknown;
    let durationMs = 0;
    let outdatedCli: string | undefined;
    let usedTools = false;
    let gotResult = false;
    let sessionCostUsd: number | undefined;
    // Per top-level model call (the SDK repeats one call's usage on each of its content blocks, so keyed by id):
    // the running cache-read sum feeds the token brake, the last call's input size is the context size.
    const calls = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number }>();
    let contextTokens: number | undefined;
    let braked = false;
    const runningCacheRead = () => [...calls.values()].reduce((n, c) => n + c.cacheRead, 0);

    const q = query({ prompt: channel.messages, options });
    let stopping = false;
    let closed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeQuery = () => {
      if (closed) return;
      closed = true;
      live.ending = true;
      channel.close();
      q.close();
    };
    // Stop and the token brake: interrupt, read the receipt, then close. A uuid-stamped steer still queued in the CLI
    // "WILL run" after a plain interrupt (sdk.d.ts, SDKControlInterruptResponse), so the query is closed before it
    // can. The interrupted result is waited for (briefly) only because it carries the run's cost.
    const stop = () => {
      if (stopping) return;
      stopping = true;
      live.ending = true;
      void (async () => {
        let receipt: { still_queued?: string[] } | undefined;
        try {
          receipt = await q.interrupt();
        } catch {
          /* the query already ended */
        }
        const stillQueued = (receipt?.still_queued ?? []).filter((u) => live.known.has(u));
        for (const u of stillQueued) live.consumed.delete(u);
        if (!closed && (stillQueued.length || outstanding().length)) closeTimer = setTimeout(closeQuery, STOP_RESULT_WAIT_MS);
      })();
    };
    live.stop = stop;
    live.push = (s) => {
      runSteers.add(s.uuid);
      channel.push(userMessage(s.text, s.images ?? [], s.uuid));
    };
    const onAbort = () => stop();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'system' && m.subtype === 'init') {
          const capabilities = (m as { capabilities?: string[] }).capabilities;
          this.lastInit = { apiKeySource: m.apiKeySource, model: m.model, version: m.claude_code_version, tools: m.tools, skills: m.skills, capabilities };
          live.initSeen = true;
          live.steerable = !!capabilities?.includes(STEER_CAPABILITY);
          sink.onInit?.(this.lastInit);
          if (m.session_id) sink.onSession(m.session_id);
          continue;
        }
        if (m.type === 'stream_event') {
          if (m.parent_tool_use_id) continue;
          consume(m.user_message_uuids);
          const ev = m.event as { type: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) sink.onDelta(ev.delta.text);
          continue;
        }
        if (m.type === 'assistant') {
          if (m.parent_tool_use_id) continue;
          consume(m.user_message_uuids);
          const mu = m.message.usage as (Parameters<typeof callInputTokens>[0] & { output_tokens?: number | null }) | undefined;
          if (mu) {
            calls.set(m.message.id ?? 'call-' + calls.size, {
              input: mu.input_tokens ?? 0, cacheRead: mu.cache_read_input_tokens ?? 0,
              cacheWrite: mu.cache_creation_input_tokens ?? 0, output: mu.output_tokens ?? 0,
            });
            contextTokens = callInputTokens(mu);
            if (!braked && ctx.cacheReadBudget !== undefined && runningCacheRead() > ctx.cacheReadBudget) {
              braked = true;
              stop();
            }
          }
          for (const block of m.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              // Held back rather than shown: runTurn updates the CLI and replays, or reports it as the turn error.
              if (isOutdatedCliError(block.text)) outdatedCli = block.text.trim();
              else sink.onText(block.text);
            } else if (block.type === 'tool_use') {
              usedTools = true;
              sink.onToolUse(block.id, block.name, block.input);
              sink.onState('working');
            }
          }
          continue;
        }
        if (m.type === 'user') {
          if (m.parent_tool_use_id) continue;
          const content = m.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const output = typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
            sink.onToolResult(block.tool_use_id, output, !!block.is_error);
          }
          sink.onState('thinking');
          continue;
        }
        if (m.type === 'result') {
          gotResult = true;
          // The run's first result is always the opening message's turn, whatever the CLI lists.
          consume([openerUuid]);
          const listed = (m as { user_message_uuids?: string[] }).user_message_uuids;
          consume(listed);
          // total_cost_usd is the session's running total across resumes (and this run's results), not this run's.
          sessionCostUsd = m.total_cost_usd ?? 0;
          costUsd = runCostUsd(sessionCostUsd, resumed, ctx.sessionCostUsd);
          // ok/error come from the last result. Tokens and time are per result, so a steer the CLI answered in a
          // turn of its own adds to them.
          ok = m.subtype === 'success';
          error = ok ? undefined : m.subtype + ((m as { errors?: string[] }).errors?.length ? ': ' + (m as { errors?: string[] }).errors!.join('; ') : '');
          const resultText = (m as { result?: string }).result;
          if (!outdatedCli && isOutdatedCliError(resultText)) outdatedCli = resultText!.trim();
          if (!outdatedCli && error && isOutdatedCliError(error)) outdatedCli = error;
          const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          usage = {
            inputTokens: usage.inputTokens + (u?.input_tokens ?? 0),
            outputTokens: usage.outputTokens + (u?.output_tokens ?? 0),
            cacheReadTokens: usage.cacheReadTokens + (u?.cache_read_input_tokens ?? 0),
            cacheWriteTokens: usage.cacheWriteTokens + (u?.cache_creation_input_tokens ?? 0),
          };
          modelUsage = (m as { modelUsage?: unknown }).modelUsage;
          durationMs += m.duration_ms ?? 0;
          // Read on only while a pushed steer is still unanswered and the CLI says which messages it answered. Stop,
          // an error result (max turns, budget) or a CLI that lists nothing ends the run here: the steers no result
          // named return as pending, and the query is closed below so the CLI does not run them on its own.
          if (stopping || !ok || !listed || outdatedCli || !outstanding().length) {
            live.ending = true;
            break;
          }
          continue;
        }
      }
    } catch (e) {
      // Closing the query (Stop) can end the read with an error; that is not the turn's.
      if (!closed) {
        error = error ?? String((e as Error).message ?? e);
        if (!outdatedCli && isOutdatedCliError(error)) outdatedCli = error;
      }
    } finally {
      live.ending = true;
      live.push = undefined;
      live.stop = undefined;
      if (closeTimer) clearTimeout(closeTimer);
      ctx.signal.removeEventListener('abort', onAbort);
      // A steer the CLI holds that no result named would otherwise run as a turn of its own.
      if (stopping || outstanding().length) closeQuery();
      else channel.close();
    }
    // The CLI reports this API error as a "successful" result, so the turn is marked failed here.
    if (outdatedCli) {
      ok = false;
      error = outdatedCli;
    }
    // Interrupted before a result: what the model calls themselves reported is all there is to count.
    if (!gotResult && calls.size) {
      const sum = (k: 'input' | 'cacheRead' | 'cacheWrite' | 'output') => [...calls.values()].reduce((n, c) => n + c[k], 0);
      usage = { inputTokens: sum('input'), outputTokens: sum('output'), cacheReadTokens: sum('cacheRead'), cacheWriteTokens: sum('cacheWrite') };
    }
    if (braked) {
      ok = false;
      error = tokenBrakeError(runningCacheRead(), ctx.cacheReadBudget!);
    }

    const outcome: TurnOutcome = {
      ok, error, costUsd,
      usage: { costUsd, ...usage, modelUsage, durationMs: durationMs || Date.now() - started },
      durationMs: durationMs || Date.now() - started,
      sessionCostUsd, contextTokens, braked: braked || undefined,
    };
    return { outcome, outdatedCli: !!outdatedCli, usedTools };
  }
}
