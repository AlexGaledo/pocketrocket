import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import {
  createSdkMcpServer, query, tool,
  type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { CDP_URL, CLAUDE_EXE, PLAYWRIGHT_MCP_CLI, VERSION } from '../config.js';
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
  { id: 'claude-opus-5', label: 'Opus 5', note: 'strongest, priciest' },
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
    const hint =
      'Install Claude Code (`npm i -g @anthropic-ai/claude-code`) and sign in with `claude` (subscription), ' +
      'or set ANTHROPIC_API_KEY. Point CLAUDE_EXE at the binary if it lives elsewhere.';
    if (!fs.existsSync(CLAUDE_EXE)) {
      return { ok: false, auth: 'none', error: 'claude executable not found at ' + CLAUDE_EXE, hint };
    }
    const version = await new Promise<string | undefined>((resolve) => {
      const child = execFile(CLAUDE_EXE, ['--version'], { timeout: 2000, windowsHide: true }, (err, stdout) => {
        resolve(err ? undefined : String(stdout).trim().split('\n')[0]);
      });
      child.on('error', () => resolve(undefined));
    });
    if (!version) return { ok: false, auth: 'unknown', version, error: 'claude --version did not answer within 2s', hint };
    // `claude -p` under an OAuth login reports apiKeySource 'none' on the init message; that is the
    // expected value for a subscription, not an error.
    const auth = process.env.ANTHROPIC_API_KEY
      ? 'apiKey'
      : this.lastInit.apiKeySource === undefined || this.lastInit.apiKeySource === 'none'
        ? 'subscription'
        : 'unknown';
    return { ok: true, version, auth, hint };
  }

  interrupt(turnId: string): boolean {
    const q = this.active.get(turnId);
    if (!q) return false;
    void q.interrupt().catch(() => undefined);
    return true;
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
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
      permissionMode: 'acceptEdits',
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
      hooks: {
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
            if (block.type === 'text' && block.text.trim()) sink.onText(block.text);
            else if (block.type === 'tool_use') {
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
    } finally {
      resolveDone();
      ctx.signal.removeEventListener('abort', onAbort);
      this.active.delete(ctx.turnId);
    }

    return {
      ok, error, costUsd,
      usage: { costUsd, ...usage, modelUsage, durationMs: durationMs || Date.now() - started },
      durationMs: durationMs || Date.now() - started,
    };
  }
}
