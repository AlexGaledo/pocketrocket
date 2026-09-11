# Configuration reference (v0.2.0)

Four layers, lowest to highest precedence for overlapping keys: **defaults in code** → **`.env` / environment variables** (read once at hub start) → **`data/secrets.json`** (API keys; env var wins if both set) → **settings table** (`PUT /api/settings`, live). The desktop app has its own `config.json` for how it launches the hub.

## 1. Hub environment variables

Read in `packages/hub/src/config.ts` and the provider adapters. Set them in `.env` at the repo root (source runs) or in the process environment (desktop sets the starred ones itself).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` ★ | `7788` | Hub HTTP/WS port, always bound to `127.0.0.1`. |
| `POCKETROCKET_DATA` ★ | `<repo>/data` | Data root: `pocketrocket.db`, `bots/`, `workspace/`, `skills/`, `secrets.json`, `account.json`, `grok-home/`. Desktop: `%APPDATA%\com.pocketrocket.app\data`. |
| `POCKETROCKET_WEB_DIST` ★ | `<repo>/packages/web/dist` | Where the built web UI is served from. Desktop points it at the bundled `hub/web`. |
| `POCKETROCKET_TOKEN` ★ | auto-generated when unset, stored in `<data>/hub-token` | Bearer token required on every `/api/*` route (except `GET /api/health`), `/ws`, and `/screen/*`. When unset, the hub reuses the token in `<data>/hub-token` (0600), minting and writing one the first time or whenever that file is missing or malformed, and prints it as `http://127.0.0.1:7788/#token=…`. Reuse is what keeps an already-open UI working across a restart. Desktop generates its own per-launch token in `local` mode and reads the remote one over SSH in `remote` mode. There is no unauthenticated mode. |
| `POCKETROCKET_ROTATE_TOKEN` | unset | `1` = mint a brand-new hub token on every start instead of reusing `<data>/hub-token`. Tighter (a leaked token dies with the process) but every restart makes an already-open UI ask you to paste the new one. |
| `POCKETROCKET_SUPABASE_URL` | built-in PocketRocket project | Supabase project URL for the optional PocketRocket account (Settings → Account). Accounts are enabled only when this and `POCKETROCKET_SUPABASE_KEY` both resolve to a value; otherwise the app runs signed out and `GET /api/account` reports `enabled: false`. The hub keeps the session in `<data>/account.json` (owner-only) and deletes it on sign-out. |
| `POCKETROCKET_SUPABASE_KEY` | built-in PocketRocket key | The project's **publishable** (anon) key, public by design. Never a service-role / secret key. |
| `POCKETROCKET_DEBUG` | unset | `1` = log provider CLI stderr and PreToolUse hook decisions. |
| `CLAUDE_EXE` | `~/.local/bin/claude(.exe)` | Path to the Claude Code CLI the Agent SDK spawns. |
| `ANTHROPIC_API_KEY` | unset | Use an API key instead of the Claude Code login. Also settable in Settings → API keys. |
| `OPENAI_API_KEY` | unset | Codex API-key auth (passed to `codex`). Also settable in Settings. |
| `XAI_API_KEY` | unset | Grok API-key auth. Also settable in Settings. |
| `CODEX_EXE` | first `codex` on PATH | Override the Codex CLI path. |
| `OPENCODE_EXE` | first `opencode[.cmd]` on PATH | Override the OpenCode CLI path. |
| `GROK_EXE` | `$GROK_BIN_DIR/grok`, `~/.grok/bin/grok`, PATH | Override the Grok Build CLI path. |
| `GROK_BIN_DIR` | unset | Directory containing the Grok CLI (matches the official installer's variable). |
| `GROK_HOME` | `~/.grok` | The user's own Grok CLI home; PocketRocket reads `auth.json` from it. |
| `POCKETROCKET_GROK_HOME` | `<data>/grok-home` | Isolated Grok home PocketRocket writes its `config.toml` into. |
| `GROK_SANDBOX` | unset | Override the `--sandbox` mode passed to `grok`. |
| `POCKETROCKET_BYPASS_PERMISSIONS` | unset | Unset: the Settings value `approvals` decides (default `ask`) and can be changed live in Settings. Set, it overrides that value and locks it (Settings shows it as set by the server environment): `1` = bypass — no approval cards at all, not even for bot/room changes; the broker allows every tool call, Claude runs in `bypassPermissions`, `request_approval` is not offered, and the Codex (`danger-full-access`), Grok (no sandbox) and OpenCode (all `allow`) sandboxes open up. `0` = ask, the approval flow described in README "Permissions". Any value other than `1`/`true`/`yes`/`on` counts as `0`. |
| `POCKETROCKET_PROVIDERS` | `claude` | Comma-separated providers the hub offers, e.g. `claude,opencode`. v1 ships Claude only; the Codex, OpenCode and Grok adapters are for development. Claude is always included. A disabled provider is never listed, checked, spawned or shut down, `PUT /api/settings` refuses it (400), and an install whose stored `provider` is disabled is moved to Claude at start (bots on a model Claude lacks are reset, with a system message). |
| `MAX_HOPS` | `5` | Bot-to-bot mention hops per thread. |
| `MAX_TURNS_PER_QUERY` | `80` | Steps (model round trips) one run may take. Browser work spends these fast — a navigate, a snapshot and a click are three. The live cost brake is the bot's per-turn budget, not this. |
| `MAX_TURN_CONTINUATIONS` | `2` | Times a run that hit the step limit is resumed to finish the job. Each one is re-checked against the remaining budget and the abort signal. `0` disables. |
| `MAX_CONCURRENT_TURNS` | `4` | Turns the hub runs in parallel. |
| `CAUSE_COST_CAP_USD` | `5` | Dollar cap per thread (cause) across bots. |
| `SCREEN_URL` | `http://127.0.0.1:6080` | noVNC endpoint proxied at `/screen/` (server mode). |
| `CDP_URL` | `http://127.0.0.1:9222` | Chromium DevTools endpoint for the Browser tool (server mode). |
| `SCREEN_DISPLAY` | `:99` | X display for the Desktop tool (Linux server mode). |

Internal, set by the hub for child processes (do not set yourself): `POCKETROCKET_MCP_TOKEN` (Codex), `POCKETROCKET_MCP_URL`/`POCKETROCKET_MCP_TOKEN` (Grok), `OPENCODE_SERVER_PASSWORD` + `OPENCODE_CONFIG_CONTENT` (OpenCode serve), `CLAUDE_AGENT_SDK_CLIENT_APP`, `NODE_NO_WARNINGS`. Test-only: `FAKE_CODEX_*`.

Not configurable by env in this version (constants in `config.ts`): `HOST=127.0.0.1`, `APPROVAL_TIMEOUT_MS=10 min`, `USER_SKILLS_DIR=~/.claude/skills`.

## 2. Settings (live, `GET/PUT /api/settings`, stored in the `settings` table)

| Key | Default | Notes |
|---|---|---|
| `provider` | `claude` | `claude` · `codex` · `opencode` · `grok`, limited to `POCKETROCKET_PROVIDERS` (Claude only by default). Global; switching resets bot models that don't exist on the new provider. |
| `defaultModel` | `claude-sonnet-5` | Model for new bots; must belong to `provider`. |
| `userName` | OS username | How bots address you. |
| `sounds` | `true` | UI sound cues. |
| `onboarded` | `false` | Set to `true` by the wizard; `false` shows it again. |
| `theme` | `system` | `system` · `light` · `dark`. |
| `approvals` | `ask` | `ask` · `bypass`. Read at the start of every turn, so a change applies from the next turn without a restart. Only `PUT /api/settings` writes it; no bot tool can. `POCKETROCKET_BYPASS_PERMISSIONS` overrides and locks it (`PUT` then answers 409); `GET /api/health` reports the mode in force as `approvals` and the lock as `approvalsLocked`. |

## 3. Secrets (`<data>/secrets.json`, `GET/PUT /api/secrets`)

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`. `GET` returns only `{ keys: { NAME: true|false } }`, never values. An environment variable of the same name overrides the file. Empty string deletes.

## 4. Per-bot (bot dialog / `POST|PATCH /api/bots`)

`model`, `allowedTools` (`Read Write Edit Glob Grep Bash WebSearch WebFetch Browser Desktop`), `maxBudgetUsd` per turn (0.05–50, default 2), identity text, skills.

## 5. Desktop app `config.json` (`%APPDATA%\com.pocketrocket.app\config.json`)

| Key | Default | Notes |
|---|---|---|
| `mode` | `local` | `local` (app spawns the hub) · `remote` (`ssh -N -L` tunnel) · `attach` (hub already on the port). |
| `sshHost` | `""` | Host alias from `~/.ssh/config` for `remote`. |
| `port` | `7788` | Hub port for all modes. |
| `hubDir` | unset | Dev override: run the hub from a repo checkout with `tsx` instead of the bundled `hub/hub.mjs`. |

Runtime selection in `local` mode: system Node ≥ 22.13 from PATH (skipping the app's own directory), else the bundled Node 24 next to the exe. Logs: `%APPDATA%\com.pocketrocket.app\hub.log` (rotated at 2 MB × 5).

## 6. Server mode (`deploy/`, `scripts/deploy.sh <host>`)

Systemd units `pocketrocket` and `pocketrocket-screen` run as the unprivileged `pocketrocket` user under `/home/pocketrocket/pocketrocket`; env for the hub lives in the unit file (`PORT`, `POCKETROCKET_DATA`, `SCREEN_*`, `CDP_URL`). `SCREEN_W`/`SCREEN_H` in the screen unit. The hub token applies in server mode too: it is written to `<data>/hub-token` on the VPS; reach the hub only through an SSH tunnel and open the `#token=` URL. The Screen tab has no separate VNC password: `x11vnc` runs `-nopw` on loopback and the hub's `/screen/` cookie auth is the gate.
