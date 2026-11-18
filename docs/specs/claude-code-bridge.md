# Claude Code bridge: local sessions, the VPS and one assistant

Status: draft spec, 2026-11-18. Owner interview answers are in section 1; open questions in section 10.

The owner codes mostly in Claude Code in a local terminal, inside repos on the PC. This spec makes those sessions part of PocketRocket: every local session is visible in the app, can read and post to rooms, can be started or continued from the app, and can move to the VPS (same conversation) when many agents run at once. @persona, the owner's assistant, sees all of it and routes work between the PC, the VPS and API providers. Shared notes stay correct when several agents and the owner write to them.

## 1. Owner decisions (2026-11-18, don't re-ask)

| Question | Answer |
| --- | --- |
| How local sessions connect | All four: mirror into the app, talk to rooms from the terminal, the app drives the PC, move a session to the VPS |
| Which local sessions are mirrored | **Everything** (visibility rules in 6.4 keep room bots from seeing what is not theirs) |
| Repo sync when a session moves | **Both** modes, chosen per repo: push a `wip/` branch, or a git bundle over SSH. Owner asked about security: answered in 7 |
| Rooms with several repos | Must be supported (section 5) |
| PC actions | **Approve each run**, as today. Runner stays manual on/off |
| Move to VPS | **Same conversation**: the Claude Code session file moves and resumes |
| Context integrity | All four: overwrites, stale context, provenance, leaks between rooms |
| The assistant | The existing assistant: **@persona** (`settings.personaBotId`, shown as "Your assistant") |

## 2. What exists today

- **PC runner** (`%LOCALAPPDATA%\PocketRocketRunner`): outbound `ssh -L 7789`, polls the hub, runs `claude -p` in folders whitelisted in its `config.json`. Every job is a `run_on_pc` card that only a password-signed-in browser can allow. Manual on/off shortcuts.
- **Key registry** (`data/key-registry.json`) and `where_to_run({needs})`: a fixed rule picks vps, pc or blocked; tier 3 keys are PC-only.
- **Rooms**: one SDK session per (bot, room); coordinator per group room; hand-off notes; `read_room`, `send_message`.
- **Project folders** (`data/projects/<slug>/`): members, `current.md`, FTS5 search, room files rule (files made for a room live in the room).
- **@persona** has `read_owner_messages` across every chat, granted only through `personaBotId`.
- **Context import** (`scripts/context-import.mjs`): one-way file pushes from the PC over an SSH tunnel.

Missing: local Claude Code sessions are invisible to the hub; nothing on the PC can read or post to a room; shared files have no versioning or authorship; bots on the VPS share one Linux user, so folder membership is a rule on tool calls, not a wall.

## 3. Pieces

```
 PC                                              VPS (crm-agency)
 ┌──────────────────────────────┐   ssh -L 7789  ┌──────────────────────────────────┐
 │ Claude Code sessions (terminal)│◄────────────►│ hub :7788                          │
 │   └ pocketrocket MCP (stdio) ──┼── runner ───►│  rooms · projects · revisions      │
 │ PocketRocket runner            │              │  PC sessions (mirror)              │
 │   ├ mirror: ~/.claude/projects │              │  @persona (all rooms + mirror)     │
 │   ├ jobs: run / resume claude  │              │  offload workers (resumed sessions)│
 │   └ repo sync: wip push/bundle │              │  repo copies per project           │
 └──────────────────────────────┘              └──────────────────────────────────┘
```

Everything on the PC goes through the existing runner and its tunnel: one pairing, one place to turn off.

### 3.1 Mirror (PC → app)

- The runner watches `~/.claude/projects/**/*.jsonl` and streams new lines to `POST /api/pc-sessions/:id/lines` (batched, resumable by byte offset).
- Each PC session record: session id, machine name, cwd, git repo (remote URL, branch, HEAD), first/last activity, title (first user prompt), status (`local`, `on-vps`, `ended`).
- Lines are redacted on the PC (same rules as context import: credentials, emails, PH phone and ID numbers) and again on the hub (`redact()` + known secrets) before storage.
- App: a **PC sessions** list (by repo, newest first) and a read-only transcript view. Tool calls collapsed by default.
- Mirror is on whenever the runner is on. The runner tray/shortcut gets "Pause mirror".

### 3.2 Claude Code MCP server (terminal → rooms)

A stdio MCP server shipped with the runner, added once with `claude mcp add pocketrocket -- <runner>\mcp.cmd`. It talks to the hub through the runner's tunnel with the runner's pairing, never with the hub token.

| Tool | Does |
| --- | --- |
| `list_rooms` | Rooms the owner is in, with linked repos |
| `read_room` | Recent messages of a room (same paging as the bot tool) |
| `post_to_room` | Posts as **"Alex via Claude Code (\<repo\>)"**, a distinct sender kind, so bots see it is the owner's session, not a bot |
| `read_state` | The room/project state header (6.2): `current.md` + open decisions + version |
| `read_file` / `write_file` | Project and room files, versioned (6.1). `write_file` requires `base_version` |
| `log_decision` | Appends to the project decision log with provenance |
| `handoff` | Posts a hand-off (summary, todo, links to this session's mirror) to a room and @mentions a bot |

Owner's own session, so no approval cards for these; writes are still versioned and attributed.

### 3.3 App drives the PC

- `run_on_pc` gains `mode: "new" | "resume"` and `session_id`. Resume runs `claude -p --resume <id>` in that session's cwd; new runs in a linked repo path.
- Who can ask: the owner from the app (PC sessions view, "Continue on PC"), @persona, and bots in a room whose project links that repo.
- **Every run is a card** (owner decision), allowed only from a password-signed-in browser, as today. The card shows repo, branch, mode, prompt, keys needed.
- Output streams back into the mirror, so a resumed run appears in the same transcript.

### 3.4 Move a session to the VPS (same conversation)

1. Owner clicks **Move to VPS** on a PC session (or @persona proposes it; card).
2. Runner syncs every repo the session touched (per-repo mode, section 5), then uploads the session `.jsonl`.
3. Hub rewrites path fields in the file (PC cwd → VPS repo path), places it where the Claude CLI on the VPS looks for that cwd, and starts an **offload worker**: a bot turn resumed from that session (`resume: <id>`), in the room the repo is linked to, with that project's tools and membership.
4. PC session is marked `on-vps`. The runner refuses to `--resume` it locally and the MCP server warns in the terminal if the owner tries, until it is pulled back (two copies of one conversation would split).
5. **Pull back**: worker stops at a turn boundary, hub returns the updated `.jsonl` (paths rewritten back), runner fetches the repo changes the same way they went out, session is `local` again.

Model and cost: offload workers run on the VPS Claude login like other bots. The resumed transcript can be large: the token-efficiency rule (rotate past 120k) applies, with a summary hand-off instead of a cut.

## 4. @persona as the assistant

Granted only through `personaBotId` (no bot tool can change it), like `read_owner_messages` today:

| Tool | Does |
| --- | --- |
| `read_any_room` | Read any room, including ones it is not a member of |
| `list_pc_sessions` / `read_pc_session` | The mirror, all of it |
| `where_to_run` | Existing rule, plus "offload" when the PC is busy |
| `dispatch` | Post a task into a room and @mention a bot (attributed "via @persona") |
| `propose_pc_run` / `propose_move` | Raise the cards in 3.3 and 3.4; it cannot allow them |

Persona never writes into a room's files directly; it posts tasks or hand-offs. What it learns from one room must not be pasted into another room unless the owner asks (prompt rule plus the leak check in 6.4).

## 5. Rooms with several repos

- A project has a **repo list**: `data/projects/<slug>/repos.json`, owner-edited in Settings › Projects.

```json
{
  "repos": [
    { "name": "app", "pc": "C:\\Users\\alex\\desktop\\wika-frontend-expo", "vps": "repos/wika-frontend-expo",
      "remote": "git@github.com:org/wika-frontend-expo.git", "sync": "wip-branch", "protected": ["main", "staging"] },
    { "name": "api", "pc": "C:\\Users\\alex\\desktop\\wika-saas", "vps": "repos/wika-saas",
      "sync": "bundle", "env": "none" }
  ]
}
```

- A room links to a project (or several). Its bots see the union of those projects' repos.
- The mirror maps a PC session to repos by cwd and by files it touched, so one session can belong to two repos of one project.
- Moving a session syncs every repo it touched, each in its own mode.
- `protected` branches: bots cannot push to them (existing safe-shipping hook generalised to this list).

## 6. Context integrity

### 6.1 Overwrites: versioned writes

- Every project and room file written through the hub (bot tools, MCP, API) carries a version (content hash + revision number). Writes send `base_version`; a stale base returns **409** with the current text and a diff, and the writer must re-read and merge.
- Bots' raw `Write`/`Edit` on those folders go through the same check in a `PreToolUse` hook (hash of the file when the bot last read it in this turn vs now).
- `current.md` gets sections with their own versions, so two agents updating different sections do not collide.
- **Decision log** (`decisions.md`): append-only through `log_decision`; never edited in place. A changed decision is a new entry that supersedes an older id.

### 6.2 Stale context: a state header every turn

- At the start of every bot turn in a project room (and on `read_state` from the terminal), the hub injects a short **state header**: `current.md` version and its "Now" section, the last 5 decisions, open hand-offs, which sessions are active on which repo (PC or VPS).
- A write whose `base_version` is older than the header the agent was given is refused (6.1), so an agent cannot act on a state it never saw.

### 6.3 Provenance

- New table `file_revisions`: path, revision, hash, author kind (`owner`, `owner-cc` for a terminal session, `bot`, `persona`, `offload`), author id, machine (`pc`/`vps`), session id, room, time, sources (URLs or file paths the writer cited).
- App: file view shows "last changed by … from … in …" and a history list with diffs.
- Research results (from @researcher, @paper-scout and terminal sessions) must cite sources; `write_file` in a research folder without `sources` is refused.

### 6.4 Leaks between rooms

Two layers:

1. **Visibility in the hub** (cheap, first): mirrored PC sessions, room files and project files are visible to a bot only if its room links the project that owns the repo/folder. Owner and @persona see everything. `read_room`, file tools and search filter by this.
2. **A real wall on the VPS** (needed before client repos move there): today all bots run as the `pocketrocket` Linux user, so any bot with Bash can read any folder. Run each bot turn's tools inside a sandbox that only mounts its own projects (bubblewrap with bind mounts; Ubuntu 24.04 allows it through its AppArmor profile). Spike first: Agent SDK spawn inside `bwrap`, Playwright and the screen stack still working, cost per turn.

Until layer 2 ships, repos marked `"client": true` stay PC-only: Move to VPS is refused for sessions that touch them.

## 7. Security of repo sync (owner question)

| Risk | wip branch | bundle | Mitigation |
| --- | --- | --- | --- |
| Secrets committed by mistake reach GitHub | Yes | No | Runner scans the outgoing diff (key patterns, `.env*`, `*.pem`, `*.p8`) and refuses to push; `.env` never committed |
| Env files on the VPS | Only if copied | Only if copied | Per repo `"env": "none" \| "copy"`, default none. Copied env files are 0600 inside that project's folder; tier 3 keys never leave the PC (key registry) |
| A bot pushes to main | Possible today | n/a | `protected` list + hook; offload workers push only to `wip/<machine>/<session>` |
| Another room's bot reads the repo copy | Yes (shared Linux user) | Yes | 6.4 layer 2; until then client repos stay PC-only |
| Tunnel misuse | — | — | Runner keeps outbound-only SSH, pairing key, manual on/off; MCP uses the runner's pairing, not the hub token |
| Stale or diverged copies | Branch shows divergence | Bundle can drift | Move refuses if the PC repo has unpushed changes the bundle/branch missed; pull-back fast-forwards or stops for the owner |

Short answer for the owner: wip branches risk GitHub exposure (handled by the pre-push scan and no `.env`), bundles avoid GitHub but put a full copy on the VPS. On the VPS today the real risk is shared access between bots, which section 6.4 fixes.

## 8. Phases

| Phase | Ships | Depends on | Owner |
| --- | --- | --- | --- |
| P1 | Versioned writes, decision log, provenance table (6.1, 6.3) | — | pr-backend |
| P2 | Claude Code MCP server through the runner (3.2) + state header (6.2) | P1 | pr-backend, pr-infra |
| P3 | Mirror (3.1) + PC sessions view + hub visibility rules (6.4 layer 1) | P2 | pr-infra, pr-backend, pr-design-system |
| P4 | @persona grants (4) + app drives PC: new/resume (3.3) | P3 | pr-backend |
| P5 | Repo lists and sync modes with pre-push scan (5, 7) | P1 | pr-infra |
| P6 | Move to VPS and pull back (3.4), non-client repos only | P4, P5 | pr-infra, pr-backend |
| P7 | Sandbox spike, then per-turn sandbox (6.4 layer 2); unlocks client repos on the VPS | — (spike can start any time) | pr-infra |

P1-P2 give the biggest win first: terminal sessions and bots share correct, attributed notes.

## 9. Tests that prove it

- P1: two writers race on `current.md`; one gets 409 with a diff, nothing lost. Decision log edit in place is refused.
- P2: from a real terminal session, `post_to_room` appears as "Alex via Claude Code"; a bot in that room answers; a stale `write_file` is refused.
- P3: a secret typed into a terminal session never reaches the hub DB (canary); a bot in an unrelated room cannot see a mirrored session.
- P4: @persona proposes a resume; the card cannot be allowed with the hub token; allowed from the browser, output lands in the same mirror transcript.
- P6: move a session mid-task, worker continues with full memory of earlier turns, pull back, `claude --resume` on the PC continues; trying to resume locally while on VPS is refused.
- P7: a bot in room A cannot `cat` a file in project B's repo copy, with Bash.

## 10. Open questions for the owner

1. Mirror covers sessions in every folder, including personal ones (school, private notes). OK for @persona to read those too, or should some folders be excluded by path?
2. Which repos are **client** repos (PC-only until P7)? Proposed: equilife, wika-*, planliftar.
3. Offload workers: which model by default on the VPS (Sonnet 5.5 to save the Max quota, or the session's own model)?
4. Should @persona get API-provider routing too (for example Gemini for long reading), or only PC/VPS for now?
