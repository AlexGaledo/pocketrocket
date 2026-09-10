# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `create_room`: a bot can now start its own group chat with existing bots instead of only being able to create bots and add them to a room you made first. It is added to the room automatically and is the coordinator unless it names another member.
- **Bots can manage any room, not just the one they are replying in.** Every room tool takes an optional `room` (name or id) and defaults to the current room, so existing behaviour is unchanged. `list_rooms` is new and shows every room with its id, kind and members, which is how a bot finds a room it is not in. `delete_room` is new and disbands a group chat and its history while leaving the bots themselves alone; it needs `confirm=true`, refuses DMs, and refuses the room the turn is running in rather than deleting the transcript mid-reply. `read_room`, `send_message`, `add_to_room` and `remove_from_room` all accept `room`, and a cross-room `send_message` wakes that room's members. Before this a bot that created a group chat could never touch it again.
- **Open the shared workspace folder from the sidebar.** The hub opens it on the machine it is running on, because that is the only machine the folder exists on: Explorer on Windows, Finder on macOS, and on a server hub the file manager on the virtual display, which is the desktop the Screen tab already shows. The toast names which of those happened.

### Changed

- **The hub token is reused across restarts instead of re-minted.** `ensureHubToken` wrote `<data>/hub-token` on every start but never read it back, so each start produced a fresh value and every deploy, `systemctl restart` and tsx-watch reload invalidated the token the open UI was holding — the next request 401'd and the "paste the hub token" panel appeared. The stored token is now reused when it is exactly 32 hex characters, and minted only on first run or when the file is missing or malformed. `POCKETROCKET_ROTATE_TOKEN=1` restores the old per-start rotation.
- **The Screen tab no longer asks for a VNC password.** `x11vnc` ran with `-rfbauth`, so opening the tab prompted on every load for something the hub was already enforcing: `/screen/*` needs the hub token, spent on a single-use ticket for a `/screen`-scoped httpOnly cookie, before the proxy is reached at all, and both VNC and noVNC bind loopback only. `x11vnc` now runs `-nopw`, and `setup-vps.sh` deletes the password files an earlier setup generated.
- The per-run step limit went from 40 to 80 and is now tunable with `MAX_TURNS_PER_QUERY`. 40 was tuned for chat and is tight for computer use, where a navigate, a snapshot and a click are three steps. The live cost brake is the bot's per-turn budget, which the SDK enforces mid-run, so the step count only ever had to catch a loop that is cheap but endless.

### Security

- **`POCKETROCKET_BYPASS_PERMISSIONS`, on by default, runs every bot turn with no approval cards.** The PermissionBroker allows every tool call, every `request_approval` and every fleet or room change outright, and each adapter is put into its own skip-permissions mode rather than routing asks into a broker that would allow them anyway: Claude runs `permissionMode: 'bypassPermissions'` and drops the out-of-workspace `PreToolUse` hook, Codex gets `--sandbox danger-full-access`, Grok runs with no filesystem sandbox, and OpenCode's permission config is all `allow`. Nothing pauses for you anywhere in this mode and there is no undo, so the hub logs a warning at startup whenever it is active and the system prompt tells bots they own the check you are no longer being asked for. Set it to `0` to restore the approval flow described in README "Permissions".

### Fixed

- **A bot whose saved session had vanished was stuck forever.** The provider CLI owns its session store, not the hub, so a re-login, a `cleanupPeriodDays` sweep or a redeploy can drop the transcript the `sessions` row points at — after which every turn in that room died with "No conversation found with session ID" until someone nulled the row by hand. The runner now recognises that wording, forgets the dead token, says so in the room, and reruns the same input once from a fresh session.
- A turn that ran out of steps ended with `error_max_turns` and abandoned the job mid-task. It now resumes the same session and carries on, at most `MAX_TURN_CONTINUATIONS` times (default 2), each one re-checked against the remaining budget and the abort signal, and each announced in the room so a long turn is visible rather than mysteriously slow.
- Two provider tests spawned all four CLIs and sat within a few hundred milliseconds of vitest's 5s default, so they failed intermittently once the suite got wider. Both now declare the timeout they actually need.

## [0.2.0] - 2026-09-09

First public release. (`0.1.0` was the internal Claudebot-era version, so the first release under the
PocketRocket name starts at 0.2.0.)

### Added

- Multi-provider hub: bots can run on Claude, OpenAI Codex, OpenCode, or Grok, chosen globally with a model picked per bot.
- Desktop app (Windows) that bundles its own Node runtime, so it runs without a system Node install.
- Sound cues (send, reply, approval request, approve/deny, turn done/error, desktop connected), on by default, respecting `prefers-reduced-motion`.
- First-run onboarding wizard: pick a provider, detect its CLI and login, name yourself, create a first bot.
- Settings dialog: provider selection with live install/login checks, default model, API key fields, sounds toggle, theme.
- Landing site (`packages/site`), live at <https://pocketrocket-chi.vercel.app>, with real screenshots of the app in the hero.
- Bot memory is capped at 8 KB. It is injected into the system prompt on every turn and bots are told to record anything durable they learn, so an append-happy bot would otherwise have made every later turn steadily more expensive. Older notes are dropped first, and `update_memory` tells the bot when that happened so it prunes deliberately instead of writing into a file that silently forgets.
- Providers carry a `maturity` flag. Claude and OpenCode have been driven end to end against real logins; Codex and Grok are written to each CLI's documented contract and covered by fixtures but have never been run against a real account, so the picker labels them **Untested** and says what that means. The README and the site say the same.

### Changed

- Renamed the project from Claudebot to **PocketRocket** across packages, env vars, data paths, systemd units, and the desktop app identifier.
- Permission enforcement generalized per provider: full hook-based interception for Claude, native permission API for OpenCode, best-effort workspace sandbox + `request_approval` tool for Codex and Grok.
- Much smaller download: the hub bundle went from 271 MB to 62 MB (Windows installer ~30 MB) by dropping the Claude Agent SDK's vendored copy of the Claude CLI, which PocketRocket never runs — it always drives your own `claude.exe`.
- The installed executable is `PocketRocket.exe` (it was `pocketrocket-desktop.exe`); the Start menu and desktop shortcuts were already named PocketRocket.

### Security

- The Screen tab no longer puts the hub token in a URL. An `<iframe>` cannot send an `Authorization` header, so the token used to ride the noVNC query string, where it sat in the DOM, in history, and in anything that later read `location`. The app now spends the token once on a normal authenticated `POST` for a single-use ticket, and the browser trades that ticket for an httpOnly cookie scoped to `/screen` that it can never read back. `?token=` is refused on `/screen/*` outright, and the cookie authenticates nothing else — presenting it to `/api/*` gets a 401.

Fixes from the pre-release audit ([`docs/AUDIT-2026-09-09.md`](docs/AUDIT-2026-09-09.md)):

- The hub token is now always on — there is no unauthenticated mode. It's auto-generated when `POCKETROCKET_TOKEN` is unset, written to `<data>/hub-token` (0600), and printed at startup as `http://127.0.0.1:7788/#token=…`.
- `Origin: null` is no longer whitelisted; REST/WS requests from a sandboxed iframe or any other `null`-origin context are rejected like any other foreign origin.
- `/screen/*` (the noVNC desktop bridge) now requires the same bearer token as every other route, instead of being exempt.
- Bash/path permission rules tightened: relative-path and post-`cd` resolution, denial of interpreter eval/exec flags, and `isInside` now requires the canonical path **and** its realpath both stay inside the allowed roots, instead of either one being enough.
- Bot CRUD and tool-grant changes now go through a human approval card; a bot can no longer widen its own tool grants unattended.
- Provider child processes get a per-provider environment allowlist instead of the hub's entire `process.env`.
- `secrets.json` permissions are re-applied on every write, not just when the file is first created.
- CI hardened: a top-level `permissions: contents: read`, every third-party GitHub Action pinned to a commit SHA, and Dependabot configured for `github-actions`, `npm`, and `cargo`.
- Redacted the local Windows username and an internal SSH host alias out of screenshots, test fixtures, and docs (`app.png`, `app-dark.png`, `docs/screenshots/*`, `.env.example`, `docs/PLAN.md`, `docs/PRODUCTION-CHECKLIST.md`), and widened `.gitignore` to catch `.env*`, `secrets.json`, `auth.json`, and `hub-token` going forward.

### Accessibility

- The provider cards could not be reached with a keyboard: they are `role="radio"` on a `div` with neither `tabIndex` nor a key handler, which also made the onboarding wizard's provider step — the first screen a new user sees — mouse-only. They now use a roving tabindex, Enter/Space to choose, and arrow keys to move between cards.
- Buttons had no focus ring of any kind. Every button, toggle chip and segmented control now shows one on keyboard focus, and text fields no longer stack the browser outline on top of theirs.
- No field in any dialog was programmatically labelled: the caption rendered as a plain `<span>`. Captions are now real `<label for>` elements tied to their control, and captions over groups of toggle buttons name the group through `aria-labelledby`. The API-key rows, the hub-token prompt and the sounds switch got accessible names too.
- Toggle chips report `aria-pressed`, the theme picker is a named group, bot avatars carry an `aria-label` instead of a mouse-only `title`, and decorative emoji are hidden from screen readers.
- Light-theme text failed WCAG AA, in some places badly: the `--dim` colour used for hints sat at 2.15:1 where 4.5:1 is required, and `--muted`, `--accent`, `--ok`, `--warn` and `--bad` were all under the bar as well. Every text colour in both themes is now at least 4.5:1 against the lowest-contrast surface it appears on. The dark theme needed only one change.

### Fixed

- Switching to OpenCode from a cold start left every bot pointing at a model OpenCode does not offer. OpenCode reads its model list from the CLI, so the list is empty for the first few seconds; the repointing step saw nothing to repoint against and gave up without ever retrying. It now waits for the real list and repoints when it arrives.
- Quitting the hub with Ctrl+C while OpenCode was the active provider hung for eight seconds and left an `opencode serve` process running in the background. It now shuts down in about a second with nothing left behind.
- The bundled hub reported version 0.1.0 whatever the real version was, and could not find the Browser tool's Playwright CLI, because it looked for its own files in the source layout rather than the installed one.
- The desktop app always ran the hub on its own bundled Node and reported it as "system node", because Windows resolves a bare `node` to the copy sitting next to the app before looking at your PATH. If you have Node 22.13+ installed, the app now uses it, as documented.

## [0.1.0]

- Initial internal version (Claudebot): Claude-only hub, DMs and group chats, memory, skills, routines, VPS deploy scripts with a shared virtual desktop.
