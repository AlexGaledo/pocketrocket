import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import {
  createSdkMcpServer, query, tool,
  type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { CDP_URL, CLAUDE_EXE, PLAYWRIGHT_MCP_CLI, VERSION } from '../config.js';
import { isOutdatedCliError, updateClaudeCli } from './claudeUpdate.js';
import { childEnv } from './env.js';
import { isInside, pathsFromInput } from '../permissions/pathRules.js';
import type { AgentProvider, HubTool, ProviderInit, TurnContext, TurnOutcome, TurnSink } from './types.js';

// Only these may be pre-approved via allowedTools. A bare allowedTools entry auto-approves the tool
// EVERYWHERE and bypasses canUseTool, so file/shell tools must never appear there: reads inside
// cwd/additionalDirectories are already free, edits inside are covered by acceptEdits, and anything
// outside (plus every Bash call) then falls through to the PermissionBroker.
const AUTO_OK = new Set(['WebSearch', 'WebFetch']);
const ALL_BUILTINS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit'];

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'balanced, default', default: true },
  { id: 'claude-opus-5', label: 'Opus 5', note: 'strong, pricey' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: 'most capable, 2x Opus price' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'cheapest, fastest' },
];

export const CLAUDE_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'claude',
  label: 'Claude',
  blurb: 'Claude Agent SDK driving your local Claude Code CLI. Uses your Claude subscription login.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['ANTHROPIC_API_KEY'],
  permissions: 'full',
  maturity: 'verified',
};

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

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  readonly info = CLAUDE_INFO;
  private active = new Map<string, Query>();
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
    const q = this.active.get(turnId);
    if (!q) return false;
    void q.interrupt().catch(() => undefined);
    return true;
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const first = await this.runOnce(ctx, sink);
    // A model newer than the installed CLI fails on the first request, before any tool runs. Update the CLI
    // and replay the turn once instead of sending the user to a terminal. Only replayed when no tool was
    // called, so nothing runs twice.
    if (!first.outdatedCli || first.usedTools || ctx.signal.aborted) return first.outcome;
    sink.onState('working');
    const update = await updateClaudeCli();
    if (!update.ok) {
      const detail = update.output.split('\n').filter((l) => l.trim()).pop();
      return {
        ...first.outcome,
        error: first.outcome.error + ' Automatic `claude update` failed' + (detail ? ' (' + detail + ')' : '') +
          '. Run `claude update` in a terminal, then try again.',
      };
    }
    if (ctx.signal.aborted) return first.outcome;
    sink.onState('thinking');
    return (await this.runOnce(ctx, sink)).outcome;
  }

  private async runOnce(ctx: TurnContext, sink: TurnSink): Promise<{ outcome: TurnOutcome; outdatedCli: boolean; usedTools: boolean }> {
    const started = Date.now();
    const bot = ctx.bot;
    const pluginDir = ctx.pluginDir ?? null;

    const allowed = ctx.allowedBuiltins.filter((t) => AUTO_OK.has(t));
    const disallowed = ALL_BUILTINS.filter((t) => !ctx.allowedBuiltins.includes(t));
    // "Browser" = Playwright MCP attached over CDP to the Chromium on the screen (shared, logged-in profile).
    const browserOn = ctx.allowedBuiltins.includes('Browser') && fs.existsSync(PLAYWRIGHT_MCP_CLI);
    const mcpServers: NonNullable<Options['mcpServers']> = { pocketrocket: toolServer(ctx.tools) };
    if (browserOn) {
      mcpServers.browser = {
        type: 'stdio', command: process.execPath,
        args: [PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', CDP_URL, '--caps', 'vision'],
      };
    }

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => (resolveDone = r));
    const input = ctx.input;
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: input }, parent_tool_use_id: null };
      await done;
    }

    const decide = async (
      name: string,
      toolInput: Record<string, unknown>,
      o: { signal: AbortSignal; suggestions?: unknown; blockedPath?: string },
    ): Promise<PermissionResult> => {
      if (ctx.permissionDetailed) return (await ctx.permissionDetailed(name, toolInput, o)) as PermissionResult;
      const d = await ctx.permission(name, toolInput, { blockedPath: o.blockedPath });
      return d === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user declined this action.' };
    };

    const options: Options = {
      pathToClaudeCodeExecutable: CLAUDE_EXE,
      spawnClaudeCodeProcess: (o) => spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as never,
      cwd: ctx.workspaceDir,
      additionalDirectories: [ctx.botHome],
      resume: ctx.resumeToken ?? undefined,
      model: ctx.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.systemPrompt },
      settingSources: [],
      plugins: pluginDir ? [{ type: 'local', path: pluginDir }] : undefined,
      skills: pluginDir ? 'all' : [],
      // Approvals bypassed: the SDK skips canUseTool entirely (and the out-of-workspace hook below is left
      // out, since an "ask" there would only route into a broker that allows everything).
      ...(ctx.bypassPermissions
        ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }
        : { permissionMode: 'acceptEdits' as const }),
      // Availability: only the bot's built-ins (+ Skill when a plugin is attached) exist in context.
      // Keeps Task/cron/plan-mode etc. out of the prompt and trims the cached system prompt.
      tools: [...ctx.allowedBuiltins.filter((t) => ALL_BUILTINS.includes(t)), ...(pluginDir ? ['Skill'] : [])],
      allowedTools: [...allowed, 'mcp__pocketrocket__*', ...(browserOn ? ['mcp__browser__*'] : [])],
      disallowedTools: disallowed,
      mcpServers,
      strictMcpConfig: true,
      canUseTool: (name, toolInput, o) => decide(name, toolInput, o),
      // Read/Glob/Grep never prompt in Claude Code, so canUseTool would never see them. This hook
      // escalates out-of-workspace paths to "ask", which routes them into canUseTool -> PermissionBroker.
      hooks: ctx.bypassPermissions ? undefined : {
        PreToolUse: [
          {
            matcher: 'Read|Glob|Grep|NotebookEdit',
            hooks: [
              async (hookInput) => {
                const i = hookInput as PreToolUseHookInput;
                const roots = [ctx.workspaceDir, ctx.botHome];
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
      maxBudgetUsd: ctx.maxBudgetUsd,
      // Allowlisted env only (audit 2026-09-09, B7): the child never sees POCKETROCKET_TOKEN or another
      // provider's API key, so `env`/`node -e "process.env"` inside a prompt injection yields nothing useful.
      env: childEnv('claude', { CLAUDE_AGENT_SDK_CLIENT_APP: 'pocketrocket/' + VERSION }),
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

    const q = query({ prompt: prompt(), options });
    this.active.set(ctx.turnId, q);
    const onAbort = () => { void q.interrupt().catch(() => undefined); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'system' && m.subtype === 'init') {
          this.lastInit = { apiKeySource: m.apiKeySource, model: m.model, version: m.claude_code_version, tools: m.tools, skills: m.skills };
          sink.onInit?.(this.lastInit);
          if (m.session_id) sink.onSession(m.session_id);
          continue;
        }
        if (m.type === 'stream_event') {
          if (m.parent_tool_use_id) continue;
          const ev = m.event as { type: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) sink.onDelta(ev.delta.text);
          continue;
        }
        if (m.type === 'assistant') {
          if (m.parent_tool_use_id) continue;
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
          costUsd = m.total_cost_usd ?? 0;
          ok = m.subtype === 'success';
          if (!ok) error = m.subtype + ((m as { errors?: string[] }).errors?.length ? ': ' + (m as { errors?: string[] }).errors!.join('; ') : '');
          const resultText = (m as { result?: string }).result;
          if (!outdatedCli && isOutdatedCliError(resultText)) outdatedCli = resultText!.trim();
          if (!outdatedCli && error && isOutdatedCliError(error)) outdatedCli = error;
          const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          usage = {
            inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0,
            cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
          };
          modelUsage = (m as { modelUsage?: unknown }).modelUsage;
          durationMs = m.duration_ms;
          resolveDone();
          break;
        }
      }
    } catch (e) {
      error = error ?? String((e as Error).message ?? e);
      if (!outdatedCli && isOutdatedCliError(error)) outdatedCli = error;
    } finally {
      resolveDone();
      ctx.signal.removeEventListener('abort', onAbort);
      this.active.delete(ctx.turnId);
    }
    // The CLI reports this API error as a "successful" result, so the turn is marked failed here.
    if (outdatedCli) {
      ok = false;
      error = outdatedCli;
    }

    const outcome: TurnOutcome = {
      ok, error, costUsd,
      usage: { costUsd, ...usage, modelUsage, durationMs: durationMs || Date.now() - started },
      durationMs: durationMs || Date.now() - started,
    };
    return { outcome, outdatedCli: !!outdatedCli, usedTools };
  }
}
