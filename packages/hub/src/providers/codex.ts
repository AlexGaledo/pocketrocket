import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ModelInfo, ProviderAuth, ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { SecretsStore } from '../services/SecretsStore.js';
import { childEnv } from './env.js';
import { addSecret, redact } from './redact.js';
import { CodexEventParser } from './codex/parser.js';
import { estimateCostUsd } from './codex/pricing.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from './types.js';

/**
 * OpenAI Codex CLI adapter (`codex exec --json`, prompt on stdin).
 *
 * MCP injection path: **per-run `-c` overrides**, not a generated `CODEX_HOME`. Every turn passes
 *   -c mcp_servers.pocketrocket.url="<hub /mcp url>"
 *   -c mcp_servers.pocketrocket.bearer_token_env_var="POCKETROCKET_MCP_TOKEN"
 * plus `POCKETROCKET_MCP_TOKEN=<per-turn token>` in the child env, so the hub's tools live only for the
 * turn and the user's own `~/.codex` (login, AGENTS.md, model providers, their own MCP servers) is left
 * untouched. `-c key=value` is documented as a repeatable dotted-key TOML override and the two keys above
 * are the documented shape of an HTTP MCP server, but the combination is NOT verified on a live CLI here —
 * Codex is not installed on this machine (see the report / README for the one-line check).
 * If it ever turns out `-c` refuses dotted `mcp_servers.*` keys, the fallback is a per-hub
 * `<DATA_DIR>/codex-home/config.toml` with the same `[mcp_servers.pocketrocket]` block plus a junction to
 * `~/.codex/auth.json`, selected with `CODEX_HOME=` in the child env; nothing else about this file changes.
 *
 * Sandbox / permissions: `--sandbox workspace-write --ask-for-approval never` (read-only when the bot has
 * no Bash), with `sandbox_workspace_write.writable_roots` widened to the bot's private home so memory
 * writes work. Out-of-workspace writes and network are blocked by the CLI sandbox, and PromptBuilder has
 * already told the bot to call `request_approval` first — there is nothing to intercept in-process.
 *
 * Docs used (2026-09-08): https://developers.openai.com/codex/cli/reference,
 * https://developers.openai.com/codex/noninteractive, https://developers.openai.com/codex/config-reference,
 * https://developers.openai.com/codex/models.md, https://developers.openai.com/api/docs/pricing
 */

export const CODEX_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'codex',
  label: 'OpenAI Codex',
  blurb: 'The Codex CLI in headless mode (`codex exec`). Sign in with ChatGPT or an OpenAI API key.',
  authModes: ['subscription', 'apiKey'],
  secretKeys: ['OPENAI_API_KEY'],
  permissions: 'best-effort',
};

/**
 * Curated list, from OpenAI docs (https://developers.openai.com/codex/models.md, 2026-09-08) — edit in
 * Settings if your account differs. No documented subcommand enumerates models (the CLI reference lists
 * exec / login / mcp / resume and describes `-m` as taking any id string), and this machine has no Codex
 * install to probe `codex --help` against, so the list is static rather than discovered.
 * Prices in the notes are the per-1M input/output API rates from `codex/pricing.ts`.
 */
export const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'balanced, default — $2/$12 per 1M', default: true },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'hardest tasks — $4/$20 per 1M' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'cheapest, fastest — $0.20/$1.20 per 1M' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'flagship, priciest — $10/$50 per 1M' },
];

export const CODEX_HINT =
  'Install the Codex CLI (`npm i -g @openai/codex`), then sign in with `codex login` (ChatGPT subscription) ' +
  'or `codex login --with-api-key` (pipe an OpenAI key on stdin). Set `CODEX_EXE` if the binary is not on PATH.';

const VERSION_TIMEOUT_MS = 3000;
const LOGIN_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------- process helpers

/**
 * Node refuses to spawn a `.cmd`/`.bat` directly since 20.12 (and `shell: true` would re-quote our args),
 * so route those through cmd.exe ourselves. A `.mjs`/`.js` path runs under this Node — that is how the
 * tests point the adapter at a fake CLI.
 */
export function spawnTarget(exe: string, args: string[]): { command: string; argv: string[] } {
  const lower = exe.toLowerCase();
  if (lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.js')) {
    return { command: process.execPath, argv: [exe, ...args] };
  }
  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    return { command: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', exe, ...args] };
  }
  return { command: exe, argv: args };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI once and collect its output; never rejects. */
function run(exe: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const { command, argv } = spawnTarget(exe, args);
    let child: ChildProcess;
    try {
      child = spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String((e as Error).message ?? e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr: stderr + '\n(timed out after ' + String(timeoutMs) + 'ms)' });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: null, stdout, stderr: String(e.message) }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** Codex spawns sandbox helper processes, so a plain kill() can leave children behind on Windows. */
function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => undefined,
      );
    } catch {
      /* fall through to the signal below */
    }
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/**
 * `CODEX_EXE` wins, otherwise the first `where`/`which` hit. On Windows an npm global install drops three
 * files next to each other (`codex`, `codex.cmd`, `codex.ps1`); only the `.exe`/`.cmd` ones are spawnable.
 */
export async function findCodexExe(): Promise<string | null> {
  const override = process.env.CODEX_EXE;
  if (override) return override;
  const win = process.platform === 'win32';
  const r = await run(win ? 'where' : 'which', ['codex'], VERSION_TIMEOUT_MS);
  const hits = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && fs.existsSync(l));
  if (!hits.length) return null;
  if (!win) return hits[0];
  const rank = (p: string) => (/\.exe$/i.test(p) ? 0 : /\.cmd$/i.test(p) ? 1 : /\.bat$/i.test(p) ? 2 : 3);
  return [...hits].sort((a, b) => rank(a) - rank(b))[0];
}

// ---------------------------------------------------------------- argv

export interface CodexArgsInput {
  workspaceDir: string;
  botHome: string;
  model: string;
  mcpUrl: string;
  resumeToken: string | null;
  /** The bot has no Bash: drop the sandbox to read-only so it cannot shell out at all. */
  readOnly: boolean;
}

/**
 * `-c` values are parsed as TOML, so every string is JSON-quoted (which is also valid TOML) — that keeps
 * `http://…` from being mis-parsed and escapes the backslashes in Windows paths inside the array literal.
 */
export function buildCodexArgs(i: CodexArgsInput): string[] {
  const args = ['exec'];
  if (i.resumeToken) args.push('resume', i.resumeToken);
  args.push(
    '--json',
    '--skip-git-repo-check',
    '-C',
    i.workspaceDir,
    '-m',
    i.model,
    '--sandbox',
    i.readOnly ? 'read-only' : 'workspace-write',
    '--ask-for-approval',
    'never',
    '-c',
    'mcp_servers.pocketrocket.url=' + JSON.stringify(i.mcpUrl),
    '-c',
    'mcp_servers.pocketrocket.bearer_token_env_var="POCKETROCKET_MCP_TOKEN"',
  );
  // Only meaningful under workspace-write; the bot's private home lives outside the shared workspace.
  if (!i.readOnly) args.push('-c', 'sandbox_workspace_write.writable_roots=[' + JSON.stringify(i.botHome) + ']');
  args.push('-'); // read the prompt from stdin
  return args;
}

/** Fresh thread: the whole system prompt. Resume: one line of context, the thread already has the rules. */
export function buildCodexPrompt(ctx: Pick<TurnContext, 'systemPrompt' | 'input' | 'resumeToken' | 'bot'>): string {
  if (!ctx.resumeToken) return ctx.systemPrompt + '\n\n---\n\n' + ctx.input;
  return (
    'You are @' + ctx.bot.handle + '; room rules unchanged; reply NO_REPLY if nothing to add.\n\n' + ctx.input
  );
}

/** `codex login status` prints the active auth mode and exits 0 when logged in. */
export function parseAuth(loginOk: boolean, loginOutput: string, hasApiKey: boolean): ProviderAuth {
  const text = loginOutput.toLowerCase();
  if (loginOk) {
    if (/api key/.test(text)) return 'apiKey';
    if (/chatgpt|logged in|subscription|account/.test(text)) return 'subscription';
    return hasApiKey ? 'apiKey' : 'subscription';
  }
  return hasApiKey ? 'apiKey' : 'none';
}

// ---------------------------------------------------------------- provider

export interface CodexProviderOptions {
  /** Absolute path to the CLI (or a `.mjs` script). Tests inject a fake; production auto-detects. */
  exe?: string;
  secrets?: Pick<SecretsStore, 'get'>;
  /**
   * Extra variables to add to the child's (allowlisted) environment. Only the test harness uses it, to
   * hand the fake CLI its FAKE_CODEX_* knobs — the allowlist deliberately drops anything unrecognised.
   */
  env?: NodeJS.ProcessEnv;
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly label = CODEX_INFO.label;
  readonly info = CODEX_INFO;
  /** In-flight children, so interrupt()/abort can tree-kill them. `killed` distinguishes a stop from a crash. */
  private active = new Map<string, { child: ChildProcess; killed: boolean }>();
  private secrets: Pick<SecretsStore, 'get'>;

  constructor(private opts: CodexProviderOptions = {}) {
    this.secrets = opts.secrets ?? new SecretsStore();
  }

  async models(): Promise<ModelInfo[]> {
    return CODEX_MODELS;
  }
  modelsSync(): ModelInfo[] {
    return CODEX_MODELS;
  }

  private exe(): Promise<string | null> {
    return this.opts.exe ? Promise.resolve(this.opts.exe) : findCodexExe();
  }

  async check(): Promise<ProviderCheck> {
    const exe = await this.exe();
    if (!exe) return { ok: false, auth: 'none', error: 'codex was not found on PATH', hint: CODEX_HINT };

    const v = await run(exe, ['--version'], VERSION_TIMEOUT_MS);
    const version = v.stdout.trim().split(/\r?\n/)[0] || undefined;
    if (v.code !== 0 || !version) {
      return { ok: false, auth: 'unknown', version, error: 'codex --version did not answer within 3s', hint: CODEX_HINT };
    }

    const login = await run(exe, ['login', 'status'], LOGIN_TIMEOUT_MS);
    const hasApiKey = !!this.secrets.get('OPENAI_API_KEY');
    const auth = parseAuth(login.code === 0, login.stdout + '\n' + login.stderr, hasApiKey);
    if (auth === 'none') {
      return { ok: false, auth, version, error: 'codex is installed but not logged in', hint: CODEX_HINT };
    }
    return { ok: true, auth, version, hint: CODEX_HINT };
  }

  interrupt(turnId: string): boolean {
    const entry = this.active.get(turnId);
    if (!entry) return false;
    entry.killed = true;
    killTree(entry.child);
    return true;
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const started = Date.now();
    const fail = (error: string): TurnOutcome => ({
      ok: false,
      error,
      costUsd: 0,
      usage: { ...EMPTY_USAGE },
      durationMs: Date.now() - started,
    });

    const exe = await this.exe();
    if (!exe) return fail('codex was not found on PATH. ' + CODEX_HINT);

    const args = buildCodexArgs({
      workspaceDir: ctx.workspaceDir,
      botHome: ctx.botHome,
      model: ctx.model,
      mcpUrl: ctx.mcp.url,
      resumeToken: ctx.resumeToken,
      readOnly: !ctx.allowedBuiltins.includes('Bash'),
    });

    // Allowlisted env only (audit 2026-09-09, B7): OPENAI_API_KEY, CODEX_HOME and the per-turn MCP token,
    // never the hub token and never another provider's key.
    const apiKey = this.secrets.get('OPENAI_API_KEY');
    const env = childEnv('codex', {
      POCKETROCKET_MCP_TOKEN: ctx.mcp.token,
      ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      ...this.opts.env,
    });

    addSecret(ctx.mcp.token);
    const { command, argv } = spawnTarget(exe, args);
    let child: ChildProcess;
    try {
      child = spawn(command, argv, { cwd: ctx.workspaceDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return fail('could not start codex: ' + String((e as Error).message ?? e));
    }
    const entry = { child, killed: false };
    this.active.set(ctx.turnId, entry);
    sink.onInit?.({ model: ctx.model });

    const parser = new CodexEventParser(sink);
    let stderr = '';
    let spawnError: string | null = null;
    let budgetKilled = false;

    const cost = () =>
      estimateCostUsd(ctx.model, {
        inputTokens: parser.usage.inputTokens,
        cachedInputTokens: parser.usage.cachedInputTokens,
        outputTokens: parser.usage.outputTokens,
      });

    const onAbort = () => {
      entry.killed = true;
      killTree(child);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        parser.push(chunk);
        // Usage only lands on turn.completed, so this is the earliest a budget breach can be seen.
        if (!budgetKilled && ctx.maxBudgetUsd > 0 && cost() > ctx.maxBudgetUsd) {
          budgetKilled = true;
          killTree(child);
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (process.env.POCKETROCKET_DEBUG) process.stderr.write('[codex ' + ctx.bot.handle + '] ' + chunk);
      });

      const prompt = buildCodexPrompt(ctx);
      child.stdin?.on('error', () => undefined); // the CLI may exit before reading the prompt
      child.stdin?.end(prompt);

      const code = await new Promise<number | null>((resolve) => {
        child.on('error', (e) => {
          spawnError = String(e.message);
          resolve(null);
        });
        child.on('close', (c) => resolve(c));
      });
      parser.end();

      const costUsd = cost();
      const usage = {
        costUsd,
        // OpenAI counts cache reads inside input_tokens; the hub shows them as separate columns.
        inputTokens: Math.max(0, parser.usage.inputTokens - parser.usage.cachedInputTokens),
        outputTokens: parser.usage.outputTokens,
        cacheReadTokens: parser.usage.cachedInputTokens,
        cacheWriteTokens: 0,
        modelUsage: { [ctx.model]: { ...parser.usage, costUsd, estimated: true } },
        durationMs: Date.now() - started,
      };

      let error: string | undefined;
      if (budgetKilled) {
        error = 'budget exceeded: estimated $' + costUsd.toFixed(4) + ' over the $' + String(ctx.maxBudgetUsd) + ' cap';
      } else if (entry.killed) {
        error = 'interrupted';
      } else if (parser.error) {
        error = parser.error;
      } else if (spawnError) {
        error = 'codex failed to start: ' + spawnError;
      } else if (code !== 0) {
        error = 'codex exited with code ' + String(code) + (stderr.trim() ? ': ' + redact(stderr.trim().slice(-500)) : '');
      } else if (!parser.completed) {
        error = 'codex ended without a turn.completed event' + (stderr.trim() ? ': ' + redact(stderr.trim().slice(-500)) : '');
      }

      return { ok: !error, error, costUsd, usage, durationMs: usage.durationMs };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      this.active.delete(ctx.turnId);
    }
  }
}

export function createCodexProvider(opts: CodexProviderOptions = {}): CodexProvider {
  return new CodexProvider(opts);
}
