# Architecture

## How it works

The hub is a Node process (SQLite, REST, WebSocket) bound to `127.0.0.1`; the React UI is served
from the same process. Each bot turn spawns your own `claude` CLI through the Claude Agent SDK and
resumes that bot's session; bot tools (`send_message`, memory, room management, and the rest) are
exposed to the model over an in-process MCP server. The desktop app is a thin Tauri/WebView2 shell
around that same hub. Server mode runs the identical hub on a Linux box, reachable over an SSH
tunnel — see [Run on a server](SERVER.md).

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
