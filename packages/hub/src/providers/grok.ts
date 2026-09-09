import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { ModelInfo, ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { SecretsStore } from '../services/SecretsStore.js';
import type { AgentProvider, ProviderInit, TurnContext, TurnOutcome, TurnSink } from './types.js';
import { buildArgs, ensureGrokHome, GROK_HOME, parseModelsOutput, removeAuthMirror, removeRulesFile, resolveGrokExe, treeKill, turnEnv, writeRulesFile } from './grok/cli.js';
import { childEnv } from './env.js';
import { addSecret, redact } from './redact.js';
import { estimateCostUsd } from './grok/pricing.js';
import { NdjsonParser, renderToolOutput, tokensFrom, type GrokEvent, type GrokUsageBlock } from './grok/stream.js';

export const GROK_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'grok',
  label: 'Grok',
  blurb: 'xAI Grok through the Grok Build CLI (`grok -p`). Sign in with `grok login` or paste an xAI API key.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['XAI_API_KEY'],
  permissions: 'best-effort',
  maturity: 'untested',
};

/** Fallback list (docs.x.ai/docs/models). `models()` prefers whatever the installed CLI reports. */
export const GROK_MODELS: ModelInfo[] = [
  { id: 'grok-4.6', label: 'Grok 4.6', note: 'strongest, default', default: true },
  { id: 'grok-4.5', label: 'Grok 4.5', note: 'previous flagship' },
  { id: 'grok-4.3', label: 'Grok 4.3', note: 'cheaper, 1M context' },
  { id: 'grok-build-0.1', label: 'Grok Build 0.1', note: 'cheapest, coding' },
];

export const GROK_HINT =
  'Install the Grok Build CLI (`irm https://x.ai/cli/install.ps1 | iex`, or ' +
  '`curl -fsSL https://x.ai/cli/install.sh | bash`), then run `grok login` — or paste an xAI API key ' +
  '(XAI_API_KEY, from console.x.ai) in Settings. Point GROK_EXE at the binary if it lives elsewhere.';

const MODELS_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

export interface Probe {
  stdout: string;
  error?: string;
}

/** Seams for the tests: no real `grok` binary exists on CI, and spawning one would be slow anyway. */
export interface GrokDeps {
  spawn?: typeof spawn;
  /** Runs a short `grok <args>` probe (`--version`, `models`). */
  probe?: (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<Probe>;
  exe?: string;
  home?: string;
  secrets?: Pick<SecretsStore, 'get'>;
}

function run(exe: string, args: string[], env: NodeJS.ProcessEnv): Promise<Probe> {
  return new Promise((resolve) => {
    const child = execFile(
      exe,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? { stdout: String(stdout ?? ''), error: String(err.message ?? err) } : { stdout: String(stdout) }),
    );
    child.on('error', (e) => resolve({ stdout: '', error: String(e.message ?? e) }));
  });
}

/**
 * Drives the official Grok Build CLI in headless mode. One `grok -p --output-format streaming-json` process
 * per turn; hub tools reach it over the loopback MCP endpoint (`ctx.mcp`) declared in a private
 * `$GROK_HOME/config.toml`. See `docs/research/grok-cli.md` for the flag and event-shape evidence.
 */
export class GrokProvider implements AgentProvider {
  readonly id = 'grok' as const;
  readonly label = 'Grok';
  readonly info = GROK_INFO;
  private active = new Map<string, ChildProcess>();
  private modelCache: { at: number; models: ModelInfo[] } | null = null;
  /** Last `grok --version` seen by check(); reported on GET /api/health. */
  private cliVersion: string | undefined;
  lastInit: ProviderInit = {};

  private secrets: Pick<SecretsStore, 'get'>;
  private probe: (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<Probe>;

  constructor(private deps: GrokDeps = {}) {
    this.secrets = deps.secrets ?? new SecretsStore();
    this.probe = deps.probe ?? run;
  }

  private exe(): string {
    return this.deps.exe ?? resolveGrokExe();
  }

  private apiKey(): string | null {
    return this.secrets.get('XAI_API_KEY');
  }

  private env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const key = this.apiKey();
    const home = this.deps.home ?? GROK_HOME;
    // Allowlisted env only (audit 2026-09-09, B7): XAI_API_KEY, GROK_*, POCKETROCKET_MCP_*.
    return childEnv('grok', { ...(key ? { XAI_API_KEY: key } : {}), GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: '1', ...extra });
  }

  modelsSync(): ModelInfo[] {
    return this.modelCache?.models ?? GROK_MODELS;
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODELS_TTL_MS) return this.modelCache.models;
    const models = await this.probeModels();
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  private async probeModels(): Promise<ModelInfo[]> {
    const { stdout } = await this.probe(this.exe(), ['models'], this.env());
    const { ids, defaultId } = parseModelsOutput(stdout);
    if (!ids.length) return GROK_MODELS;
    const known = new Map(GROK_MODELS.map((m) => [m.id, m]));
    return ids.map((id) => {
      const base = known.get(id);
      return {
        id,
        label: base?.label ?? id,
        note: base?.note,
        default: defaultId ? id === defaultId : base?.default,
      };
    });
  }

  async check(): Promise<ProviderCheck> {
    const exe = this.exe();
    const version = await this.probe(exe, ['--version'], this.env());
    if (version.error) {
      return { ok: false, auth: 'none', error: 'grok CLI not runnable (' + exe + '): ' + version.error, hint: GROK_HINT };
    }
    const v = version.stdout.trim().split('\n')[0] || undefined;
    this.cliVersion = v;
    if (this.apiKey()) return { ok: true, version: v, auth: 'apiKey', hint: GROK_HINT };
    // `grok models` answers without credentials and says so, which doubles as the login probe.
    const models = await this.probe(exe, ['models'], this.env());
    const parsed = parseModelsOutput(models.stdout);
    if (!parsed.authenticated) {
      return { ok: false, version: v, auth: 'none', error: 'Not signed in to Grok', hint: GROK_HINT };
    }
    return { ok: true, version: v, auth: 'subscription', hint: GROK_HINT };
  }

  interrupt(turnId: string): boolean {
    const child = this.active.get(turnId);
    if (!child) return false;
    treeKill(child.pid);
    return true;
  }

  /**
   * Delete the mirrored `auth.json` (audit 2026-09-09, B18): a stopped hub must not leave a second copy of
   * the user's Grok refresh token lying in DATA_DIR. The next start mirrors it again from `~/.grok`.
   */
  async shutdown(): Promise<void> {
    removeAuthMirror(this.deps.home ?? GROK_HOME);
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const started = Date.now();
    const exe = this.exe();
    const home = ensureGrokHome(this.deps.home ?? GROK_HOME);
    // The system prompt (identity + the bot's whole memory file) goes to a 0600 file, not to argv
    // (audit 2026-09-09, B19). Deleted in the `finally` below, whatever happens to the turn.
    const rulesFile = writeRulesFile(ctx.turnId, ctx.systemPrompt, home);
    const args = buildArgs({
      prompt: ctx.input,
      rules: rulesFile.rules,
      model: ctx.model,
      cwd: ctx.workspaceDir,
      maxTurns: ctx.maxTurns,
      resumeToken: ctx.resumeToken,
      allowedBuiltins: ctx.allowedBuiltins,
    });

    addSecret(ctx.mcp.token);
    const child = (this.deps.spawn ?? spawn)(exe, args, {
      cwd: ctx.workspaceDir,
      env: turnEnv(this.env(), home, ctx.mcp),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.active.set(ctx.turnId, child);
    this.lastInit = { model: ctx.model, version: this.cliVersion, apiKeySource: this.apiKey() ? 'XAI_API_KEY' : 'oauth' };
    sink.onInit?.(this.lastInit);

    const state = {
      pending: '',
      toolIds: new Set<string>(),
      running: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      final: null as GrokUsageBlock | null,
      reportedCost: undefined as number | undefined,
      sessionId: null as string | null,
      error: undefined as string | undefined,
      overBudget: false,
      stderr: '',
    };

    const flushText = () => {
      const t = state.pending;
      state.pending = '';
      if (t.trim()) sink.onText(t);
    };

    const handle = (ev: GrokEvent) => {
      switch (ev.type) {
        case 'text': {
          const d = typeof ev.data === 'string' ? ev.data : '';
          if (!d) return;
          state.pending += d;
          sink.onDelta(d);
          return;
        }
        case 'thought':
          sink.onState('thinking');
          return;
        case 'tool_call': {
          const e = ev as Extract<GrokEvent, { type: 'tool_call' }>;
          const id = e.toolCallId ?? 'grok-tool-' + state.toolIds.size;
          state.toolIds.add(id);
          // Text before a tool call is a complete assistant block; post it now so the chip lands after it.
          flushText();
          sink.onToolUse(id, e.toolName ?? e.title ?? 'tool', e.rawInput ?? {});
          sink.onState('working');
          return;
        }
        case 'tool_call_update': {
          const e = ev as Extract<GrokEvent, { type: 'tool_call_update' }>;
          const status = e.status ?? '';
          if (status !== 'completed' && status !== 'failed' && status !== 'error') return;
          if (e.toolCallId) sink.onToolResult(e.toolCallId, renderToolOutput(e), status !== 'completed');
          sink.onState('thinking');
          return;
        }
        case 'usage': {
          // One per model response: a natural assistant-message boundary, and the budget checkpoint.
          const t = tokensFrom((ev as { usage?: GrokUsageBlock }).usage);
          state.running.inputTokens += t.inputTokens;
          state.running.outputTokens += t.outputTokens;
          state.running.cacheReadTokens += t.cacheReadTokens;
          state.running.cacheWriteTokens += t.cacheWriteTokens;
          flushText();
          if (ctx.maxBudgetUsd > 0 && estimateCostUsd(ctx.model, state.running) > ctx.maxBudgetUsd && !state.overBudget) {
            state.overBudget = true;
            state.error = 'Budget of $' + ctx.maxBudgetUsd.toFixed(2) + ' exhausted; the turn was stopped.';
            treeKill(child.pid);
          }
          return;
        }
        case 'error': {
          const e = ev as { message?: string; usage?: GrokUsageBlock };
          state.error = state.error ?? (e.message || 'Grok reported an error');
          if (e.usage) state.final = e.usage;
          return;
        }
        case 'end': {
          const e = ev as Extract<GrokEvent, { type: 'end' }>;
          if (e.sessionId) state.sessionId = e.sessionId;
          if (e.usage) state.final = e.usage;
          // Omitted (not zero) when cost was partial or unreported; then the local estimate stands in.
          if (typeof e.total_cost_usd === 'number') state.reportedCost = e.total_cost_usd;
          return;
        }
        default:
          return;
      }
    };

    const parser = new NdjsonParser();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const ev of parser.push(chunk)) handle(ev);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      state.stderr = (state.stderr + chunk).slice(-4000);
      if (process.env.POCKETROCKET_DEBUG) process.stderr.write('[grok ' + ctx.bot.handle + '] ' + chunk);
    });

    const onAbort = () => treeKill(child.pid);
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (e) => {
        state.error = state.error ?? String(e.message ?? e);
        resolve(null);
      });
      child.on('close', (c) => resolve(c));
    });

    ctx.signal.removeEventListener('abort', onAbort);
    this.active.delete(ctx.turnId);
    removeRulesFile(rulesFile.path);
    for (const ev of parser.flush()) handle(ev);
    flushText();

    if (state.sessionId) sink.onSession(state.sessionId);

    // `end.usage` is the authoritative total; the summed per-response lines are the fallback when the process
    // died before it (interrupt, crash, budget stop).
    const usedFinal = state.final ? tokensFrom(state.final) : state.running;
    const costUsd = state.reportedCost ?? estimateCostUsd(ctx.model, usedFinal);
    const durationMs = Date.now() - started;

    if (!state.error && code !== 0) {
      if (ctx.signal.aborted || code === 130 || code === 143) state.error = 'Interrupted';
      else state.error = 'grok exited with code ' + String(code) + (state.stderr.trim() ? ': ' + redact(state.stderr.trim().split('\n').slice(-3).join(' ')) : '');
    }
    const ok = !state.error && code === 0;

    return {
      ok,
      error: state.error,
      costUsd,
      usage: { costUsd, ...usedFinal, modelUsage: undefined, durationMs },
      durationMs,
    };
  }
}

export function createGrokProvider(): AgentProvider {
  return new GrokProvider();
}
