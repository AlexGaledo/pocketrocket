<p align="center"><img src="packages/site/assets/rocket.svg" alt="PocketRocket logo" width="96" height="96" /></p>

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
(see [CONTRIBUTING.md](./CONTRIBUTING.md)).

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
bypass mode with `POCKETROCKET_BYPASS_PERMISSIONS` (see
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)).

The hub always requires a bearer token — every run mode, no exceptions. It's minted on first
start, stored in `<data>/hub-token`, and reused on later starts (so restarting the hub doesn't
lock an open window out), printed as a URL (`http://127.0.0.1:7788/#token=…`); the desktop app and
web UI consume that fragment automatically.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — how the hub works, the concepts (bots, rooms, sessions,
  skills, routines), the tools every bot gets, and auto-memory.
- [Desktop app](docs/DESKTOP.md) — the three connection modes, where your data lives, building it
  yourself, and uninstalling.
- [Run on a server](docs/SERVER.md) — deploy to a Linux box, and the persistent shared desktop
  bots and you both use.
- [Configuration](docs/CONFIGURATION.md) — every environment variable, setting and secret, with
  defaults and precedence.
- [Security](SECURITY.md) — threat model and what the permission rules do not protect against.

## Roadmap

Short and honest:

- **More providers.** Claude only, for now.
- **Paid plans**, behind the optional PocketRocket account. Signing in does nothing else yet.
- **Code signing and an auto-updater** are deliberately out of scope for v1; Help → Check for
  updates just opens the Releases page.
- **macOS / Linux installers.** Both run from source today; no packaged installer yet.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © 2026 Alex Galedo
