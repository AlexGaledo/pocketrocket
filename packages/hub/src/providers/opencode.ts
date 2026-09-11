import type { ModelInfo, ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import type { AgentProvider, TurnContext, TurnOutcome, TurnSink } from './types.js';
import { parseAuthList, parseModels, parseVersion, readAuthFile, resolveOpencodeExe, runCli, splitModelId } from './opencode/cli.js';
import { TurnTracker, type OcEvent } from './opencode/events.js';
import { OpenCodeServer } from './opencode/server.js';

/**
 * # OpenCode adapter (P2B)
 *
 * The hub runs **one** `opencode serve` child (started lazily on the first turn, `opencode/server.ts`) with
 * an inline `OPENCODE_CONFIG_CONTENT`, and drives it through `@opencode-ai/sdk` (pinned to 1.17.6, the exact
 * version of the installed CLI). One OpenCode session per (bot, room) pair: `ctx.resumeToken` is the session
 * id, `sink.onSession` stores it.
 *
 * ## MCP token design
 * `TurnContext.mcp.token` dies with the turn, but OpenCode reads MCP config once at startup and — verified
 * on 1.17.6 — keeps one connection per configured server with static headers and no session identity on any
 * request. A per-turn token therefore cannot be handed to it. So the config points at a small loopback
 * bridge (`opencode/bridge.ts`) with a token that lives as long as the serve child; the bridge forwards each
 * MCP request to the hub's `/mcp` under the bearer of the turn it belongs to, attributing `tools/call` by
 * which session currently has that tool in flight. See the header of `bridge.ts` for the full rationale.
 *
 * ## Prompt delivery
 * `POST /session/{id}/prompt_async` takes a top-level `system` string (verified: it is stored on the user
 * message and obeyed). The bot's PromptBuilder output is sent there on **every** turn, so no per-bot agent
 * definitions and no server restarts when a bot's prompt changes.
 *
 * ## Permissions
 * The config sets `edit`, `bash`, `webfetch`, `websearch` and `external_directory` to `ask`. Every
 * `permission.asked` event is mapped back to a hub tool name + input and routed through
 * `ctx.permission` -> PermissionBroker, which auto-allows anything inside the workspace / bot home and only
 * raises an approval card for the rest; the answer goes back as `once` / `reject`. `info.permissions` stays
 * `best-effort` because reads/globs inside the OpenCode project are still allowed by OpenCode itself.
 */

export const OPENCODE_INFO: Omit<ProviderInfo, 'check' | 'models'> = {
  id: 'opencode',
  label: 'OpenCode',
  blurb: 'OpenCode running as a local server. Brings its own provider logins (ChatGPT, Claude, Copilot, xAI, ...).',
  authModes: ['subscription', 'apiKey'],
  secretKeys: [],
  permissions: 'best-effort',
  maturity: 'verified',
};

// Empty on purpose: OpenCode model ids depend on which providers the user is logged into, so they are read
// from `opencode models` at runtime instead of hardcoded. `modelsSync()` serves the 5-minute cache.
export const OPENCODE_MODELS: ModelInfo[] = [];

export const OPENCODE_HINT =
  'Install OpenCode (`npm i -g opencode-ai`) and log a provider in with `opencode auth login`. ' +
  'Point OPENCODE_EXE at the binary if it is not on PATH.';

const MODELS_TTL_MS = 5 * 60 * 1000;

/** Appended to the bot's system prompt: OpenCode exposes MCP tools as `<server>_<tool>`. */
export const TOOL_NAMING_NOTE =
  '\n\n## Tool names\n' +
  'The PocketRocket tools above reach you through an MCP server named `pocketrocket`, so their real names ' +
  'are prefixed: call `pocketrocket_send_message`, `pocketrocket_update_memory`, `pocketrocket_create_bot` ' +
  'and so on.';

export class OpenCodeProvider implements AgentProvider {
  readonly id = 'opencode' as const;
  readonly label = 'OpenCode';
  readonly info = OPENCODE_INFO;

  private server = new OpenCodeServer();
  private modelCache: { at: number; models: ModelInfo[] } = { at: 0, models: [] };
  private modelsInFlight: Promise<ModelInfo[]> | null = null;
  /** turnId -> OpenCode session id, so `interrupt()` can abort the right session. */
  private active = new Map<string, string>();
  /** Last `opencode --version` seen; reported on `GET /api/health` through `sink.onInit`. */
  private version: string | undefined;

  /**
   * `opencode models` takes ~4s on a warm machine, far too long to sit inside `GET /api/providers`. So this
   * never blocks: it returns the current cache (empty until the first refresh lands) and schedules a
   * background refresh. `check()` warms it, and `runTurn` awaits `modelList()` where correctness matters.
   */
  async models(): Promise<ModelInfo[]> {
    if (Date.now() - this.modelCache.at >= MODELS_TTL_MS) void this.refreshModels();
    return this.modelCache.models;
  }

  modelsSync(): ModelInfo[] {
    return this.modelCache.models;
  }

  modelsAwaited(): Promise<ModelInfo[]> {
    return this.modelList();
  }

  private refreshModels(): Promise<ModelInfo[]> {
    if (this.modelsInFlight) return this.modelsInFlight;
    this.modelsInFlight = (async () => {
      const r = await runCli(resolveOpencodeExe(), ['models'], 20_000, true);
      const models = r.ok ? parseModels(r.stdout) : [];
      if (models.length) this.modelCache = { at: Date.now(), models };
      this.modelsInFlight = null;
      return this.modelCache.models;
    })();
    return this.modelsInFlight;
  }

  /** The awaiting variant, for the turn path. */
  private async modelList(): Promise<ModelInfo[]> {
    if (this.modelCache.models.length && Date.now() - this.modelCache.at < MODELS_TTL_MS) return this.modelCache.models;
    return this.refreshModels();
  }

  async check(): Promise<ProviderCheck> {
    const exe = resolveOpencodeExe();
    // Credentials come from the auth file when it is there (instant); `opencode auth list` costs ~1.7s and
    // is only the fallback. `--version` doubles as the "is the CLI runnable" probe.
    const fromFile = readAuthFile();
    const [v, a] = await Promise.all([
      runCli(exe, ['--version'], 5000),
      fromFile ? Promise.resolve(null) : runCli(exe, ['auth', 'list'], 8000),
    ]);
    const version = v.ok ? parseVersion(v.stdout) : undefined;
    this.version = version ?? this.version;
    if (!version) {
      return {
        ok: false,
        auth: 'none',
        error: v.error ?? 'opencode --version did not answer within 5s',
        hint: OPENCODE_HINT,
      };
    }
    void this.models(); // warm the model cache for the next /api/providers call
    const auth = fromFile ?? (a?.ok ? parseAuthList(a.stdout) : { providers: [], auth: 'none' as const });
    if (auth.auth === 'none') {
      return { ok: false, version, auth: 'none', error: 'No OpenCode provider is logged in', hint: OPENCODE_HINT };
    }
    return { ok: true, version, auth: auth.auth, account: auth.providers.join(', '), hint: OPENCODE_HINT };
  }

  interrupt(turnId: string): boolean {
    const sessionID = this.active.get(turnId);
    if (!sessionID || !this.server.running) return false;
    void this.abort(sessionID);
    return true;
  }

  async shutdown(): Promise<void> {
    await this.server.stop();
  }

  private async abort(sessionID: string) {
    const client = this.server.client;
    if (!client) return;
    try {
      await client.session.abort({ path: { id: sessionID } });
    } catch {
      /* the server may already be gone */
    }
  }

  /** Map the bot's stored model id onto a real `provider/model` pair, falling back to the list default. */
  private async resolveModel(id: string): Promise<{ providerID: string; modelID: string }> {
    const models = await this.modelList();
    if (!models.length) return splitModelId(id);
    if (models.some((m) => m.id === id)) return splitModelId(id);
    const suffix = models.find((m) => m.id.endsWith('/' + id));
    if (suffix) return splitModelId(suffix.id);
    const fallback = models.find((m) => m.default) ?? models[0];
    return splitModelId(fallback.id);
  }

  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    const started = Date.now();
    const fail = (error: string): TurnOutcome => ({
      ok: false,
      error,
      costUsd: 0,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: undefined, durationMs: Date.now() - started },
      durationMs: Date.now() - started,
    });

    let server;
    try {
      server = await this.server.ensure(ctx.mcp.url, !!ctx.bypassPermissions);
    } catch (e) {
      return fail('could not start `opencode serve`: ' + String((e as Error).message ?? e));
    }
    const { client, bridge } = server;

    // --- session (one per bot+room, resumed through ctx.resumeToken) ---
    let sessionID: string | null = ctx.resumeToken;
    if (sessionID) {
      const existing = await client.session.get({ path: { id: sessionID } });
      if (!existing.data) sessionID = null;
    }
    if (!sessionID) {
      const created = await client.session.create({
        body: { title: ctx.bot.name + ' — ' + ctx.room.name },
        query: { directory: ctx.workspaceDir },
      });
      sessionID = created.data?.id ?? null;
      if (!sessionID) return fail('OpenCode refused to create a session: ' + JSON.stringify(created.error ?? {}).slice(0, 300));
    }
    sink.onSession(sessionID);
    const sid = sessionID;

    const model = await this.resolveModel(ctx.model);
    sink.onInit?.({ model: model.providerID + '/' + model.modelID, version: this.version });

    // --- event tracker ---
    const tracker = new TurnTracker(
      sid,
      {
        sink,
        permission: (name, input, extra) => ctx.permission(name, input, { reason: extra.reason, danger: extra.danger }),
        reply: async (permissionID, response) => {
          await client.postSessionIdPermissionsPermissionId({ path: { id: sid, permissionID }, body: { response } });
        },
        onOverBudget: () => void this.abort(sid),
        onMcpToolPending: (toolName, pending) => bridge.setPending(sid, toolName, pending),
      },
      ctx.maxBudgetUsd,
    );

    bridge.register(sid, ctx.mcp.token);
    this.active.set(ctx.turnId, sid);
    this.server.listen(sid, (ev: OcEvent) => tracker.handle(ev));

    const onAbort = () => {
      tracker.finish('interrupted');
      void this.abort(sid);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      sink.onState('thinking');
      const sent = await client.session.promptAsync({
        path: { id: sid },
        query: { directory: ctx.workspaceDir },
        body: {
          model,
          system: ctx.systemPrompt + TOOL_NAMING_NOTE,
          parts: [{ type: 'text', text: ctx.input }],
        },
      });
      if (sent.error) {
        tracker.finish('OpenCode rejected the prompt: ' + JSON.stringify(sent.error).slice(0, 300));
      }
      await tracker.finished;
    } catch (e) {
      tracker.finish(String((e as Error).message ?? e));
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      this.server.unlisten(sid);
      bridge.unregister(sid);
      this.active.delete(ctx.turnId);
    }

    const totals = tracker.totals();
    const durationMs = Date.now() - started;
    return {
      ok: !tracker.error,
      error: tracker.error,
      costUsd: totals.costUsd,
      usage: { ...totals, modelUsage: undefined, durationMs },
      durationMs,
    };
  }
}

export function createOpenCodeProvider(): OpenCodeProvider {
  return new OpenCodeProvider();
}
