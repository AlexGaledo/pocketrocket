# PocketRocket guide

What PocketRocket does once it's installed, how it works, and what the bots may and may not do.
Setup itself is in the [README](../README.md).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Concepts](#concepts)
- [Permissions & safety](#permissions--safety)
- [Configuration](#configuration)
- [Roadmap](#roadmap)

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
tunnel — see [SERVER.md](SERVER.md).

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

**Auto-memory.** Bots don't have to remember to call `update_memory`: every 10 completed turns of a
bot in a room (per bot, 3–100, or off — Settings → Bots), a background pass on Haiku 4.5 reads the
messages since the last pass and appends new lasting facts (your preferences, decisions, ongoing
work, names/IDs) to `memory.md` under an `## Auto-saved <date>` heading. It is append-only, runs
separately from the bot's session without holding up the room, skips secrets, posts "*Bot* saved N
notes to memory" when it saved anything, and its cost shows up in usage. Claude provider only.

Models: **Sonnet 5** (default), **Opus 5**, **Fable 5.1**, **Haiku 4.5** — picked per bot in the
bot dialog.

## Permissions & safety

See [SECURITY.md](../SECURITY.md) for the token model and the full threat model — treat every bot
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
bypass mode with `POCKETROCKET_BYPASS_PERMISSIONS` (see [CONFIGURATION.md](CONFIGURATION.md)).

The hub always requires a bearer token — every run mode, no exceptions. It's minted on first
start, stored in `<data>/hub-token`, and reused on later starts (so restarting the hub doesn't
lock an open window out), printed as a URL (`http://127.0.0.1:7788/#token=…`); the desktop app and
web UI consume that fragment automatically.

PocketRocket has had two internal security reviews; what they changed is under **Security** in
[CHANGELOG.md](../CHANGELOG.md), and [SECURITY.md](../SECURITY.md) has the summary.

## Configuration

Every environment variable, setting, secret, and server-mode env var — with defaults and
precedence — is documented in [CONFIGURATION.md](CONFIGURATION.md).

## Roadmap

Short and honest:

- **More providers.** OpenAI Codex, OpenCode and Grok adapters exist in the codebase behind a
  dev-only flag but aren't offered as a user-facing option in v1 — Claude only, for now.
- **Paid plans**, behind the optional PocketRocket account. Signing in does nothing else yet.
- **Code signing and an auto-updater** are deliberately out of scope for v1; Help → Check for
  updates just opens the Releases page.
- **macOS / Linux installers.** Both run from source today; no packaged installer yet.
