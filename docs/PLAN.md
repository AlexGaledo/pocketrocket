# PocketRocket v1 — production/distribution plan

Status: **Executed 2026-09-08; see CHANGELOG.** Approved by Alex on 2026-09-08 (interview answers below). Orchestrated by Claude; implementation delegated to Opus/Sonnet sub-agents per phase. Research inputs: `docs/research/cli-agents.md`, `docs/research/xai-tauri.md`.

## Decisions (from interview)

| Topic | Decision |
|---|---|
| Name | **PocketRocket** (was Claudebot / grokbot). Tagline: "Your pocket fleet of AI agents." |
| Providers | **All four in v1**: Claude (Agent SDK), OpenAI Codex (CLI), OpenCode (server + SDK), Grok (Grok Build CLI; xAI API loop only as fallback). Subscription login or API key, whichever the provider's CLI supports. |
| Provider choice | **Global setting** (one provider for the whole hub) + per-bot model within that provider. |
| Permissions (non-Claude) | Best effort: provider sandboxed to workspace; OpenCode permission asks are routed to our approval cards; Codex/Grok get a hub `request_approval` tool for out-of-workspace or dangerous ops. |
| Platforms | **Windows only** installer at v1. Source runs anywhere Node ≥ 22.13 runs. |
| Hub runtime in desktop | **Detect both**: system Node ≥ 22.13 if present, else bundled Node 24 LTS sidecar. Hub is esbuild-bundled (`--packages=external`) + production `node_modules` in resources. |
| Landing page | Static site in `packages/site`, deployed to Vercel. |
| Sounds | WebAudio synth (no assets), **on by default**, settings toggle, respects `prefers-reduced-motion`. Cues: send, reply arrives, approval request, approve/deny, turn done, turn error, desktop connected. |
| GitHub | `AlexGaledo/pocketrocket`, **private for now**, MIT. Created via `gh`. |
| Migration | Hard rename everywhere; hub + desktop auto-migrate old Claudebot data on first start; deploy script migrates VPS units/dirs. |
| Release | GitHub Actions: CI on push; tag `v*` → NSIS installer → GitHub Release. Unsigned, no auto-updater (Help → Check for updates opens Releases). |
| VPS/screen | Keep all, made generic (no hardcoded `crm-agency` / `Alex`). |
| Onboarding | First-run wizard: pick provider, detect CLI + login, ask user's name, create first bot. |
| Icon | Generated rocket mark (SVG → full Tauri icon set), black circle / white glyph. |
| Working dir | Move `claude-grokbot` → `C:\Users\alex\desktop\pocketrocket` as the last step (needs session restart). |

## Naming map

| Old | New |
|---|---|
| Claudebot / claudebot | PocketRocket / pocketrocket |
| `@claudebot/*` packages, root `claude-claudebot` | `@pocketrocket/*`, root `pocketrocket` |
| MCP server `claudebot` → `mcp__claudebot__*` | `pocketrocket` → `mcp__pocketrocket__*` |
| env `CLAUDEBOT_DATA`, `CLAUDEBOT_DEBUG`, `CLAUDEBOT_USER` | `POCKETROCKET_DATA`, `POCKETROCKET_DEBUG`; `_USER` removed (settings) |
| `data/claudebot.db` | `data/pocketrocket.db` |
| Tauri `com.claudebot.desktop`, `claudebot-desktop.exe`, crate `claudebot-desktop` | `com.pocketrocket.app`, `PocketRocket.exe` (productName `PocketRocket`), crate `pocketrocket-desktop` |
| systemd `claudebot`, `claudebot-screen`, `/root/claudebot`, `/root/claudebot-backups` | `pocketrocket`, `pocketrocket-screen`, `/root/pocketrocket`, `/root/pocketrocket-backups` |
| localStorage `claudebot.theme`, `claudebot.activeRoom` | `pocketrocket.*` |
| `CLAUDE_AGENT_SDK_CLIENT_APP: claudebot/0.1` | `pocketrocket/<version>` |

## Architecture changes

### 1. Provider layer (`packages/hub/src/providers/`)

```ts
export type ProviderId = 'claude' | 'codex' | 'opencode' | 'grok';

export interface ModelInfo { id: string; label: string; note?: string; default?: boolean }
export interface ProviderCheck {
  ok: boolean; version?: string; auth: 'subscription' | 'apiKey' | 'none' | 'unknown';
  error?: string; hint?: string;            // hint = install/login instructions shown in onboarding
}

export interface HubTool {                  // provider-agnostic tool (hub tools + request_approval + desktop_*)
  name: string; description: string; inputSchema: z.ZodObject<any>;
  handler: (input: unknown) => Promise<{ text: string; isError?: boolean }>;
  readOnly?: boolean;
}

export interface TurnContext {
  turnId: string; bot: Bot; room: Room; members: Bot[];
  systemPrompt: string;                     // from PromptBuilder; adapter decides how to deliver it
  input: string;                            // injected room text for this turn
  resumeToken: string | null;               // provider session/thread id
  workspaceDir: string; botHome: string;
  tools: HubTool[];
  allowedBuiltins: string[];                // Read/Write/Edit/Glob/Grep/Bash/WebSearch/WebFetch/Browser/Desktop
  permission: (toolName: string, input: Record<string, unknown>, extra?: { blockedPath?: string; reason?: string; danger?: boolean }) => Promise<'allow' | 'deny'>;
  model: string; maxBudgetUsd: number; maxTurns: number;
  signal: AbortSignal;
}

export interface TurnSink {
  onSession(token: string): void;
  onDelta(text: string): void;
  onText(text: string): void;               // complete assistant text block
  onToolUse(id: string, name: string, input: unknown): void;
  onToolResult(id: string, output: string, isError: boolean): void;
  onState(s: 'thinking' | 'working'): void;
}

export interface TurnOutcome { ok: boolean; error?: string; costUsd: number; usage: UsageNumbers; durationMs: number }

export interface AgentProvider {
  id: ProviderId; label: string;
  models(): Promise<ModelInfo[]>;           // async: OpenCode/Grok may query the CLI
  check(): Promise<ProviderCheck>;
  runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome>;
  interrupt(turnId: string): boolean;
  shutdown?(): Promise<void>;               // e.g. stop `opencode serve`
}
```

- `BotRunner` becomes provider-agnostic: builds `TurnContext`, persists messages/events from `TurnSink`, records usage, handles `NO_REPLY`. All SDK-specific code moves to `providers/claude.ts` (behaviour unchanged, existing tests keep passing).
- `botTools.ts` → produces `HubTool[]` (plain zod + handler). `providers/claude.ts` wraps them with `createSdkMcpServer`; Codex/Grok reach them over the **HTTP MCP endpoint**; OpenCode via its remote MCP config.
- New hub tool `request_approval({ action, command?, paths?, reason })` → `PermissionBroker.ask` → `{ allowed: boolean, message }`. Injected for Codex/Grok only. Prompt text for those providers: call it before any write outside the workspace, any network-affecting or destructive shell command.
- **MCP endpoint** (`packages/hub/src/mcp/httpServer.ts`): `@modelcontextprotocol/sdk` `McpServer` + Streamable HTTP transport mounted at `POST /mcp` on the hub server, bearer token per turn (`Authorization: Bearer <turnToken>`) selects that turn's `HubTool[]`. Loopback only. Codex config: `-c mcp_servers.pocketrocket.url=http://127.0.0.1:<port>/mcp -c mcp_servers.pocketrocket.bearer_token_env_var=POCKETROCKET_MCP_TOKEN` (fallback if `-c` injection fails: write a per-run `CODEX_HOME` with `config.toml` that includes the user's auth by symlink/copy of `auth.json`... prefer verifying `-c` first). OpenCode: `mcp.pocketrocket = { type: 'remote', url, headers }` via `OPENCODE_CONFIG_CONTENT`.
- `providers/codex.ts`: `codex exec --json -C <workspace> -m <model> -s workspace-write -a never [resume <thread>]`, system prompt prepended to the first prompt of a thread (short reminder on later turns), JSONL → sink, `turn.completed.usage` → cost via `pricing.ts`. `check()`: `codex --version`, `codex login status`.
- `providers/opencode.ts`: hub spawns one `opencode serve --hostname 127.0.0.1 --port <free>` lazily (env `OPENCODE_CONFIG_CONTENT` with MCP + permission block + `external_directory: ask`), talks over `@opencode-ai/sdk`: session per (bot, room), `prompt_async`, SSE `/event` for text/tool parts and `permission.asked` → `PermissionBroker.ask` → `/session/:id/permissions/:id`. Cost from `step_finish`. `check()`: `opencode --version`, `opencode auth list`; `models()` from `opencode models`.
- `providers/grok.ts`: Grok Build CLI (`grok`) headless. The P2C agent first verifies its headless flags, structured output, MCP config and resume; if the CLI cannot deliver structured output or MCP, fall back to an in-process AI SDK v7 loop (`@ai-sdk/xai`, hub-implemented file/bash tools gated by `PermissionBroker`, JSONL history under `botHome/sessions/`). Decision recorded in `docs/research/grok-cli.md`.
- `providers/registry.ts`: `getProvider(settings.provider)`; `GET /api/providers` → `{ active, providers: [{ id, label, check, models }] }`; `PUT /api/settings`.
- `settings` table (key TEXT PK, value JSON). Keys: `provider`, `defaultModel`, `userName`, `sounds`, `onboarded`, `theme`. Secrets (`XAI_API_KEY`, `OPENAI_API_KEY`) in `data/secrets.json` (env vars override; documented). `USER_NAME` → `settings.userName` (default: OS username).
- Bot `model` validated against the active provider's `models()`; switching provider resets invalid bot models to the provider default (system message in each affected DM).
- Bot tool `create_bot`/`update_bot` model enums become dynamic from the active provider.

### 2. Desktop (`packages/desktop`)

- `tauri.conf.json`: productName `PocketRocket`, identifier `com.pocketrocket.app`, `bundle.externalBin: ["binaries/node"]`, `bundle.resources: { "../../hub/build/": "hub/" }` (contains `hub.mjs` + `node_modules` + `web/` dist), NSIS `installMode: currentUser`, license, installer icon.
- `scripts/fetch-node.mjs`: downloads Node 24 LTS win-x64 zip → `packages/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe` + `NODE-LICENSE`. Cached. `pnpm desktop:prepare` = hub build + web build + fetch-node.
- `packages/hub` build: `tsc --noEmit` + `esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=build/hub.mjs` + `pnpm deploy --prod` for `node_modules` + copy `packages/web/dist` → `build/web`. Hub resolves `WEB_DIST` via `POCKETROCKET_WEB_DIST` when set.
- `lib.rs` `spawn_hub` order: (1) `hubDir` set → dev mode (repo + tsx); (2) system `node -v` ≥ 22.13 → `node <resources>/hub/hub.mjs`; (3) sidecar `node.exe` next to the app exe. Env: `POCKETROCKET_DATA`, `POCKETROCKET_WEB_DIST`, `PORT`, `POCKETROCKET_TOKEN`. Navigate to `http://127.0.0.1:<port>/?desktop=1#token=<hubToken>`.
- Legacy migration on first launch: if `<config>/data` is empty and `%APPDATA%\com.claudebot.desktop\data` exists → copy tree + `config.json`.
- Menu: Connection (Local / Server via SSH / Attach / Settings), View (Reload, Open data folder, Open hub log), Help (Check for updates → Releases page, About with version). Default `sshHost` empty.
- Splash `ui/index.html` rebranded; shows which Node it picked and the log path on error.
- Icons: `scripts/make-icon.mjs` renders `packages/desktop/icon.svg` → `icon-src.png` (1024) → `cargo tauri icon`.

### 3. Web UI (`packages/web`)

- `lib/sounds.ts`: WebAudio synth, lazy `AudioContext` unlocked on first gesture, master gain, `play(cue)` for `send | receive | approvalRequest | approve | deny | done | error | connected`. Off when `settings.sounds === false` or `prefers-reduced-motion`. `receive`/`done` quieter when the room is focused and the tab is visible.
- Cue wiring in `store.ts`: `sendMessage` → send; `message.new` bot text (not own turn delta) → receive; `approval.request` → approvalRequest; `decide` → approve/deny; `turn.end` → done/error; first WS `connected` with `?desktop=1` → connected.
- Settings dialog (gear in sidebar): provider radio cards with live check status + hint, default model, API key fields (Grok/Codex when applicable), your name, sounds toggle, theme.
- Onboarding wizard (`settings.onboarded === false`): Welcome → Provider (runs check; shows install/login instructions; "Re-check" button) → Your name → First bot (3 templates) → Done (plays `connected`). Server-side `PUT /api/settings { onboarded: true }`.
- Bot dialog: model dropdown from `GET /api/providers`.
- Auth token: web reads `#token` from the URL when present (desktop) and sends it as `Authorization` / WS query; browser dev use relies on Origin/Host checks.

### 4. Hardening (production-grade minimum)

- Hub: reject REST/WS requests whose `Origin` is present and not `http://127.0.0.1:<port>` / `http://localhost:<port>` (CSRF from arbitrary sites); validate `Host` (DNS rebinding); optional `POCKETROCKET_TOKEN` bearer check when set (desktop always sets it). Keep 127.0.0.1 bind.
- Graceful shutdown (SIGTERM/SIGINT → stop scheduler, interrupt turns, provider `shutdown()`, close server, SQLite checkpoint).
- Startup log line: version, data dir, provider, node version. `hub.log` rotation (5 × 2 MB) handled by the desktop shell.
- Single version source: root `package.json`; `scripts/version.mjs` syncs `tauri.conf.json`, `Cargo.toml`, hub `VERSION` constant; release workflow asserts tag == version.

### 5. Site (`packages/site`) + README

- Static: `index.html`, `styles.css`, `main.js`, `assets/` (rocket SVG, screenshots, OG image). Same visual language as the app (airy `#F7F7F8`, Geist, black pills, floating panels). Sections: hero + Download for Windows (latest Release) + "runs on your machine"; providers grid (Claude · Codex · OpenCode · Grok, subscription or API key); features; how it works (hub, rooms, memory, skills, routines, approvals); server mode; open source / MIT; SmartScreen note. `vercel.json` clean URLs. Deploy via `vercel` CLI (project `pocketrocket`).
- README: badges, hero screenshot, install (installer / from source), providers table with auth per provider, concepts, permissions by provider, server mode, development, contributing, license. Existing README content restructured, not thrown away.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/bug.yml`, `SECURITY.md` (local-only hub, never expose the port).

### 6. CI/CD (`.github/workflows`)

- `ci.yml`: push/PR → `pnpm install --frozen-lockfile`, `pnpm build` (typecheck + bundle + vite), `pnpm test`, `cargo check` (windows-latest).
- `release.yml`: tag `v*` → same + `desktop:prepare` + `tauri-apps/tauri-action` → NSIS installer attached to the Release with generated notes.

## Phases, owners, parallelism

| Phase | Work | Owner | Depends on |
|---|---|---|---|
| ✅ **P0 Bootstrap** | `git init`, LICENSE, `.gitignore`, rename per naming map, settings table + `userName`, legacy data migration (hub/desktop/deploy), `gh repo create` (private), first commit | Sonnet (rename) + Opus (migration/settings) | — |
| ✅ **P1A Provider core** | Provider interface, `HubTool` refactor, Claude adapter (no behaviour change), `request_approval`, settings/providers REST+WS, HTTP MCP endpoint, hub token/origin checks | Opus | P0 |
| ✅ **P1B Desktop bundling** | hub build pipeline, fetch-node, tauri.conf resources/sidecar, `lib.rs` Node detection + resource paths + legacy migration + menu, splash rebrand, icon set | Opus | P0 |
| ✅ **P1C Web: sounds + settings + onboarding** | `sounds.ts`, cue wiring, settings dialog, onboarding wizard, bot model dropdown (against §1/§3 contract in `packages/shared`) | Sonnet | P0 + shared contract |
| ✅ **P1D Site + docs** | `packages/site`, README rewrite, CONTRIBUTING, CHANGELOG, SECURITY, issue template | Sonnet | P0 |
| ✅ **P2A Codex adapter** | `providers/codex.ts`, JSONL parser, tests with fixture streams + fake CLI; live verification of `-c` MCP injection if Codex is installed | Opus | P1A |
| ✅ **P2B OpenCode adapter** | `providers/opencode.ts` via serve + SDK, permission routing, tests; live smoke with local opencode 1.17 | Opus | P1A |
| ✅ **P2C Grok adapter** | verify Grok Build CLI headless capabilities → `providers/grok.ts` (CLI) or AI SDK fallback; tests | Opus | P1A |
| ✅ **P3 CI + hardening** | workflows, shutdown, log rotation, version script | Sonnet | P1A, P1B |
| ✅ **P4 QA/integration** | typecheck, tests, `pnpm desktop:build`, install NSIS locally, onboarding smoke with Claude + OpenCode, fix loop, screenshots, Vercel deploy, push | Opus | all |
| ⏳ **P5 Handover** | Move dir, update memory, final report | Claude | P4 |

Acceptance for v1: fresh-machine flow works: run installer → app starts hub with bundled Node → onboarding detects Claude CLI login → first bot answers a DM with sound cues → switch provider to OpenCode → bot answers → approval card appears for an out-of-workspace write from either provider. `pnpm test` green, CI green, site live.

## Risks / open items

- Codex CLI not installed locally and needs a ChatGPT login; adapter verified with fixtures + fake CLI, Alex does the live smoke.
- Grok Build CLI capabilities unverified until P2C; xAI key or Grok login needed from Alex for live smoke.
- Non-Claude permission parity is best effort by design (documented in README "Permissions by provider").
- Unsigned installer → SmartScreen warning (documented on site + README).
- Tauri release build ~15 min cold; running `PocketRocket.exe` must be closed before building.
- Hub must run under Node 24 (currently developed on 26); verified in P1B.
