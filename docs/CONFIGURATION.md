# Configuration reference (v0.1.0)

Four layers, lowest to highest precedence for overlapping keys: **defaults in code** → **`.env` / environment variables** (read once at hub start) → **`data/secrets.json`** (API keys; env var wins if both set) → **settings table** (`PUT /api/settings`, live). The desktop app has its own `config.json` for how it launches the hub.

## 1. Hub environment variables

Read in `packages/hub/src/config.ts` and the provider adapters. Set them in `.env` at the repo root (source runs) or in the process environment (desktop sets the starred ones itself).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` ★ | `7788` | Hub HTTP/WS port, always bound to `127.0.0.1`. |
| `POCKETROCKET_DATA` ★ | `<repo>/data` | Data root: `pocketrocket.db`, `bots/`, `workspace/`, `skills/`, `secrets.json`, `grok-home/`. Desktop: `%APPDATA%\com.pocketrocket.app\data`. |
| `POCKETROCKET_WEB_DIST` ★ | `<repo>/packages/web/dist` | Where the built web UI is served from. Desktop points it at the bundled `hub/web`. |
| `POCKETROCKET_TOKEN` ★ | auto-generated when unset, stored in `<data>/hub-token` | Bearer token required on every `/api/*` route (except `GET /api/health`), `/ws`, and `/screen/*`. When unset, the hub mints a fresh token on each start, writes it to `<data>/hub-token` (0600), and prints it as `http://127.0.0.1:7788/#token=…`. Desktop reads/generates its own per-launch token the same way. There is no unauthenticated mode. |
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
| `MAX_HOPS` | `5` | Bot-to-bot mention hops per thread. |
| `MAX_CONCURRENT_TURNS` | `4` | Turns the hub runs in parallel. |
| `CAUSE_COST_CAP_USD` | `5` | Dollar cap per thread (cause) across bots. |
| `SCREEN_URL` | `http://127.0.0.1:6080` | noVNC endpoint proxied at `/screen/` (server mode). |
| `CDP_URL` | `http://127.0.0.1:9222` | Chromium DevTools endpoint for the Browser tool (server mode). |
| `SCREEN_DISPLAY` | `:99` | X display for the Desktop tool (Linux server mode). |

Internal, set by the hub for child processes (do not set yourself): `POCKETROCKET_MCP_TOKEN` (Codex), `POCKETROCKET_MCP_URL`/`POCKETROCKET_MCP_TOKEN` (Grok), `OPENCODE_SERVER_PASSWORD` + `OPENCODE_CONFIG_CONTENT` (OpenCode serve), `CLAUDE_AGENT_SDK_CLIENT_APP`, `NODE_NO_WARNINGS`. Test-only: `FAKE_CODEX_*`.

Not configurable by env in this version (constants in `config.ts`): `HOST=127.0.0.1`, `APPROVAL_TIMEOUT_MS=10 min`, `MAX_TURNS_PER_QUERY=40`, `USER_SKILLS_DIR=~/.claude/skills`.

## 2. Settings (live, `GET/PUT /api/settings`, stored in the `settings` table)

| Key | Default | Notes |
|---|---|---|
| `provider` | `claude` | `claude` · `codex` · `opencode` · `grok`. Global; switching resets bot models that don't exist on the new provider. |
| `defaultModel` | `claude-sonnet-5` | Model for new bots; must belong to `provider`. |
| `userName` | OS username | How bots address you. |
| `sounds` | `true` | UI sound cues. |
| `onboarded` | `false` | Set to `true` by the wizard; `false` shows it again. |
| `theme` | `system` | `system` · `light` · `dark`. |

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

Systemd units `pocketrocket` and `pocketrocket-screen` run as the unprivileged `pocketrocket` user under `/home/pocketrocket/pocketrocket`; env for the hub lives in the unit file (`PORT`, `POCKETROCKET_DATA`, `SCREEN_*`, `CDP_URL`). `SCREEN_W`/`SCREEN_H` in the screen unit. The hub token applies in server mode too: it is written to `<data>/hub-token` on the VPS; reach the hub only through an SSH tunnel and open the `#token=` URL. VNC password: `<data>/vnc-passwd.txt`.
