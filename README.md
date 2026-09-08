# PocketRocket

A local, Grok Bot–style messenger for a fleet of persistent Claude agents. Each bot has its own identity, memory, skills, and routines; bots share one workspace, talk in DMs or group chats, @mention and hand work to each other, and ask you for approval before touching anything outside the workspace.

Runs entirely on your machine: a Node hub on `127.0.0.1:7788` + a React UI. Uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) driving your installed `claude` CLI, so it authenticates with your existing Claude Code login (no API key needed; set `ANTHROPIC_API_KEY` in `.env` if you prefer).

## Quick start

```bash
pnpm install
pnpm dev          # hub (tsx watch) + Vite UI at http://127.0.0.1:5173
# or production-ish:
pnpm build && pnpm start   # hub serves the built UI at http://127.0.0.1:7788
```

Requirements: Node 26+ (uses built-in `node:sqlite`), pnpm, Claude Code CLI installed and logged in (`claude --version` works). Windows path to the CLI defaults to `~/.local/bin/claude.exe`; override with `CLAUDE_EXE` in `.env`.

## Concepts

| Thing | Where it lives | Notes |
|---|---|---|
| Bot | `data/pocketrocket.db` + `data/bots/<id>/` | `CLAUDE.md` = identity, `memory.md` = private memory (injected every turn), `plugin/` = assigned skills |
| Workspace | `data/workspace/` | Shared cwd for every bot. File tools auto-allowed here; anything outside prompts you |
| DM | room kind `dm` | Bot always replies |
| Group chat | room kind `group`, 1–6 bots | Only @mentioned bots reply. No mention → coordinator bot (if set). Bots can @mention each other; max 5 hops per thread, $5 cost cap per thread |
| Session | one SDK session per (bot, room) | Resumed each turn; reset from the Memory tab |
| Skill pool | `data/skills/<name>/SKILL.md` | Import from `~/.claude/skills`, author in UI, or let a bot `save_skill` (goes to review first) |
| Routine | cron in DB | Wakes a bot with a prompt in a room while the hub runs |

Custom tools every bot gets: `send_message`, `handoff`, `update_memory`, `read_memory`, `save_skill`, `list_bots`, `read_room`, and full team CRUD: `create_bot`, `update_bot`, `delete_bot` (any bot, including itself, `confirm: true` required), `add_to_room`, `remove_from_room`. A coordinator can recruit its own specialists ("create a researcher and a writer, then draft the post"), retune them, and retire them. Limits: 50 bots per account, 6 per room. The system prompt tells bots not to delete or rewrite a bot unless you asked.

## Cost notes

- Bots default to `claude-sonnet-5`; change per bot. The CLI's default model is far more expensive.
- Bots run with `settingSources: []`, so none of your `~/.claude` settings, plugins, or skills load unless you import them into the pool.
- Each turn is a fresh CLI process resuming the session; the Claude Code system prompt (~35k tokens) is prompt-cached, so follow-ups are cheap (~$0.01–0.05 on Sonnet).
- A bot that has nothing to add replies `NO_REPLY`, which the hub swallows.

## Layout

```
packages/shared   models + WS/REST schemas (zod)
packages/hub      Node hub: db/, agent/ (BotRunner, PromptBuilder, botTools), rooms/ (RoomRouter, mentions),
                  permissions/ (PermissionBroker, pathRules, bashRules), services/ (Memory, Skill, Routine, Usage), api/
packages/web      Vite + React + Tailwind + Zustand UI
scripts/          smoke.mjs (DM), group-smoke.mjs (3-bot room) — run from packages/hub against a live hub:
                  cd packages/hub && node ../../scripts/smoke.mjs "your message"
```

## Permissions, precisely

- `Read/Glob/Grep` inside `data/workspace/` or the bot's home: silent. Outside: an approval card (a `PreToolUse` hook escalates them, since Claude Code otherwise never asks for reads).
- `Write/Edit` inside the workspace: auto-accepted (`acceptEdits`). Outside: approval card.
- `Bash`: an allowlist of read-only/build commands runs silently; anything else asks, and destructive patterns (`rm -rf`, `git push`, `curl | sh`, …) are flagged red. Absolute paths outside the workspace always ask.
- `WebSearch/WebFetch`: silent when enabled for the bot.
- "Allow for this session" adds the SDK's suggested permission rule for the rest of that session; approvals time out after 10 minutes as a deny.

Tests: `pnpm test` (vitest in hub). Debug the CLI subprocess with `POCKETROCKET_DEBUG=1`.

## Deploy to a VPS (always-on "cloud computer")

The hub is the shared computer: run it on a Linux box and every bot works there, routines fire while your laptop is closed, and `claude`'s Linux sandboxing is available.

```bash
# once, on the VPS: install Node 22.13+, pnpm, Claude Code CLI (`curl -fsSL https://claude.ai/install.sh | bash`), then `claude` to log in
scripts/deploy.sh <host>        # upload, install, build, (re)start the systemd unit
ssh -L 7788:127.0.0.1:7788 <host>   # then open http://127.0.0.1:7788
```

The service (`/etc/systemd/system/pocketrocket.service`) binds `127.0.0.1:7788` only. Reach it over an SSH tunnel or Tailscale; never expose the port directly, the hub has no auth. Data lives in `~/pocketrocket/data/` on the VPS. Logs: `journalctl -u pocketrocket -f`.

## Screen: a persistent desktop the bots and you share (Grok Bot "computer")

On the VPS, `deploy/setup-vps.sh` (run by `scripts/deploy.sh`) installs Xvfb + XFCE (xfwm4, panel, desktop, Thunar, terminal, Mousepad) + x11vnc + noVNC + xdotool/scrot + a Playwright Chromium, and starts `pocketrocket-screen.service`.

What persists (all under `data/`, backed up daily to `/root/pocketrocket-backups`, 7 kept, cron in `/etc/cron.daily/pocketrocket-backup`):
- `data/workspace` — the desktop folder itself (Desktop/Downloads/Documents all point here). Bots' files appear on the desktop.
- `data/desktop-home` — XFCE settings, panel layout, app config.
- `data/browser-profile` — Chrome logins, cookies, history.
- `data/pocketrocket.db`, `data/bots/<id>` (memory), `data/skills`.

Using it:
- Hub proxies noVNC at `/screen/` (HTTP + WebSocket), so the SSH tunnel is enough. Open the **Screen** tab or the monitor icon in the chat header; click inside to use the desktop, log into accounts in Chrome once.
- **Browser** tool on a bot = Playwright MCP over CDP into that Chrome: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, … Fast and precise for web work in your logged-in sessions.
- **Desktop** tool on a bot = computer use on the whole screen: `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_launch` (terminal, file manager, editor, image viewer, `xdg-open`). Every action returns a fresh screenshot. Slower and costlier than Browser/Bash (each screenshot ~1.2k tokens); the prompt tells bots to prefer shell/file tools and reach for the desktop only for GUI apps.
- Neither Browser nor Desktop actions go through approval cards (they would fire on every click). The system prompt forbids destructive account actions unless explicitly instructed. Only give these tools to bots you trust with the logged-in sessions on that machine. Chrome runs as root with `--no-sandbox`; treat the desktop as a shared work machine, not your personal one.
- Locally on Windows there is no screen service; the tab shows "not running". `SCREEN_URL`, `CDP_URL`, `SCREEN_DISPLAY` in `.env` can point at another noVNC/Chromium/X display.

Ops: `systemctl status pocketrocket-screen`, `journalctl -u pocketrocket-screen -f`. Resolution via `SCREEN_W`/`SCREEN_H` in the unit. Redeploys leave the screen running unless `deploy/screen.sh` or the unit changed. Restore a backup: stop both services, untar into `/root/pocketrocket`, start them.

## Desktop app (Windows, Tauri)

`packages/desktop` is a small native window (WebView2, ~6 MB) with three ways to run, switchable from its **Connection** menu:

| Mode | What happens | State lives in |
|---|---|---|
| **Local: this PC** (default) | The app starts its own hub as a child process (`node` + `tsx` from this repo) and shuts it down on quit. No network hop. | `%APPDATA%\com.pocketrocket.desktop\data\` — SQLite db (WAL), bot memories, workspace, skills. `hub.log` next to it. |
| **VPS over SSH tunnel** | Opens `ssh -N -L 7788:127.0.0.1:7788 <host>` itself, waits for the hub, respawns the tunnel if it drops. Gets the virtual desktop/screen. | on the VPS |
| **Attach** | Connects to a hub you already run (`pnpm dev` / `pnpm start`). | wherever that hub points |

Menu: Connection → mode / settings; View → Reload (F5), Open data folder, Quit. Settings file: `%APPDATA%\com.pocketrocket.desktop\config.json` (`mode`, `sshHost`, `port`, optional `hubDir` if the repo moved).

```bash
pnpm desktop:build      # -> packages/desktop/src-tauri/target/release/pocketrocket-desktop.exe
                        #    + bundle/nsis/PocketRocket_0.1.0_x64-setup.exe
pnpm desktop:dev
```

Requirements to build: Rust (MSVC), VS Build Tools, WebView2 (in Windows 11), `cargo tauri`. To run Local mode: Node.js on PATH plus this repo with `pnpm install` done (the app runs the hub from it). To run VPS mode: OpenSSH `ssh` with a key-auth entry for the host in `~/.ssh/config`.
