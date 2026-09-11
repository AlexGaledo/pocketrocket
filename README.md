# PocketRocket

**Your pocket fleet of AI agents.**

[**Website**](https://pocketrocket-chi.vercel.app) · [Download](https://github.com/AlexGaledo/pocketrocket/releases/latest) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/AlexGaledo/pocketrocket/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexGaledo/pocketrocket/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AlexGaledo/pocketrocket?include_prereleases&label=release)](https://github.com/AlexGaledo/pocketrocket/releases)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-5fa04e)
![Desktop](https://img.shields.io/badge/desktop-Windows-blue)

PocketRocket is a messenger for a fleet of persistent AI agents. Each bot has its own identity,
memory, skills, and routines; bots share one workspace, talk in DMs or group chats, @mention and
hand off work to each other, and ask you for approval before touching anything outside the
workspace. It runs entirely on your machine — a local Node hub plus a React UI — driven by the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) against your own Claude
Code login (or an API key).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/site/assets/app-dark.png" />
  <img alt="PocketRocket: a DM with a bot that writes a file in the workspace, showing the tool step inline, with the room's estimated usage in the right panel." src="packages/site/assets/app.png" />
</picture>

## Contents

- [Status](#status)
- [Download](#download)
- [Quick start](#quick-start)
- [Features](#features)
- [How it works](#how-it-works)
- [Concepts](#concepts)
- [Permissions & safety](#permissions--safety)
- [Desktop app](#desktop-app)
- [Run on a server](#run-on-a-server)
- [Configuration](#configuration)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Status

Pre-release, becoming public at v0.2.0. Hub, rooms, memory, skills, routines and approvals are
working and covered by unit tests — see [CI](https://github.com/AlexGaledo/pocketrocket/actions/workflows/ci.yml)
for the current count. The Windows installer builds and installs but is **unsigned**, so
SmartScreen warns. macOS and Linux run from source; there's no installer for them yet.
Auto-update and code signing are deliberately out of scope for v1.

The hub always requires a token, binds loopback only, and checks `Origin`/`Host`. The pre-release
audit and its remediation are in [`docs/AUDIT-2026-09-09.md`](docs/AUDIT-2026-09-09.md); the full
threat model, and what the permission rules deliberately do *not* protect against, are in
[SECURITY.md](SECURITY.md). Read that before giving a bot the Browser or Desktop tool.

## Download

Latest Windows installer: [GitHub Releases](https://github.com/AlexGaledo/pocketrocket/releases/latest).

The installer is **unsigned**, so Windows SmartScreen will warn "Windows protected your PC." Click
**More info** → **Run anyway**. If you'd rather not click through that, build from source instead
(see [Development](#development)).

## Quick start

1. **Install Claude Code and sign in**, if you haven't already:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   claude    # opens a browser to log in with your Claude subscription
   ```

   An `ANTHROPIC_API_KEY` works instead of a subscription login.

2. **Run the installer** from [Download](#download) above.

3. **Onboarding** walks you through it on first launch: it checks your Claude login, asks your
   name, and helps you create your first bot.

## Features

- **Persistent bots** — identity, private memory and skills that survive restarts.
- **DMs and group chats** — @mention and hand off work between bots in a shared room.
- **Approval cards** — bots ask before shell commands, edits outside the workspace, or fleet/room
  changes; on by default.
- **Skills** — import from your provider's skill directory, author in the UI, or let a bot draft
  one for review.
- **Routines** — wake a bot on a cron schedule to check in or do recurring work.
- **Cost tracking** — spend per bot and per room, with a budget cap per turn.
- **Shared screen** (server mode) — a persistent virtual desktop and browser bots and you both use.
- **Optional account** — sign in for paid plans later; everything works fully signed out.

## How it works

The hub is a Node process (SQLite, REST, WebSocket) bound to `127.0.0.1`; the React UI is served
from the same process. Each bot turn spawns your own `claude` CLI through the Claude Agent SDK and
resumes that bot's session; bot tools (`send_message`, memory, room management, and the rest) are
exposed to the model over an in-process MCP server. The desktop app is a thin Tauri/WebView2 shell
around that same hub. Server mode runs the identical hub on a Linux box, reachable over an SSH
tunnel — see [Run on a server](#run-on-a-server).

## Concepts

| Thing | Where it lives | Notes |
|---|---|---|
| Bot | `data/pocketrocket.db` + `data/bots/<id>/` | `CLAUDE.md`-style identity file, `memory.md` = private memory (injected every turn), `plugin/` = assigned skills |
| Workspace | `data/workspace/` | Shared cwd for every bot. The folder button in the sidebar opens it on whichever computer the hub runs on: Explorer or Finder locally, the file manager on the virtual desktop for a server hub |
| DM | room kind `dm` | Bot always replies |
| Group chat | room kind `group`, 1–6 bots | Only @mentioned bots reply. No mention → coordinator bot (if set). Bots can @mention each other; max 5 hops per thread, $5 cost cap per thread |
| Session | one Claude Agent SDK session per (bot, room) | Resumed each turn; reset from the Memory tab |
| Skill pool | `data/skills/<name>/SKILL.md` | Import from Claude Code's skill directory, author in the UI, or let a bot `save_skill` (goes to review first) |
| Routine | cron in DB | Wakes a bot with a prompt in a room while the hub runs |

Custom tools every bot gets: `send_message`, `handoff`, `update_memory`, `read_memory`, `save_skill`,
`list_bots`, `read_room`, and full team CRUD: `create_bot`, `update_bot`, `delete_bot` (any bot,
including itself, `confirm: true` required), `create_room`, `list_rooms`, `delete_room`,
`add_to_room`, `remove_from_room` (all room tools take an optional `room` so a bot can manage any
room, not just the one it's replying in). A coordinator can recruit its own specialists, put them
in a group chat of its own making, retune them, and retire them ("create a researcher and a
writer, start a room with them, then draft the post"). Limits: 50 bots per account, 6 per room.
The system prompt tells bots not to delete or rewrite a bot unless you asked.

Models: **Sonnet 5** (default), **Opus 5**, **Fable 5.1**, **Haiku 4.5** — picked per bot in the
bot dialog.

## Permissions & safety

See [SECURITY.md](SECURITY.md) for the token model and the full threat model — treat every bot
like a contractor with a shell on your machine, not a sandboxed toy.

**Approvals ask by default.** Bots ask before shell commands, edits outside the workspace, and any
fleet or room change (creating/editing a bot, changing its tool grants, creating/deleting a room).
Approval cards appear inline in chat:

- `Read/Glob/Grep` inside `data/workspace/` or the bot's home: silent. Outside: an approval card.
- `Write/Edit` inside the workspace: auto-accepted. Outside: approval card.
- `Bash`: an allowlist of read-only/build commands runs silently; anything else asks, and
  destructive patterns (`rm -rf`, `git push`, `curl | sh`, …) are flagged red. Absolute paths
  outside the workspace always ask.
- `WebSearch/WebFetch`: silent when enabled for the bot.
- "Allow for this session" adds a permission rule for the rest of that session; unanswered
  approvals time out as a deny after 10 minutes.

Settings → Bots → **Approvals** can switch a bot to **bypass mode** — run every tool call with no
approval cards — a clearly-labelled opt-in with no undo. Server operators can pin the whole hub to
bypass mode with `POCKETROCKET_BYPASS_PERMISSIONS` (see [Configuration](#configuration)).

The hub always requires a bearer token — every run mode, no exceptions. It's minted on first
start, stored in `<data>/hub-token`, and reused on later starts (so restarting the hub doesn't
lock an open window out), printed as a URL (`http://127.0.0.1:7788/#token=…`); the desktop app and
web UI consume that fragment automatically. If you're running with `pnpm start`, either copy that
printed URL or read the token straight from `<data>/hub-token`.

Tests: `pnpm test` (vitest in the hub). Debug a subprocess with `POCKETROCKET_DEBUG=1`.

## Desktop app

`packages/desktop` is a small native window (WebView2, Tauri) with three ways to run, switchable
from its **Connection** menu:

| Mode | What happens | State lives in |
|---|---|---|
| **Local: this PC** (default) | The app starts its own hub as a child process and shuts it down on quit. No network hop. | `%APPDATA%\com.pocketrocket.app\data\` — SQLite db (WAL), bot memories, workspace, skills. `hub.log` next to it. |
| **VPS over SSH tunnel** | Opens an SSH tunnel to the hub on your server itself, waits for it, and respawns the tunnel if it drops. Gets the virtual desktop/screen. | on the VPS |
| **Attach** | Connects to a hub you already run (`pnpm dev` / `pnpm start`). | wherever that hub points |

Node runtime: the desktop app looks for a system Node ≥ 22.13 on `PATH` first; if none is found,
it falls back to a Node 24 LTS binary bundled with the installer, so the app works out of the box
even with no Node installed.

```bash
pnpm desktop:build      # -> packages/desktop/src-tauri/target/release/PocketRocket.exe
                        #    + bundle/nsis/PocketRocket_<version>_x64-setup.exe
pnpm desktop:dev
```

### Uninstalling

Apps & features → PocketRocket → Uninstall. The installer is per-user and installs nothing but the
app folder and its shortcuts: no Windows service, no scheduled task, no autostart entry, nothing
outside your own user profile.

**Your data is deliberately left behind.** Uninstalling removes the program, not
`%APPDATA%\com.pocketrocket.app\` — the SQLite database, every bot's memory and skills, the shared
workspace, `hub-token`, and `hub.log`. Reinstalling picks up exactly where you left off. To erase
it too, delete that folder by hand after uninstalling.

## Run on a server

The hub is the shared computer: run it on a Linux box and every bot works there, routines fire
while your laptop is closed, and a full Linux shell is available to bots.

```bash
# once, on the VPS: install Node 22.13+, pnpm, and the Claude CLI
scripts/deploy.sh <host>            # creates the `pocketrocket` user, uploads, installs, builds, (re)starts both systemd units
ssh -L 7788:127.0.0.1:7788 <host>   # then open the token URL printed by the hub (see below)
```

Everything runs as an unprivileged `pocketrocket` system user, not root; `deploy/setup-vps.sh`
creates it the first time. Log the Claude CLI in **as that user**, since that is who runs it:

```bash
sudo -u pocketrocket -H claude
```

The service (`/etc/systemd/system/pocketrocket.service`) binds `127.0.0.1:7788` only and requires
the hub token like every other mode: read it with
`sudo cat /home/pocketrocket/pocketrocket/data/hub-token` and open
`http://127.0.0.1:7788/#token=<token>` through the tunnel. **Never expose the port directly**;
reach it over an SSH tunnel or Tailscale. Data lives in `/home/pocketrocket/pocketrocket/data/` on
the VPS. Logs: `journalctl -u pocketrocket -f`.

### Screen: a persistent desktop the bots and you share

`deploy/setup-vps.sh` (run by `scripts/deploy.sh`) installs Xvfb + XFCE + x11vnc + noVNC +
xdotool/scrot + a pinned Playwright Chromium, and starts `pocketrocket-screen.service`, also as
`pocketrocket`, not root.

What persists (all under `data/`, backed up daily to `/var/backups/pocketrocket`, 7 kept):

- `data/workspace`: the desktop folder itself (Desktop/Downloads/Documents point here)
- `data/desktop-home`: XFCE settings, panel layout, app config, and the X auth cookie
- `data/browser-profile`: Chrome logins, cookies, history
- `data/pocketrocket.db`, `data/bots/<id>` (memory), `data/skills`

Using it: the hub proxies noVNC at `/screen/`, so the same SSH tunnel is enough. Open the
**Screen** tab — there's no separate VNC password: `x11vnc` runs `-nopw` on loopback only, and the
hub's `/screen/` cookie auth (bought with the hub token you're already signed in with) is the
gate — then click inside to use the desktop and log into accounts in Chrome once. A **Browser**
tool (Playwright MCP over CDP, loopback-only) gives bots fast, precise control of that logged-in
Chrome. A **Desktop** tool gives bots full computer use (screenshot, click, type, key, scroll,
launch apps) for anything Browser can't reach; slower and costlier (about 1.2k tokens per
screenshot), so bots are told to prefer shell, file and Browser tools first. Neither tool goes
through approval cards, so only give them to bots you trust with the logged-in sessions on that
machine.

Ops: `systemctl status pocketrocket-screen`, `journalctl -u pocketrocket-screen -f`. Restore a
backup: stop both services, untar into `/home/pocketrocket/pocketrocket`, `chown -R
pocketrocket:pocketrocket` it, start them again.

## Configuration

Every environment variable, setting, secret, and server-mode env var — with defaults and
precedence — is documented in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Development

```text
packages/shared    models + WS/REST schemas (zod)
packages/hub        Node hub:
                       db/                 SQLite schema + migrations
                       agent/              BotRunner, PromptBuilder, botTools
                       providers/          claude.ts, registry.ts (Codex/OpenCode/Grok exist behind
                                            a dev-only flag; see CONTRIBUTING.md)
                       rooms/              RoomRouter, mentions
                       permissions/        PermissionBroker, pathRules, bashRules
                       services/           Memory, Skill, Routine, Usage
                       api/                REST + WS
packages/web         Vite + React + Tailwind + Zustand UI
packages/desktop     Tauri shell (Rust + WebView2)
packages/site        static landing page (this repo's README lives at the root; the site is deployed separately)
scripts/             smoke.mjs (DM), group-smoke.mjs (3-bot room) — run against a live hub:
                       cd packages/hub && node ../../scripts/smoke.mjs "your message"
```

Requirements: Node ≥ 22.13 (uses built-in `node:sqlite`), pnpm.

```bash
pnpm install
pnpm dev             # hub (tsx watch) + Vite UI at http://127.0.0.1:5173
pnpm build            # typecheck + build every package
pnpm start            # hub serves the built UI at http://127.0.0.1:7788
pnpm test             # vitest, run before every PR
```

Building the desktop app additionally requires Rust (MSVC toolchain), Visual Studio Build Tools,
WebView2 (bundled with Windows 11), and `cargo tauri` — see [Desktop app](#desktop-app) for the
build commands.

Debug a subprocess with `POCKETROCKET_DEBUG=1`.

## Roadmap

Short and honest:

- **More providers.** OpenAI Codex, OpenCode and Grok adapters exist in the codebase behind a
  dev-only flag but aren't offered as a user-facing option in v1 — Claude only, for now.
- **Paid plans**, behind the optional PocketRocket account. Signing in does nothing else yet.
- **Code signing and an auto-updater** are deliberately out of scope for v1; Help → Check for
  updates just opens the Releases page.
- **macOS / Linux installers.** Both run from source today; no packaged installer yet.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 Alex Galedo
