# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Workflow canvas stays readable with many steps (web)

- The canvas now opens on the first three steps at a readable size instead of shrinking every step to fit; the rest are a scroll away. An 8-step workflow used to open as tiny unreadable boxes.

### Workflows: canvas, steps list and approval card (web)

- Automations has a Workflows section; each workflow opens its own page with Enabled, Run now, a Canvas | Steps switch (remembered per browser), a step inspector, per-step status and cost, run history, Cancel and Retry step.
- The canvas (React Flow, loaded only when opened) adds steps with a "+" on each line; the Steps list does the same with menus and works on phones. Errors from the shared chain rules show before you save.
- A workflow's approval step shows as a card in its chat and in Needs you with Approve, Reject and Send back with a note. Only that card answers it.
- Usage lists "Workflows" as a cause. Cards in the chat now share one `ActionCard` primitive (no visual change).

### Workflows say where a saved file went (hub)

- A workflow whose output step saves a file now posts a short note in the chat naming the file. Before, the chat's last word on the run was "waiting for your approval" even after it finished.

### Fewer needless approval cards (hub)

- A Bash command that sends output to `/dev/null` (`git log 2>/dev/null`) no longer counts as writing outside the workspace, so strict turns such as workflow steps stop asking for plain reads.

### Telegram notifications card (app)

- Settings › Notifications now shows on every client except a paired phone, with a pointer to "Phone: Devices › Notifications on this device"; the desktop-notification card still appears only in the desktop app.
- New Telegram card: paste a bot token (checked, then shown as @yourbot), link your chat with a short code, QR code or "Open in Telegram", then turn on "Notify me here". The cloud warning (messages are content-free, Telegram still sees that something happened) is shown above the switch. Send a test, Unlink, a BotFather /revoke pointer and a "one hub per bot token" note are on the card. Needs the hub routes from the Telegram backend change.

### Workflows: hub foundations

- A turn now belongs to an owner ref (`routine:<runId>` or `workflow:<runId>:<step>`) instead of a bare routine run id, in the lane journal and on parked approvals, and what the turn does when it ends is rebuilt from it after a restart or a parked approval. Routines behave as before (a run still closes when its turn ends, and a turn cut off by two restarts closes its run as an error). Existing rows are filled in by migration 290.
- A lane can run a step alone (never batched with chat messages), a workflow run's budget caps every hand-off on its thread the way a trigger's daily budget does, "Run now" and "Test fire" mark their thread as person-started, and Usage has a "Workflow" cause kind.
- New tables `workflows` and `workflow_runs` (migrations 291-292). Nothing uses them yet: the runner, approval card, REST and bot tools follow in the next change.

### Workflows: the run engine, approval card, REST and bot tools (hub)

- A workflow is a fixed chain of steps (a trigger, then bot steps, approval steps and an output) that starts from a routine, an event trigger or "Run now". Each bot step is its own turn: alone in the bot's queue, with approvals on even under bypass, at hop 0 (so two hand-offs inside every step never trip the hand-off limit), and capped at what is left of the run's budget. The run stops with a note in the chat when it spends its budget. The previous step's text reaches the next step fenced as data, never as instructions.
- Progress is saved after every step. After a restart a run resumes at the right step: a step that was cut off is resumed once by the usual follow-up, and a run that died between two steps carries on from the next one. A run you Stop ends as "stopped by you" and Retry runs that step again; steers you send into a running step are kept on that step's timeline.
- An approval step posts a card only you can answer (approve, reject, or send back once with a note). It waits through the night, expires after 24 hours (the run ends in an error and Retry asks again) and shows in Needs you. A bot, a cta button, a chat message or a tool approval answer cannot decide it, and a paired phone can answer it but not build workflows.
- An output step posts the last output to the chat, or saves it as a file in the chat's files folder (relative paths only; a path that climbs out of the folder is refused).
- New routes: `/api/workflows`, `/api/workflow-runs`, `/api/workflow-cards`, and events `workflows.changed`, `workflow.run`, `workflow.cards`. Bots get `list_workflows`, and `create_workflow` and `update_workflow`, which show you an approval card first. A routine or trigger that a workflow uses cannot be deleted (409) until the workflow is changed. Migration 293 adds the chat to `workflow_runs`.

### Telegram notifications (hub)

- You can link your Telegram to get a short notice when a bot needs your approval or a routine finishes. Create a bot with @BotFather, save its token, then press Start in Telegram with the one-time code (10 minutes, one use, a `t.me` link). Only a private chat from a person (not a bot, not a group) whose id matches the chat is accepted, and five wrong codes lock linking for 15 minutes. The hub keeps your numeric Telegram id, not your username.
- The message is one fixed line per kind plus your hub address when you set one up, never a bot, room, tool or message name. It is off until you switch it on, and a Telegram-only owner (no phone subscription) is notified. Phone push and Telegram each coalesce bursts on their own 30 second clock.
- The hub only reads Telegram while a link code is waiting, aborts that poll on shutdown, and never removes a webhook: if another PocketRocket or a webhook uses the bot, linking says so (409). The bot token is kept encrypted, scrubbed from logs and errors, and never shown again. New routes under `/api/telegram`, for the desktop app only (not paired phones, not bots).

### Bundle budget in CI, Telegram notes in the docs (infra)

- CI now fails if the web entry chunk contains workflow-canvas (`@xyflow`) code or grows past a size budget (`scripts/bundle-budget.mjs`, about today's size plus 15%).
- Docs: `api.telegram.org` is on the outbound list, the guide has a Telegram notifications section (BotFather, link, what the messages say, revoke), and `deploy/keys.sh` prints the BotFather `/revoke` step for a Telegram integration.

### Move a PC Claude Code session to the VPS and back (hub)

- A mirrored PC session whose repos all sync by bundle (and are not client repos) can be moved to the VPS: the PC uploads one git bundle per repo and the session file, the hub imports each bundle into a `wip/<machine>/<session>` branch, builds a worktree for it, rewrites the PC paths in the conversation to that worktree and files it where the VPS Claude CLI looks. Only a browser signed in with your password can start a move, and your PC asks again before it uploads anything.
- While a session is on the VPS the PC's own appends are dropped and a resume or sync of it is refused (409). "Continue" runs one turn at a time through the Claude provider, resuming the same conversation in the worktree with the room's tools; `git push` is always refused there, and the turn's changes are committed to the wip branch only. New lines show in the mirror marked as the VPS, and the room gets a note when a turn starts and ends. Past 120k tokens of context it asks you to pull back instead.
- Pulling back sends the conversation (paths swapped back, the exact inverse) and a bundle of the wip branch to the PC, then clears the worktree. `propose_move` lets @persona or a project bot propose a move or a pull as a sign-in-only card. `GET /api/cc/session-state` and the `x-cc-session-state` header tell the MCP server where a session is.

### The PC helper can move a session to the server and pull it back

- A new kind of PC job moves one of your Claude Code sessions to the server so the same conversation continues there. The PC snapshots and secret-scans every linked repo first (one blocked scan refuses the whole move without asking), shows one Run / Refuse dialog for the whole move, then sends a bundle per repo and the session file. Nothing is pushed to any remote and your folders are not changed.
- Pulling it back downloads the session and each repo's work, checks them, and puts the server's work on the `wip/<your PC>/<session>` branch of each repo (only that branch). If your folder is still exactly as it was when you moved, the server's file changes are also written into it as uncommitted edits, without moving HEAD, your branch or your staged changes; if you changed it meanwhile, it is left alone and you are told to merge the branch yourself. The session file is replaced and the old one kept next to it as `.pocketrocket-bak`.
- While a session is on the server, this PC refuses to resume it, the mirror stops sending PC-side changes to it, and the PocketRocket tools in that terminal add a warning line.
- The installer now also copies `move.mjs`.

### PC sessions: Active and History, with a running indicator

- PC sessions opens on Active: only the sessions Claude Code is working in right now (written to in the last few minutes) or that are on the VPS, with a count. History has everything mirrored. The app remembers which one you picked.
- Every session row says Running (green dot) or Idle with how long ago.
- Sessions now group by their repo's remote, so Claude Code worktrees (agent-…, wt-…) sit with their repo, and a session outside any git repo groups under the folder it ran in, ignoring case (`Desktop\WIKA-SaaS` and `desktop\wika-saas` are one group) instead of Claude's internal C--Users-… folder name.

### PC sessions: fold repo groups

- The PC sessions list can fold each repo group open and closed (click its name), and has Collapse all / Expand all. The app remembers which groups you folded.

### Move a PC session to the VPS and pull it back (app)

- A mirrored session now has a Move to VPS button. It lists the repos that move with it, asks which chat should follow the server turns when the project has several, and says why it is disabled: PC offline, not signed in, no linked repo, a client repo, or a repo that is not set to bundle sync.
- A moved session shows an On VPS badge in the list and in its header (Moving to VPS and Pulling back while your PC works). Under it, a Continue on VPS box sends one turn at a time with a live status line, and Pull back asks for confirmation first and waits for a running turn to finish.
- Move and pull jobs appear in the PC runner job log with their repos, commits, session size and, for a pull, whether the changes were applied to your folder or left on a wip branch.
### Bot sandbox on the server, which lets client repos sync (hub, app, deploy)

- A new switch, Settings > Security > "Run bot tools in a sandbox (Linux server)", runs each Claude turn inside bubblewrap. A bot's Bash and file tools (and the Browser tool's Playwright process) then see only the read-only system, their own bot folder, the room and project folders they belong to, the shared workspace and the network. Other projects, other bots' folders, the vault key, the hub token, the database and your server login are not mounted, so they do not exist inside. It is off by default and only you can change it: no bot can switch it off.
- On a server where it cannot work, the switch says why and refuses to turn on. If it is on and bubblewrap later breaks, bot turns stop with that reason instead of running unprotected.
- With the sandbox on, a repo you mark as a client repo can sync to the server like any other; with it off, nothing changes and client repos still stay on your PC.
- Each bot gets its own private Claude config inside the sandbox, so one bot's conversation transcripts are not readable by another. Conversations started before you turned it on carry over the first time a bot resumes them.
- `deploy/setup-vps.sh` installs bubblewrap and, on Ubuntu 24.04, an AppArmor profile (`deploy/apparmor/pocketrocket-bwrap`) that lets only `/usr/bin/bwrap` create a user namespace. `deploy/sandbox-check.sh` proves it: as the service user it checks that a bot of one project cannot read another project, another bot, or the hub's secrets.
- While the sandbox is on, a session moved to the VPS cannot run new turns there yet (the sandbox's private Claude folder would hide them); pull it back or turn the sandbox off. Moving a client repo's session stays refused.

### Project repo lists and syncing PC work to the VPS (hub)

- A project can list its git repos in Settings (stored as `repos.json` in the project folder, which only you can edit): a name, the remote URL, how it syncs (wip branch, bundle or none), extra protected branches, and whether it is a client repo. Repos are matched by remote URL, so no path on your PC is ever stored here. Bots cannot change the list.
- Mirrored PC sessions now show which project repos they belong to. A bot on that project's chat can list and read only the sessions of its repos, see the repo list (`list_repos`), and propose to continue or sync one; each proposal is still a card only a browser signed in with your password can allow.
- A sync copies a session's working tree to the VPS without touching your PC's own branches: either a `wip/<machine>/<session>` branch pushed to the remote, or a git bundle uploaded to the hub and imported into the project's copy of the repo on that one branch (git runs with hooks and credential helpers off). Client repos and repos set to none are never synced. A blocked pre-push scan on the PC shows up as a failed job with the findings.
- Bots on a project with repos can no longer push to a repo's protected branches (main and master always count).

### The PC helper can sync a session's repo to the server, after a secret scan

- A new kind of PC job copies the repo around one of your mirrored Claude Code sessions to the server: either as a work-in-progress branch pushed to the repo's remote (only `wip/<your PC>/<session>`, never `main` or any other branch), or as a bundle uploaded to the server with nothing pushed. It sends a snapshot of your working tree, including uncommitted and untracked files, without touching your folder, index, branches or stash.
- Before anything is sent, the PC scans the snapshot and any commits you have not pushed yet. Files named `.env*` (except `.env.example`), `*.pem`, `*.p8`, `*.p12`, `*.key`, `*.keystore` or `id_rsa*`, and lines that look like API keys, tokens or private keys, block the sync, and the PC refuses without asking you. Otherwise the Run / Refuse dialog shows the repo, remote, mode, target branch, how many files and lines change and the scan result.
- The PC only syncs a repo whose `origin` is the project's remote, and only from a folder you allow. Environment files are never copied.
- The installer now also copies `jobs.mjs`, which resume jobs from the previous release needed.

### Project repo lists and Sync from a PC session (app)

- Settings > Projects has a Repos editor for each project: a name, the remote URL, a sync mode (off, push a wip branch, or send a bundle to the VPS), protected branches, an optional VPS folder, and a Client repo switch that keeps the repo on your PC until bots are sandboxed. Mistakes such as a bad name, a missing remote, a password in the URL or a duplicate repo are shown under the field, and removing a repo asks first. No PC path is typed or stored.
- PC sessions that belong to a project repo show a project / repo tag. A Sync button in the transcript starts a sync of that session for each linked repo, is disabled with the reason for client repos, repos with sync off and an offline PC, and follows the job live.
- The job log shows sync jobs with the repo, mode, branch, short commit and bundle size, and lists what the pre-push scan blocked when nothing was pushed.

### Smaller server backups

- The daily server backup now leaves out folders that can be rebuilt, such as `node_modules`, `.next`, Python virtual environments and Rust `target` folders, wherever they sit inside a project. `dist` and `build` are still kept because they can hold real output.
- Backups are compressed with zstd when the server has it (`data-<date>.tar.zst`), which is smaller and faster than gzip; older `.tgz` backups are still rotated and can still be restored. See `docs/SERVER.md` for the restore command.

### Your persona bot can read across rooms and continue PC sessions, and the app can start PC jobs

- The persona bot (the one you name in settings) gets four tools no other bot has: it can read any room, list and read the Claude Code sessions mirrored from your PC, and give a task to a bot in a room by posting there with an @mention (the bot must be in that room; a room the persona is not in asks you first). What it reads is quoted and scrubbed of keys, and the persona is told not to copy it into another room unless you ask.
- The persona can also propose to continue one of those sessions on your PC. Like every job on the PC it needs your approval on a card, and only a browser signed in with your password can allow it (the desktop app's token alone cannot); your PC then asks you again before it runs anything.
- The app can start jobs itself: continue a mirrored session or run a new job in a folder your PC allows. Clicking it in a signed-in browser is the approval; the desktop app, a paired phone and bots cannot do this. The job log now shows whether a job was a new run or a resume, who asked for it, and which of your allowed folders a resume ran in.

### The PC helper can continue one of your Claude Code sessions

- The PC helper can now resume a session it mirrored, so a follow-up runs on your PC inside the same Claude Code conversation and its new turns show up in the same transcript. It finds the session's folder on its own and only goes ahead when that folder is inside a folder you listed in `config.json` (links and `..` tricks that lead outside are refused); that folder's own tools apply.
- The Run / Refuse dialog on the PC now says whether a job starts a new session or resumes one, and for a resume shows the session title, its working folder and the allowlist folder it matched. Jobs from an older hub behave exactly as before.

### Continue on your PC from the app

- Open a mirrored Claude Code session under PC sessions and press Continue on PC to send it your next prompt. Your PC resumes that same session and the answer shows up in the transcript. The button needs the PC online and a browser signed in with your password; otherwise it says why.
- Settings > PC runner has a new Run on PC box: pick one of the folders your PC allows, write a prompt and send it. The job log now shows whether each job was a new run or a resume, who started it (you or a bot), and links a resumed job back to its session.
- Your PC still asks you to run or refuse every job.


### The hub can keep a read-only copy of your PC's Claude Code sessions

- The PC helper can now mirror your Claude Code transcripts to the hub as compact entries (what you and Claude said, which tools ran and a short result), so you can read them in the app from anywhere. Subagent runs hang under their parent session.
- Everything is scrubbed again on the hub before it is stored (keys, tokens and any secret you saved), and kept small: at most 5 MB of text per session, 400 MB for the whole mirror (oldest sessions go first) and 90 days. The hub tidies this at start and once a day.
- Only you can read the mirror, with the hub token or a signed-in browser: no bot but your persona (see above), and no search or room, can see it, and a paired phone cannot either. You can delete a session (and its subagent runs) from the app, and a deleted session is not mirrored again.

### The PC helper can mirror your Claude Code sessions

- While the PC helper (runner) is ON, it now copies your Claude Code sessions to PocketRocket so you can read them there. It sends compact entries, not raw logs: what you and Claude wrote, a one-line summary of each tool call, a short excerpt of each result and compaction summaries, cut to fixed lengths (8000 characters for messages, 1000 for tool results). Sessions changed in the last 14 days are sent first, then new lines live; a restart resumes where it stopped.
- Everything is scrubbed for keys, passwords, emails and phone or ID numbers on the PC before it leaves, and again on the hub. Bots cannot read mirrored sessions yet; only you can, in the app.
- Control it in the helper's `config.json`: `mirror` (on or off), `mirrorBackfillDays`, and `mirrorExclude` (folders or `*` patterns to skip). A new "PocketRocket Mirror pause-resume" Desktop shortcut pauses and resumes it. Re-run `install.ps1` to get it. See the "Mirror your Claude Code sessions" section of `scripts/pc-runner/README.md`.

### PC sessions in the app

- A new "PC sessions" item in the sidebar lists the Claude Code sessions mirrored from your PC, grouped by repo with the newest first. Each row shows the title, repo and branch, folder, how long ago it was active, a green dot while it is live, and its size; a session's subagent runs open from its transcript. Search by title, folder or repo, filter by repo, and load older sessions as you go. The list refreshes by itself while a session is running.
- Opening a session shows a read-only transcript: your messages and Claude's replies (as formatted text), with tool calls and results folded into one-line rows that open on demand and turn red on errors, and compaction summaries as their own card. A session that grew past the mirror's size limit says so. New messages appear at the bottom while you are watching. Delete removes the mirrored copy only, after a confirmation.

### Shared files remember who changed them

- Every change to a room's or project's files that the hub can see is now recorded: who made it (you, a bot, or your assistant), from which machine, in which turn, with which tool, and the sources it cited. Bot Write and Edit calls, your uploads, deletes and text saves are tracked; a bot's Bash edits are not. Bots get `file_history` to look it up before changing something another writer made.
- Each room and project folder can keep a `decisions.md`: an append-only log of what was decided and why. Bots add to it with `log_decision` (naming the decision it supersedes when one changes); their own file and shell tools cannot edit, move or delete it.
- `GET/POST /api/rooms/:id/files/text` reads and writes a text file with its hash. A write sends the hash it last read and is refused with `409` and the current text when someone changed the file in between, so a stale copy never overwrites newer work. Also `GET …/files/history?path=` and `POST …/files/decision`. These are the base for linking Claude Code sessions on your PC (`docs/specs/claude-code-bridge.md`, phase 1).

### Claude Code sessions can talk to rooms

- The hub now has a small `/api/cc/*` API for Claude Code terminal sessions on your PC, reachable only through the PC helper (not with the hub token, and not from a paired phone). A session can list your group and project rooms, read recent messages, post to a room, read the room's state, read and save text files, log a decision, and hand a task to a bot. Direct chats stay out of reach.
- What a session posts arrives as you, so the coordinator or the bots you @mention answer as they do when you type in the app, but the line starts with `[via Claude Code · <repo>]` so you and the bots can tell it came from the terminal. Files and decisions it writes are recorded as "you via Claude Code (<repo>)" in their history, and a save from an out-of-date copy is refused with `409` like any other.
- Bots now start a turn with a short state block: the version and "Now" part of the folder's `current.md` and the last five decisions. It goes in the turn's input, not the system prompt, and is repeated only when one of those files changed or the bot starts a fresh session.

### Use PocketRocket from Claude Code

- The PC runner now ships a small MCP server, so a Claude Code session in your terminal can list your rooms, read them, post to them, read and edit their shared files, log decisions and hand tasks to a bot. Add it once with `claude mcp add --scope user pocketrocket -- "%LOCALAPPDATA%\PocketRocketRunner\mcp.cmd"` (the installer prints the line). It only works while the runner is ON, and when it is not, Claude is told to ask you to turn it on.
- Edits are safe by design: Claude reads a file first and sends the hash it read, and if a bot or you changed the file in the meantime the write is refused and Claude gets the current text to merge instead of overwriting it. Decisions are append-only. The MCP server sends the runner token only after checking that the port belongs to the runner's own tunnel.

## [0.3.0] - 2026-11-18

Entries are grouped by feature area; per-phase notes live in `docs/changes/pN.md`.

### The desktop app updates itself

- The desktop app updates itself. It checks at launch and every 24 hours in every mode, and when an update is out it shows one notification and turns the tray's **Check for updates** into **Update to vX.Y.Z…** (plus **What's new in vX.Y.Z**); it never opens a dialog over your work. Picking it asks **Install and restart** / **Later**. In this-PC mode the install waits until no bot is mid-reply and no approval is open (cancel from the same menu item), stops the hub cleanly and restarts; server mode updates only the desktop app; attach mode and older hubs ask you to check first; a Linux .deb install opens the release page instead. **Check for updates** now really checks and says when you're up to date. `POCKETROCKET_UPDATE_ENDPOINT` can point a test build at a release candidate on this repo's releases.
- Releases are built into a draft and published only when every platform is done. Each release now carries `latest.json` for the desktop updater, a `SHA256SUMS.txt`, and build-provenance attestations you can check with `gh attestation verify <file> -R AlexGaledo/pocketrocket`. A new release appears as a prerelease first and becomes the latest one after it passes an update test.
- Safe updates groundwork: `GET /api/busy` says whether stopping the hub now would lose work (a running turn or an open approval card), `POST /api/maintenance/hold` keeps new bot turns from starting for up to 30 minutes (messages still queue and run afterwards) and `POST /api/maintenance/stop` shuts the hub down cleanly. Hub token or owner session only; see `docs/CONFIGURATION.md` section 8.

### Steer or queue messages to a busy bot

- Steering (hub): a message you send to a Claude bot that is busy in that chat now joins its running turn, so it can change course at its next step instead of after it finishes. Send with `mode: "queue"` (Ctrl+Enter, once the app has it) to wait for the turn to end instead, or set Settings `busyMessages` to `queue` to make that the default. Hand-offs between bots, and providers that cannot take messages mid-turn (Codex, OpenCode, Grok), still queue. If the turn stops (Stop included) before the bot answers your message, it is queued and answered next, and the chat says so. A routine or trigger turn you steer keeps its approvals and budget.
- Steering (app): while a bot that can steer is busy, Enter joins its running turn and **Ctrl+Enter** queues for after; a small arrow beside Send offers **Join the running turn** / **Queue for after** for phones and mice. A line under your message says what happened per bot ("Joined Ada's reply", "Queued: Gemini can't take messages mid-task", "Queued: Ada answers this next" after Stop), and the bot's work after your message is marked *continued*. Settings → Bots → *When a bot is busy* sets the default. Send and Stop now have labels and tooltips; Stop says it stops every running bot in the chat. See `docs/GUIDE.md`.
- Queue controls (hub): `GET /api/rooms/:id/queue` and the `queue.changed` event show what each bot has waiting in a chat, and you can **cancel** or **edit** your own queued message (edit only before any bot has read it), **send now** (stops the bot's running turn and runs its queue next; messages it had not answered yet are kept, as with Stop) and **pause** a bot's queue (nothing new starts until you resume; the pause survives a hub restart). A cancelled message is never shown to that bot. Paired phones can use them too. No reordering. The app's controls follow.
- Queue controls (app): a chip above the composer shows each bot with messages waiting in the chat (`@ada · 2 queued`). It opens a list of what is waiting, where you can **Edit** or **Cancel** your own messages (when an edit is no longer possible, it says why), **Pause queue** / **Resume queue**, and **Send now…** (asks first, because it stops the bot's running reply). A paused queue reads **Queue paused** on the chip and in the header, apart from a screen's *paused*. Messages in the chat only say "Queued", "Edited" or "Cancelled". Works from the keyboard and on a phone.
- When you stop a bot (Stop, or Send now), the chat says "Ada was stopped by you." instead of a red "turn ended" error.

### Fixes

- The desktop app's bundled hub now installs its dependencies at exactly the versions in `pnpm-lock.yaml`. Before, the release build resolved every package fresh from npm, so a release could ship untested versions or fail when a package was only half-published.
- A bot whose turn is cut off (token brake, or the step limit after its continuation) no longer leaves its hand-off chain dead. It continues in a fresh, small session up to `CUTOFF_RETRIES` times (default 2), then the room's coordinator is woken to split, reassign or finish the work.
- A bot that reports back on handed-off work without @mentioning anyone no longer ends the chain: its report goes to the room's coordinator.
- Importing skills from a git repo on Windows no longer skips every skill as "no description": Git for Windows checks files out with CRLF line ends, and the SKILL.md frontmatter reader now accepts them.
- On Windows, saving outside MCP servers or integration keys twice in quick succession no longer fails with a 500. The file permission fix-up from the first save could still hold the file when the second save replaced it; the replace now waits up to a second for it.

### Choose where a link opens

- Clicking a web link in chat now asks where to open it: **Open in my browser**, **Open in server browser** (the page opens in a bot's virtual browser on the server, with its logins, and the Screen panel shows it) or **Copy link**. Ctrl-click and middle-click still open it straight in your browser.
- Clicking a file link asks too: **Preview in Files**, **Open in server browser** (an HTML report runs there as a real page) or, in the desktop app, **Open on this PC**, which saves a copy under `Documents\PocketRocket\<chat>\` and opens it in its default app. In a browser tab that item is **Download**.
- The server browser is the browser of the bot that wrote the message, else the chat's first bot with Browser, else any bot with Browser (an awake one first).
- **Open on this PC** only copies documents, data and pictures (HTML, Markdown, text, CSV, JSON, PDF, images, Word, Excel, PowerPoint), never programs, scripts or macro files. Copies are marked as downloaded from the internet, so Office opens them in Protected View. It needs this version of the desktop app; an older one shows Download instead.
- Links that give a full server path (`/home/.../report.html`) now work when the file is inside the chat's folder.

### Review fixes

- Pictures attached to a message are now limited to 3.5 MB each (the browser shrinks them to fit); a bigger one is refused instead of failing the whole turn.
- Bot export now also removes other file paths (any drive, network shares, `/srv/...`-style paths) and tells you which skills were left out for being over 64 KB or past the 20-skill limit.
- `write_note` no longer says "Saved" while ignoring tags: it explains when tags cannot be added. Forms are not offered to routine and trigger runs. Old attached pictures and the pictures of deleted bots are cleaned up after 7 days.

### Saved logins for bots

- A new **Logins** section in Settings saves a login (a name, the exact site, a username and a password or secret). A bot can then sign in with `fill_credential` by name: the hub types it into the field in the bot's browser, and the bot only ever hears "filled". The secret is write-only (never shown again, never in a bot's chat, logs, cards or any API answer) and is stored encrypted in `data/credentials.json` under the same key as your integration tokens.
- It asks you on a card every single time, also when approvals are bypassed, and only a browser signed in with your password can say yes; there is no "for this session" and no rule that pre-approves it. A login only works on the exact site it was saved for (same scheme, host and port): on any other page, after a redirect, or with two tabs in front, it refuses and types nothing. A password goes only into a password field.
- Saving, changing or deleting a login also needs a signed-in browser, and is recorded in the audit log without the secret.
- A login cannot be saved for `localhost`, `127.0.0.1` or other addresses on this computer, because a bot can run its own local server. `fill_credential` with the username field now types the saved username, never the password.

### Forms and buttons in chat

- A bot can now ask you for a few answers in one card with `request_form`: text boxes, a pick-one list and yes/no, up to 8 fields, with length limits. The card sits in the chat, survives a reload, and your answers go straight back to the bot, which carries on with them. Cancel, or no answer in 10 minutes, tells the bot plainly that you said no. Forms cannot ask for passwords, keys, tokens or codes: such a form is refused, and an answer that looks like a key is refused too.
- A bot can put up to 3 buttons under a message. A button either sends its text as a normal reply from you (the text is shown under the button before you click) or opens a web link in a new tab with the site name written next to it. Only plain http and https links are allowed. A button never changes a setting or approves anything.
- Everything a bot writes on these cards is shown as plain text, never as formatting or HTML.
- An open form now counts in **Needs you** (the inbox, the tab count and the bot's status) like an approval. Its row only opens the chat: you fill the form on the card.
- A paired phone can read a room's tasks; saved logins, tools, bot sharing and reports stay desktop only.

### Share a bot, and screens for tasks, tools and reports

- You can save a bot as a file (Bot settings > Export) and make a new bot from one (the + menu > Import a bot). The file holds the bot's name, role, picture and skills, and its memory notes only if you switch that on. It never holds logins, keys, tokens, approval rules, tool permissions, budgets or file paths, and anything in the text that looks like a key or a path on your computer is taken out before the file is made. Importing always creates a new bot, never changes one you have, gives a taken handle a number (`@ada-2`), and shows you what is inside first. Skills that arrive wait for your approval on the Skills tab. A bot made from a file starts without a shell (Bash) and without page fetching (WebFetch); you can turn them on later in its settings. The import preview now shows all of its instructions, because the bot will follow them. Files over 1 MB, or with fields the app does not know, are refused.
- A Tasks page (in the sidebar) shows each chat's to-do list in four columns, updating live as bots add and move tasks.
- Settings has a Tools page for outside tool servers: add, check, change approval and remove them. Tokens and secrets can be saved or replaced but are never shown again.
- Settings has a Reports page listing when bots said a site stopped them, with Resolve and Dismiss.

### Tasks, history search and bot reports

- Each room has a local task board: bots get `create_task`, `update_task` and `list_tasks`, and there is a REST API under `/api/rooms/:id/tasks` (200 open tasks per room, 200-character titles, 4 KB notes). A task is only a note: it never grants an approval or changes a setting.
- Bots can search the chat history of the rooms they are in with `search_history` (full-text, stemmed) and look across memory, notes and history with `recall_memory`. Notes can carry `tags:` in front-matter and `search_notes` can filter by tag. Older messages are indexed in the background after an upgrade.
- Bots can tell you when a site stopped them with `report_blocked` (a room note plus a review list at `GET /api/bot-reports`) and leave feedback with `send_feedback` (a local file, readable at `GET /api/feedback`). Both refuse secrets and are limited to 10 an hour per bot. Nothing leaves your machine.

### Web UI security headers and MCP server API

- The hub now sends a Content-Security-Policy, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` with the web app. `POCKETROCKET_CSP=report-only|enforce|off` picks the mode; the default is `report-only` (violations show in the browser console, nothing is blocked) until the policy has been run against the production build. The theme snippet moved from `index.html` to `/theme-init.js` so scripts need no `unsafe-inline`. Inline scripts in a previewed HTML file will not run once the policy is enforced.
- New `GET/POST/PATCH/DELETE /api/mcp-servers` and `POST /api/mcp-servers/:name/check` manage `data/mcp-servers.json` without hand-editing. Tokens and env values are write-only (listings show whether a token is set and the variable names). Adding or changing a server that runs a command needs a browser signed in with your password, like a PC job approval; url servers and deletes take the hub token. A hand-edited file keeps working and is never overwritten when it does not parse. No UI yet.

### Needs you inbox and desktop notifications

- A **Needs you** entry at the top of the sidebar opens one list of everything waiting on you across all bots and rooms: approvals, requests to take over a bot's screen, and skills or skill changes waiting for review. Each row shows the bot, what is waiting and for how long; a plain approval can be allowed or denied right there, and Open jumps to the room. The count shows on the sidebar entry and in the window title.
- In the desktop app, a notification appears when a bot needs your approval, needs you on its screen, or finishes, but only while the window is in the background. The text is generic ("A bot needs you") unless you turn on **Settings > Notifications > Include message text**. The section is only listed in the desktop app. Phones keep using Web Push.
- Loading placeholders in the chat and sidebar, a few empty lists, and the icon buttons in the fleet pages, bot page, screen panel and triggers now use the shared Skeleton, EmptyState and Tooltip components (the same look, with hover and keyboard-focus labels on the buttons).

### Machines

- Bots can now ask which computers they may run on (`list_machines`) and name one in `run_on_pc`. Each machine gets its own on/off policy in Settings, and approval rules can be scoped to a machine and given an expiry. Existing rules keep applying to every machine.

### Bot pop-out windows

- Each bot row has a pop-out button that opens that bot's chat in its own small window, so you can keep a few bots in view while you work. In the desktop app the window is built by the app itself and gets no extra permissions; in a browser it is an ordinary small window.

### Clearer refusals for bots

- Every refusal a bot reads (declined card, timeout, read-only mode, a rule you set, an unavailable tool) now says what happened, tells it not to retry, and says what to do instead, so bots stop looping on a "no". The hub tool lists the permission gate uses now come from one shared registry, with a test that fails if a new tool is left out. Wording only; no approval behaviour changed.

### Attach pictures to a message

- The composer has a paperclip button, and you can paste a screenshot or drop pictures onto the chat. Up to 4 PNG, JPEG or WebP pictures per message, each shown as a thumbnail you can remove before sending, with an uploading or failed state and Retry. GIFs, PDFs and other files are refused with a plain message for now.
- Before upload the browser redraws each picture, which removes EXIF data such as photo location, and scales anything past 2048 px on its longest side. The hub checks the real file type from the bytes, accepts up to 10 MB per picture, and refuses the whole message if any picture is unknown. Sending goes through the same outbox as text, so a retry resends the already uploaded pictures and never posts twice.
- Bots get your pictures with the message. On Claude they arrive as images in the turn; on other providers the message gives a file path the bot can open. Anything shown or written in a picture is passed as untrusted data. The copies live in a hub-owned folder (`data/attachments/<bot>`) that the bot can read but its own file tools cannot change.
- Pictures attached to messages are no longer swept away by the daily media cleanup.

### Messages that don't get lost

- Sending while the hub is unreachable no longer drops the text. The message shows in the chat at once, marked "Waiting to reconnect", and goes out in order when the connection is back. A message the hub never confirms shows "Not sent" with Retry and Discard. Unsent messages survive closing the tab.
- Each chat remembers what you were typing: the draft comes back when you return to the room and clears when you send.
- The hub tells a repeated send from a new one (an optional `clientMsgId` on `message.send`, stored on the message), so a retry after a reconnect never posts twice or starts a second turn. Older clients that send no id work as before. Existing databases get the new column and index on start.
- The connection now notices a link that has gone quiet (cable pulled, laptop woken from sleep): the hub pings every 20 seconds, and after two missed pings the app shows "Reconnecting…" in the profile menu and the top banner and reconnects with the usual backoff.
- All browser storage goes through one guarded helper, so blocked or full storage can no longer throw. Existing settings keep their keys and values.

### UI primitives

- New shared UI primitives in `ui.tsx`: Banner, Popover, Tooltip, Kbd, EmptyState and Skeleton (documented in `docs/DEVELOPMENT.md`). Adds `@radix-ui/react-popover` and `@radix-ui/react-tooltip`. Nothing uses them yet.

### Desktop hardening

- The desktop app now sets a Content Security Policy on its own pages (the connection screen and the Server terminal): no inline or eval script, and no network access beyond the app's own commands.
- Groundwork for local desktop notifications: the app ships the notification plugin, and the hub page may raise a notification only while the window is not focused. Nothing triggers one yet.

### Cheaper default models

- A bot that creates another bot no longer hands it its own model: without an explicit pick the new bot gets Sonnet 5, so an Opus lead no longer fills a room with Opus workers. The create/update bot tools tell bots to use Sonnet for workers, Haiku for simple or routine bots, and Opus only when you ask or a lead truly needs it.
- Model pickers mark Opus and Fable with "uses your plan limit much faster", and Auto now reads "Sonnet, moves up when needed".

### Folder uploads

- The Files panel uploads whole folders: an "Upload folder" button (hidden on iPhone, iPad and Android, which can't pick folders) and dropping folders onto the panel. The folder structure is kept under the folder you're in, empty folders included when dropped. A progress line shows "Uploading 12 of 340: path" with a Cancel that stops after the current file. Files already there are asked about once for the whole batch (Replace all, Skip existing, Cancel), and files over 25 MB are listed at the end instead of stopping the upload. A folder upload takes at most 1,000 files and 500 MB, and asks first above 200 files. `.git/`, `node_modules/`, `.DS_Store` and `Thumbs.db` are left out, and so are files that look like keys (`.env*` except `.env.example`, `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.pfx`, `id_rsa*` and other SSH keys, `service-account*.json`), with a warning that lists them.
- Hub: `POST /api/rooms/:id/files/upload` and `/files/folder` take `parents: true` to make missing folders on the way (`mkdir -p`). Every folder name is checked like a file name, and the path rules stay the same: no `..`, absolute paths, drive letters, backslash tricks, NUL, or links that lead outside the room's folder. A Windows hub also refuses device names (`nul`, `com1.txt`) and `< > : " | ? *` in new file and folder names, so `a.txt:x` can no longer write to a hidden stream.

### No keys in the repo

- The hub no longer ships a built-in Supabase project. Accounts are on only when `POCKETROCKET_SUPABASE_URL` and `POCKETROCKET_SUPABASE_KEY` are both set; otherwise the app runs signed out with accounts off. On a server, set them in a systemd drop-in (`docs/SERVER.md`, "Accounts").
- Desktop release builds take both values from GitHub Actions secrets at build time and pass them to the hub they launch. A build without the secrets works, with accounts off.
- The marketing site's newsletter form now posts to its own `/api/subscribe` function, which holds the Supabase settings in the Vercel project's environment (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`). The page itself no longer contains any project URL or key.

### PC runner and key kill switch

- New PC runner (`scripts/pc-runner/`): a small Windows helper that runs owner-approved jobs from the server hub in folders you allow on your PC. It connects over an outbound SSH tunnel, shows the full prompt in a Run / Refuse dialog before anything runs (no answer in 10 minutes means Refuse), and runs Claude with a fixed tool list, never with permission checks off, and without loading any settings, hooks or MCP servers from the job folder itself. Jobs cannot edit `.git/`, `.gitattributes` or `.gitmodules`, and git runs with fsmonitor, pager and hooks forced off. Desktop shortcuts turn it on and off; it never starts by itself. See `scripts/pc-runner/README.md`.
- Server: `deploy/keys.sh` lists every key the hub holds, by name only, with where to rotate each one. It can also move them all out of the hub at once and put them back later, or shred them. See "Kill switch" in `docs/SERVER.md`.

### Key routing (hub)

- New `data/key-registry.json` lists your keys by name with a tier (0 public to 3 critical) and where each lives (`vps`, `pc`). Tier 3 keys are PC-only; an entry that puts one on the server is rejected. Bots see the names in their prompt and ask the new `where_to_run` tool, which answers `vps`, `pc` or `blocked` by a fixed rule; the model never picks. See "Key registry" in `docs/SERVER.md`.
- `run_on_pc` takes `needs` and refuses keys the registry does not put on the PC. An outside MCP server may declare `needs`; one that needs a tier 3, PC-only or unknown key is not mounted on the server.
- Only a browser signed in with your owner password can allow a `run_on_pc` card. The server token alone can only deny it, so a bot that read `hub-token` cannot approve its own job.
- Changing the owner password now needs the current one, even with the server token. A forgotten password is cleared by starting the hub with `POCKETROCKET_RESET_PASSWORD=1`.
- Web: a `run_on_pc` card in a window that is not signed in shows "Sign in to approve" in place of Allow, which opens a small password prompt and then offers Allow. With no password set yet, the card links to Settings › Security. Deny always works, and a refused Allow shows the hub's reason on the card. Settings › Security always asks for the current password before changing it, and Settings › PC runner warns when no password is set.
- Bots' file and shell tools are now refused the hub database (`pocketrocket.db` and its `-wal`/`-shm`/`-journal` files), the legacy `claudebot.db`, and any `.db` or `.sqlite` file at the top of `data/`, just like `hub-token`. This guard reads the command line and is not a wall; the PC's own Run / Refuse dialog stays the final check on a PC job.

### PC runner (hub)

- Bots can ask your own PC to run a Claude Code job with the new `run_on_pc` tool, in a folder the PC allows. You approve every job on a card, even with approvals bypassed (no "always" and no approval rule covers it), and the PC asks you again before it starts. One job runs at a time, at most five wait, a job nobody picks up within 30 minutes expires, and the bot gets back at most 20 KB of redacted output.
- The PC's helper signs in with its own token from `POST /api/pc-runner/token`, shown once. The hub keeps only its sha256 in `pc-runner.json`, and the token reaches only the runner's own routes. `DELETE /api/pc-runner` turns it off and cancels every open job.
- Settings has a new PC runner section (desktop only). It shows whether your PC is paired and online, when it was last seen and which folders it allows. From there you can make a new pairing token, which is shown once (masked, with reveal and copy) and replaces the old one, or turn the runner off. It also lists the last 50 jobs with status, bot, chat, folder, time, duration and cost; click a job to read its full prompt and output as plain text. The list updates live.
- New owner-only routes `GET /api/pc-runner/jobs?limit=50` and `GET /api/pc-runner/jobs/:id`, and a content-free `pc-runner.changed` WebSocket event. The runner token and paired phones get 403. Jobs now record when they started and finished and how long the PC says they ran (migration 161).
- Approval cards for `run_on_pc` and outside MCP tools no longer offer "Allow for this session", which was never remembered for them anyway. A `run_on_pc` card shows the folder and the prompt as written, wrapped, instead of raw JSON.

### Outside MCP servers and key files

- `data/mcp-servers.json` can now list local stdio servers (`command`, `args`, `env`) as well as remote ones. `command` must be `npx`, `node` or an absolute path, and every `env` value is scrubbed from chat and logs like the hub's own tokens.
- Each outside server takes `approve`: `every-call`, `writes` (with `readTools` listing the tools that skip it) or `none`. You get an approval card for those calls even with approvals bypassed, and "Always" or an approval rule never covers them. The card shows the whole input; a call whose input is too long to show in full (over 8000 characters) is refused instead. Stdio servers default to `every-call`; existing url servers stay at `none`.
- Bots can no longer read or write the hub's key files (`hub-token`, `secrets.json`, `mcp-servers.json`, `pc-runner.json`, the account session, the push and vault keys, `keys-disabled/`) or a project's `.env` files with their file and shell tools, in any approvals mode. `.env.example` stays readable, and `pnpm dev` and test runs still load `.env` themselves. A shell command that names one of those key files is refused however it is quoted or escaped. A command that builds the name at run time can still get past the check; it covers the ordinary ways a bot would read those files.

### Memory fixes

- A bot whose chat context was reset, or that joins a busy chat, is shown at most the last 60 unread messages (or 30 KB). A line says how many earlier ones were left out, and the bot can read them with `read_room`.
- `update_memory` and `write_note` refuse text that contains something shaped like an API key, token or bearer header, so secrets never land in memory or notes.
- When a bot's memory passes 75% of its 8 KB limit, auto-memory merges it into a shorter version instead of letting the oldest notes fall off. The old file is kept as `memory.md.bak`, a line in the chat says so, and text between `<!-- keep -->` and `<!-- /keep -->` is kept word for word.
- The Memory tab shows how much of the limit is used and when auto-memory last saved.
- Server: the daily backup stores a consistent copy of the database instead of the live files, and now includes the service user's Claude session transcripts. Claude Code no longer deletes bot sessions after 30 days (`cleanupPeriodDays` is 3650 for bot turns, and server setup sets it for the service user; the hub never edits your own `~/.claude/settings.json`).
- The hub logs at start how many `data/bots/` folders belong to no bot; `node scripts/prune-orphan-bot-dirs.mjs` lists them and `--apply` moves them to `data/trash/`.

### Scrolling and small screens

- The chat no longer slides sideways or leaves blank space at its end. Long paths and links wrap, and wide tables scroll inside their own box.
- The page itself no longer bounces when a list reaches its end.
- On a window between 820 and 979 px wide, opening the screen folds the sidebar away instead of covering the whole window. The sidebar comes back when the screen closes.
- Phone: the app fits the visible screen when the keyboard opens, dialogs fit too, toasts sit above the message box, and the sidebar button sits in the page header instead of taking a column.
- Icon buttons are 40 px on touch screens. Unread dots use the accent color. A one-on-one chat header has one button to the bot's page instead of two.
- A chat shows grey placeholder messages while it loads, and the screen panel's empty message is centred.
- Deleting a bot, chat, skill, schedule, trigger or recording, and resetting a chat's context, now ask in an in-app dialog instead of the browser's pop-up.

### Room file folders

- Every chat has a file folder. A project's chat uses the project folder, any other group chat gets its own folder under `data/rooms/`, and a direct chat uses the bot's `files/` folder.
- A bot can now open only the folder of the chat it is replying in. A bot asked about a project from a direct chat or another room can no longer open or search that project's folder.
- New owner-only Files API (`/api/rooms/:id/files`) to list, preview, download, upload (up to 25 MB), rename, move, delete and make folders. Paired phones cannot use it.
- New Files panel. The folder icon at the top right of a chat opens the chat's folder beside it, or full screen on a phone. It has large tiles (folders, and files with a coloured type badge and their full name), a list view with size and modified date, breadcrumbs, previews (images, PDF, Markdown, text and code), download, upload (button or drag and drop), new folder, rename and delete with a confirmation. Keyboard: arrow keys, Enter, Backspace to go up, F2, Delete and Shift+F10. A link to a file in a message now opens it in Files. A screen you were watching stays connected while Files is open. A paired phone is told that Files open in the desktop app.
- Desktop app: files dragged from Explorer now drop into the Files panel (the window no longer takes drops itself).

### Every group chat has a coordinator

- A group chat with two or more bots always has a coordinator, so a message with no @mention always reaches someone. The hub prefers a bot whose handle or title reads as a lead (`wika-lead`, `chief`), else the first bot. An older chat with none gets one on its next unaddressed message, with a line in the chat saying who.
- Outside MCP servers can be given to a room (`rooms` in `data/mcp-servers.json`, by id or name): every bot working in that room gets them.
- Desktop: Ctrl + plus, Ctrl + minus and Ctrl + 0 zoom the app.

### Outside MCP servers for named bots

- The owner can give named bots an outside MCP server (for example the Wika dashboard) in `data/mcp-servers.json`: a name, an `https` address, an optional key and a list of bot handles. It is read on every turn, so no restart is needed.
- These tools are never pre-approved: outside bypass mode each call asks. The key is scrubbed from room messages. Claude provider only.

### A smaller development team template

- A project's development team is now three bots: a lead, an engineer and a quality engineer. Each gets the `safe-shipping` skill, so it cannot push to the default branch.
- The project folder gains `TEMPLATE.md`, which says which template version the team came from.

### Leave full screen in the desktop app

- Press Alt+Enter to switch between full screen and a normal window you can minimize and drag between screens. The tray menu has it too.

### A new sidebar

- Each group is now a section listing its bots, with `Name · Role` and the bot's latest message. Click a group's name for its chat, or a bot for a chat with it.
- Search finds a message in any chat and opens it with the words highlighted.
- A bot with no icon picked wears its own creature, and bot messages sit in bubbles.
- A room holds up to 20 bots.
- Sidebar sections fold with the arrow beside their name, and stay folded on that device. A folded section shows how many bots it holds, any unread chats, and the chat you have open.

### Project folders and team templates

- A project is a shared folder, and you choose which bots work in it under Settings, Projects. See `docs/project-folders.md`.
- Bots search their projects with `search_project_context`. Outdated files are skipped, current facts come first, and each result shows its date. A check flags files that are expired, undated or duplicated.
- Attach the `safe-shipping` skill to a bot to stop it pushing to the default branch or merging a pull request.
- A new project can start with a development team cloned from a versioned template, with its own group chat.
- Bring a Claude project's context into a project folder three ways: a drop folder, a Claude data export, or a connector Claude saves to from inside the project. Everything is scrubbed for credentials and contact details, and reviewed by you first. See `docs/context-import.md`.

### Podium and Persona

- Up to three main bots sit large above the bot list, chosen with the pencil on the podium.
- Ten new character icons for bots, drawn as little creatures.
- A bot you name as Persona can read what you wrote across every chat, with known secrets redacted. It sees only your messages, and no bot can grant this to itself.

### Bots keep going after the step limit

- A turn that runs out of steps now resumes up to twice, as intended. The check never matched the error the Claude provider really reports, so these turns stopped dead instead.

### Run with no spending caps

- `POCKETROCKET_NO_SPEND_CAPS=1` turns off the per-reply, per-request, trigger and training budgets, for a server on a flat subscription. Off by default.

### Bots know the owner by role

- Your messages reach bots tagged with your role, like `[Shiroo (owner)]`, so renaming yourself no longer makes bots treat you as a stranger, even in a chat that started under the old name.
- Text inside a message can no longer pass for you. The hub rewrites anything that reads like a sender tag, so a forwarded email or a bot's message cannot fake a line from the owner.

### Fewer computers, and no fixed limit

- A bot's computer now starts when it first uses Browser or Desktop in a turn, not on every turn. Bots that only talk no longer hold one.
- Selecting a bot or opening the app no longer starts computers. Opening a bot's screen still does.
- No fixed limit on running computers. Memory decides: idle computers stop to make room, and a start is refused only when memory is short and all of them are busy. `MAX_RUNNING_COMPUTERS` still sets a cap if you want one.
- Several chats can share one computer. A chat that reaches a busy browser opens its own tab first, so they do not drive the same page. While shared, closing or selecting a tab by number is refused, since numbers shift: a chat closes its own current tab.
- New `view_screen` tool: a bot can see the screen of another bot in its room, read only, without starting anything.

### Bot browsers keep their logins

- Logins in a bot's browser now survive its computer restarting. Sites that sign in with a session-only cookie used to log out on every restart, and Chrome now closes cleanly so a recent login is not lost. Tabs open in the browser window can reopen after a restart.

### Sign-in and activity log

- Sign in with a password from the browser instead of pasting the server token. Sessions last 30 days in an httpOnly cookie. Set it in Settings, Security. The server token still works for the desktop app and scripts, and resets a forgotten password.
- See which browsers are signed in, and sign out one or all others. Changing the password signs out the others.
- Activity log in Settings, Security: sign-ins and failures, permission level changes, approval answers, changes to bots, rooms and routines, including those bots make themselves. It holds labels and ids, never message or request contents.

### Identity and permissions

- The owner has a stable user id, separate from the display name. Renaming no longer makes bots treat the owner as a stranger; earlier names are kept. `GET /api/me` returns the current user.
- New permission level, Read only, beside Approval and Full permission. Pick it next to the model above the Send button or in Settings. It applies to all bots.

### Desktop

- No menu bar, and the app opens full screen. Connection settings, Reload, logs, updates, About and Quit are in the tray menu.

### Group chats and defaults

- The bot list leaves out bots already in a group, and every group chat is always shown with an edit button. The message box grows with your text, and the status shows a colored dot.
- New bots default to a $50 budget.

### Bot training

- **Training (pilot):** off by default, per bot, in the bot's Memory tab. Once a week a cheap pass reads that bot's own
  denied approvals, failed turns and your replies, and may propose one short rule. A separate check passes or blocks it. A
  rule reaches the bot only when you approve it, as a line under `## Lessons` in its description, and Undo takes out just
  that line. At most $0.10 a pass and $0.25 a week per bot, shown in Usage.

### Profile pictures and group details

- **Your profile:** Edit profile in the menu at the bottom left sets your name and picture. They show there and on your
  messages. With no picture you get your initial on a neutral tint.
- **Bot pictures:** a bot can wear an uploaded picture instead of a line icon. Icons stay the default.
- **Group details:** click a group's name in the chat header to change its name, picture or icon, its bots and its
  coordinator. A group keeps at least one bot and at most 10. Removing a bot stops what it was doing in that chat.
  Name and membership changes show as a line in the chat.
- Pictures live on your hub, under `data/media`. PNG, JPEG and WebP only, checked by content, at most 512 px and 512 KB.
  They need your hub token or a paired device's to view. A paired phone can see them but not change them, and no bot can
  upload or set one. Pictures nothing uses any more are removed after a day.

### Computers start themselves

- Opening the app starts the computer of the bot you have open and of the most recently used other bot. Selecting
  a bot starts its computer after 1.5 seconds. One place always stays free, and a computer a person controls or a
  bot is using is never stopped for this. The Wake button is gone; a failed start says why, with **Try again**.
- **Keep awake is now Always on.** It starts the computer, brings it back after a server reboot, and is limited to
  `MAX_RUNNING_COMPUTERS` minus 1 (2 by default). Past that the switch refuses and says why.
- Low memory (under 1.6 GB available) stops these automatic starts. A bot's turn still gets its computer.
- A paired phone wakes a computer only when you open that bot's screen.
- The embedded screen no longer shows noVNC's side menu or its "unencrypted" banner. Pop-out still has them.
- Needs you is right straight after a reload, including rooms not opened yet.
- Trigger prompts no longer need to mention `NO_REPLY`; the app adds the way out itself.

### Model picker and Auto routing

- A model picker sits under the message box, next to Send: Auto, Sonnet 5, Opus 5 or Haiku. It changes this chat only,
  never the bot, so schedules and hand-offs keep each bot's own model. A pick stays on, with its label by Send, until
  you change it. It is hidden on paired phones and on providers other than Claude.
- Auto now decides inside the turn. Sonnet 5 runs it and can move itself up to Opus 5 in the same session, for that turn
  only, or hand off to a better bot. Each shows as one line in the chat. The Smarter Auto routing switch is gone.
- A first hand-off to a bot outside the chat asks you, because that bot has different logins and tools. From a direct
  chat, it works in its own chat and its result comes back as one message. Your yes is an approval rule in Settings.
- Routing rules: `data/routing.md`, edited in Settings. Bots read them every turn and can only propose a line, which you
  approve on a card. No bot can write the file, whatever the approvals setting.
- A skill named in a forwarded email can no longer pick Opus. Only your own newest message or a routine's prompt can.

### Name and install

- The screen's size follows what you do: a small thumbnail while a bot uses its computer, a split when you click to
  watch, and the full pane when you take over. Hand back returns to the size you came from. The Zoom in and Fit view
  is gone; Expand and Pop out replace it.
- One control bar, on the screen, with one Hand back and its note. Take over on a bot's request card claims control
  and opens the screen in one click, and the card adds "I can't do this", which goes back to the bot as your note.
- The screen follows the chat. If you hold a screen and open another chat, it stays up and says so, with a link back.
- A Bot page holds Memory, Writing style, Skills, a bot's Automations and its Computer (disk, Keep awake, Teach,
  recordings). Open it from the bot's name. Automations and Usage are fleet pages in the menu at the bottom left, and
  the estimate moved out of the chat header onto Usage.
- Each turn shows one work line in place of the tool pills: "Worked for 1m 12s · 14 steps · 1 retried", which expands
  to the steps. Answers, cards and failures the bot did not recover from stay visible.
- Settings has a Connections screen: one Connect button for GitHub and Google after a one-time app setup. WhatsApp
  and social media stay in a bot's browser.
- Drag the sidebar's and side panel's edges to resize them, or use the arrow keys. Enter collapses, double-click
  resets, sizes are remembered per browser, and the chat always keeps 440px. Group chats fold away.
- A menu at the bottom left shows your name and the server's state, and holds Usage, Settings, Open workspace, the
  theme and Sign out. Text no longer wraps or clips in narrow panes.
- The app font is Google Sans, with Figtree as a choice in Appearance. Fonts are bundled, not fetched from Google.
- A lighter look: warm off-white and charcoal colors, softer text, a 15/24 message size on a seven-step type scale,
  flat surfaces without the background wash or stacked shadows, and 10px corners on controls instead of pills.
- The app shows its name as PocketRocket everywhere, and the sidebar no longer shows the provider and model
  unless there is a problem.
- A server install starts with two bots, each created once: PocketRocket Support reads the app source without
  approval cards (not `data/`), and Data Engineer keeps the shared workspace organized and indexed.
- A bot that reads or posts in a chat it is not in now asks first with an approval card. Chats it belongs to need no card, and "Always" covers that one chat.
- Room members can be set up to 10 bots over REST (was 6), matching what bots can do.

- Bots wear a line icon on a soft tint instead of an emoji. Each bot gets one from its ID, and you can pick another in
  its settings. On upgrade, known emoji become the matching icon and custom emoji or short text become automatic.

### Each bot's own computer (server)

- A bot with Browser or Desktop gets its own virtual display, desktop, Chromium profile (its own logins)
  and disk, with the shared workspace linked as `~/Shared`. Computers are separate but **not isolated**:
  every bot runs as the same OS user.
- Computers start on first use and sleep after `COMPUTER_IDLE_MIN` (30) idle minutes; at most
  `MAX_RUNNING_COMPUTERS` (3) run at once. A soft disk quota (`COMPUTER_QUOTA_GB`, 10) warns at 80% and
  keeps the computer from starting at 100%. Existing logins move to the first Browser bot once.
- The Screen tab follows the selected bot: Asleep / Starting / Live, **Wake**, **Keep awake** and a disk
  badge. A screen ticket opens one bot's screen only.
- **Take over, Hand back, Pause** in the Screen tab and a bot's DM header. While the bot has control you
  only watch; take over and you can click and type. The bot's computer tools refuse while you have control,
  also in bypass mode. A paused bot starts no turns until you resume it.
- Bots can ask for you with `request_takeover` ("@shopper needs you: log in to example.com"); hand back
  with a note and the bot carries on.
- Deleting a bot stops its computer and erases its disk. The desktop app, and servers with per-bot
  computers off, keep the one shared screen.

### Approvals

- **Routine and trigger turns always ask**, and so does every bot hop they cause, even when approvals are
  bypassed. Nobody is watching a 3 a.m. routine.
- **Approvals while away.** A routine or trigger turn whose card nobody answers in 10 minutes parks
  instead of failing: the card stays open (also across a restart), and when you answer, hours later, the
  bot picks up where it stopped. A card parked for 24 hours is denied.
- **Approval rules.** After "Allow for this session" a card offers **Make this a rule?**; Settings › Bots
  › Approval rules lists and revokes them. Only you can create one. A rule never covers a dangerous
  command or an integration write. "Allow for this session" now covers the same command again, not every
  use of the tool.

### Automations: schedules and triggers

- The Routines tab is now **Automations**, with **Schedules** and **Triggers**.
- **Time zone** in Settings › Account; schedules run on that clock. **One-shot** schedules fire once at
  a date and time. Presets (once, daily, weekdays, weekly, monthly, yearly) write the cron for you; raw
  cron is under Advanced. The list shows schedules in words, next runs, and run history with cost.
- Bots can create, change and delete schedules (`create_routine`, `update_routine`, `delete_routine`);
  each shows an approval card first.
- **Triggers** wake a bot in a room when something happens in a connected integration: GitHub
  notifications and repository events, Gmail, Google Calendar, Google Drive, Slack, ClickUp and Teams.
  Events arrive by outbound polling and Slack Socket Mode; the hub opens no inbound port. Each trigger has
  filters, a prompt with `{{event.*}}` placeholders, a per-hour limit and a per-day budget, **Send a
  sample event**, and its recent fires with cost and skip reasons.
- Trigger messages show as "Trigger: name", with the event folded under "Event (untrusted)".
- **Turns survive a restart:** a turn queued or running when the hub stopped resumes once on the next
  start. A handoff nobody answers in 10 minutes gets one nudge to the room's coordinator.

### Integrations

- **Settings › Integrations** connects GitHub, Google (Gmail, Calendar, Drive), Slack, ClickUp and
  Microsoft Teams, with your own OAuth app (PKCE and a loopback redirect; a device code for GitHub and
  Teams on a server) or a pasted token. Each card has setup steps, Test connection, Reconnect and
  Disconnect.
- Connections are shared, but a bot sees a provider's tools only after you switch it on for that bot.
- Bot tools read issues, PRs, notifications, mail, calendars, Drive files, channels, tasks and chats, and
  write issues, comments, mail, events, Slack posts, tasks and Teams messages. Reads are labelled as
  untrusted third-party content. **Every write asks, on every call, even under bypass.**

### Knowledge, notes and voice

- **Settings › Knowledge** takes a git URL (shallow clone, pulled hourly and on **Sync now**) or a local
  folder. Every bot can read and cite it; none can write it.
- Per-bot **notes** (`write_note`, `search_notes`) that stay out of the prompt, and a per-bot **voice**
  (style notes in every prompt, editable in the Memory tab). Auto-memory may propose voice notes from your
  corrections; they wait for your approval.
- The prompt lists the bots not in the room; handing off to one in a group chat adds it, after a card.
- **Skills › From git** imports every `SKILL.md` folder of a repository as pending review.

### Models and usage

- **Auto model:** the hub picks the model per turn (Haiku for triage and memory, Opus when you ask it to
  think hard or a skill asks for it, Sonnet otherwise) and moves a turn that hits the step limit to Opus,
  within the bot's budget. An optional one-shot classifier is in Settings › Claude.
- A **model chip** on every bot turn shows the model and why. The Usage tab breaks spend down by model and
  by what started it.

### Phone and desktop app

- **Pair a phone** in Settings › Devices with a QR code and a one-time code (never the hub token). The list
  shows when each device was paired and last seen; a revoked phone is cut off at once.
- A phone can chat, answer approval cards (once only), watch the Screen and manage Automations. What it
  may not do is hidden: creating or editing bots and rooms, settings, integrations and approval rules.
  Settings on a phone shows Devices, read-only Appearance and About.
- **Installable web app** (PWA) with a phone layout, and opt-in **Web Push** that says only "A bot needs
  your approval", "Routine finished" or a test line.
- Phone access over **Tailscale Serve** with `POCKETROCKET_ALLOWED_HOSTS`, off by default.
- Desktop app: **tray icon and close-to-tray** (the hub and bots keep running), and **Linux** (AppImage,
  deb) and **macOS** (unsigned dmg) builds.
- Settings sections are Account, Claude, Bots, Integrations, Knowledge, Devices, Appearance, About.

### Server

- Per-bot computers run as a systemd user unit (`pocketrocket-computer@.service`); slot `n` uses
  display `:200+n`, CDP `9400+n`, VNC `5800+n` and noVNC `6200+n`, all on 127.0.0.1.
  `POCKETROCKET_COMPUTERS=0 bash deploy/setup-vps.sh` keeps the one shared screen.
- Optional **restic** backups (`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`). Backups skip browser caches
  and `vault.key`, and keep `vapid.json`, so phones need not re-subscribe after a restore.

### Teach by demonstration and skill versions
- **Teach a bot by showing it.** On a server with per-bot computers, the Screen tab has **Teach**: do the task on
  the bot's computer, press **Done**. You hold control while recording; a static indicator shows steps and
  screenshots. Recordings stay on the server and are erased with the bot.
- **Secrets are redacted while recording.** Passwords, card fields, one-time codes and credential-looking URL
  values are saved as `«secret»`; screenshots are dropped while such a value is on screen. Limits: 2000 steps,
  200 screenshots, 64 MB, 30 minutes.
- **Distill** turns a recording into a `SKILL.md` (one Sonnet call, at most $0.25) that waits for your review.
- **Skill versions.** Demos, your corrections ("no, use the Export button"), opt-in post-run reflection and a
  bot's `save_skill` on an existing name all propose a pending version with a line diff. Nothing changes until
  you **Approve**; `save_skill` no longer overwrites a skill silently.
- Phones can view recordings and versions and stop a recording; starting, distilling and approving stay on the
  desktop.

### Security

- The $5 per-thread cost cap now limits every turn (your messages, routines, triggers), not only
  bot-to-bot hand-offs.
- Integration tokens are encrypted at rest (AES-256-GCM, key in `data/vault.key`, owner-only), never
  reach a bot, and are scrubbed from output and logs.
- Trigger event text is fenced as untrusted data with a random nonce; placeholders get a quoted,
  single-line, capped copy. Each trigger has an hourly limit and a 24-hour budget, and the budget now also
  caps a trigger turn resumed after a restart or a parked approval.
- Shell commands that look read-only but write or run code now ask: `git diff`/`git log --output`,
  `--ext-diff`, `--textconv`, git global options, `rg --pre`, `sort -o` / `--compress-program`,
  `tree -o`, and option values that point outside the workspace.
- The knowledge folder is read-only to bots: file-tool and shell writes there ask, and are refused
  outright under bypass.
- Device tokens are stored hashed, and a phone reaches only the routes it is allowed. Web Push payloads
  carry no bot, room or message text.
- Errors in the hub log go through redaction, and the VAPID key is kept owner-only on every start.

### Fixed

- Password field values no longer appear in browser page snapshots, through a small patch to `playwright-core`.
- Browser snapshots and other Playwright output moved from the shared workspace to each bot's home, so they
  are removed with the bot and left out of backups.
- Backups are readable by root only and no longer include `data/hub-token`.
- Teach: fields for API keys, tokens and similar secrets are redacted in the trace and stop screenshots, as
  are pages whose URL holds a credential, and URL query values no longer reach the trace through window titles.
- A takeover waiting for the user survives a hub restart; the hand-back still starts the bot's turn.

- The hub no longer writes its token to the journal or the desktop app's `hub.log`. The startup line says where
  the token is instead. Rotate the token on any server that ran an earlier build: `docs/SERVER.md`.
- On a server, bots browse in real Google Chrome, not Playwright's Chrome for Testing started with `--test-type`.
  Chrome keeps its sandbox on Ubuntu 23.10+ instead of falling back to `--no-sandbox`.
- Approval cards left open when the hub stopped now show "Expired — the hub restarted. Ask the bot to
  retry." instead of staying clickable forever.
- Editing a DM can no longer give it more or fewer than one bot.
- Deleting a bot from the app also deletes its folder (memory, identity, skills), as the `delete_bot`
  tool already did.
- The avatar initial and the Chief-of-staff preset use your name from Settings instead of "Alex".
- Pending skills in the Skills tab get their amber outline back.

## [0.2.0] - 2026-09-16

First public release. (`0.1.0` was the internal Claudebot-era version, so the first release under
the PocketRocket name starts at 0.2.0.)

### Added

- Sound cues (send, reply, approval request, approve/deny, turn done/error, desktop connected), on
  by default, respecting `prefers-reduced-motion`.
- First-run onboarding wizard: detect the Claude CLI and login, name yourself, create a first bot.
- Redesigned Settings, in sections: Account · Claude · Bots · Appearance · About.
- **Optional PocketRocket account.** Sign in from Settings → Account with GitHub; the browser
  opens, and the app is signed in when you return. Entirely optional — everything works signed
  out; an account exists to enable paid plans later. Email sign-in is built but stays off until
  the project has its own email sender.
- Models offered: **Sonnet 5** (default), **Opus 5**, **Fable 5.1**, **Haiku 4.5**, picked per bot.
- A bot can now start its own group chat with `create_room` instead of only being addable to a room
  you made first — it's added automatically and becomes the coordinator unless it names another
  member.
- **Bots can manage any room, not just the one they're replying in.** Every room tool takes an
  optional `room` (name or id) and defaults to the current room, so existing behaviour is
  unchanged. `list_rooms` is new and shows every room with its id, kind and members, which is how a
  bot finds a room it isn't in. `delete_room` is new and disbands a group chat and its history
  while leaving the bots themselves alone; it needs `confirm=true`, refuses DMs, and refuses the
  room the turn is running in rather than deleting the transcript mid-reply.
- **Open the shared workspace folder from the sidebar.** The hub opens it on the machine it's
  running on, because that's the only machine the folder exists on: Explorer on Windows, Finder on
  macOS, and on a server hub the file manager on the virtual display, which is the desktop the
  Screen tab already shows.
- Landing site (`packages/site`), live at <https://pocketrocket-chi.vercel.app>, with real
  screenshots of the app in the hero.
- Bot memory is capped at 8 KB. It's injected into the system prompt on every turn and bots are
  told to record anything durable they learn, so an append-happy bot would otherwise have made
  every later turn steadily more expensive. Older notes are dropped first, and `update_memory`
  tells the bot when that happened so it prunes deliberately instead of writing into a file that
  silently forgets.
- Auto-memory: every 10 completed turns of a bot in a room, a background pass on Haiku 4.5 appends
  new lasting facts from the conversation (preferences, decisions, ongoing work, names/IDs) to the
  bot's `memory.md`, so bots remember more than what they chose to `update_memory`. Append-only,
  never delays the room, costs are tracked in usage, and the room gets a short "saved N notes"
  line when anything was saved. On by default; per-bot toggle and interval (3–100 turns) in
  Settings → Bots. Claude provider only.
- The layout adapts to narrow windows: the bot list and side panels become drawers instead of
  being squeezed into the middle column.
- First-run setup checks that Claude Code is installed and signed in, and shows your Claude plan.
- Keyboard access to the bot list and room list, matching the onboarding cards' roving-tabindex
  pattern.
- A "Can't reach the hub" card with a retry button when the hub connection drops, and fewer false
  "token expired" prompts around a reconnect.
- Creating a new bot now opens its chat instead of leaving you on the list.
- A "new messages" jump button when you've scrolled away from the bottom of a room, and older
  messages now load automatically when you scroll to the top.
- Desktop: on first run, the app can scan `~/.ssh/config` for servers and check the ones you tick
  using your SSH key only — it never tries a password — and detects your local Claude account.
- Desktop: a "Back to PocketRocket" link from the connection settings screen.
- Desktop: hub and SSH tunnel failures that happen after a successful connect are now reported
  instead of failing silently.
- Desktop: the app now enforces a single running instance.

### Changed

- Chat links now open in your default browser instead of navigating the app away from your bots.
- Approval notices are clearer about what's being asked and why.
- Setup errors (onboarding and Settings → Claude) are now shown inline on the step where they
  happened instead of only in the console.
- Desktop uninstaller's data-delete option is relabeled "Also delete all bots, conversations and
  settings" and is unchecked by default, so a plain uninstall keeps your data and ticking the box
  is an explicit, informed choice.
- Renamed the project from Claudebot to **PocketRocket** across packages, env vars, data paths,
  systemd units, and the desktop app identifier.
- **Claude only in this release.** v1 ships one provider — the Claude Agent SDK, driving your own
  Claude Code CLI and subscription login, or an `ANTHROPIC_API_KEY`. OpenAI Codex, OpenCode and
  Grok adapters exist in the codebase behind a dev-only flag but are not offered as a user-facing
  option; see the Roadmap in README and CONTRIBUTING.md. More providers are planned.
- Much smaller download: the hub bundle went from 271 MB to 62 MB (Windows installer ~30 MB) by
  dropping the Claude Agent SDK's vendored copy of the Claude CLI, which PocketRocket never runs —
  it always drives your own `claude.exe`.
- The installed executable is `PocketRocket.exe` (it was `pocketrocket-desktop.exe`); the Start
  menu and desktop shortcuts were already named PocketRocket.
- **The hub token is reused across restarts instead of re-minted.** `ensureHubToken` wrote
  `<data>/hub-token` on every start but never read it back, so each start produced a fresh value
  and every deploy, `systemctl restart` and tsx-watch reload invalidated the token the open UI was
  holding — the next request 401'd and the "paste the hub token" panel appeared. The stored token
  is now reused when it's exactly 32 hex characters, and minted only on first run or when the file
  is missing or malformed. `POCKETROCKET_ROTATE_TOKEN=1` restores the old per-start rotation.
- **The Screen tab no longer asks for a VNC password.** `x11vnc` ran with `-rfbauth`, so opening
  the tab prompted on every load for something the hub was already enforcing: `/screen/*` needs
  the hub token, spent on a single-use ticket for a `/screen`-scoped httpOnly cookie, before the
  proxy is reached at all, and both VNC and noVNC bind loopback only. `x11vnc` now runs `-nopw`,
  and `setup-vps.sh` deletes the password files an earlier setup generated.
- The per-run step limit went from 40 to 80 and is now tunable with `MAX_TURNS_PER_QUERY`. 40 was
  tuned for chat and is tight for computer use, where a navigate, a snapshot and a click are three
  steps. The live cost brake is the bot's per-turn budget, which the SDK enforces mid-run, so the
  step count only ever had to catch a loop that is cheap but endless.

### Security

- **Approvals ask by default; bypass is an explicit, warned opt-in.** Bots ask before shell
  commands, edits outside the workspace, and fleet/room changes, and approval cards appear inline
  in chat. Settings → Bots → **Approvals** switches a bot to bypass mode — no approval cards, no
  undo. Server operators can pin the whole hub to bypass mode with `POCKETROCKET_BYPASS_PERMISSIONS`.
- **Signing in sends only your email to PocketRocket's auth provider (Supabase).** Bot
  conversations, files and keys never leave your machine or server; the account system doesn't
  touch them. No outbound calls beyond the Claude provider, the GitHub releases page (update
  check), and Supabase auth when you choose to sign in.
- The Screen tab no longer puts the hub token in a URL. An `<iframe>` cannot send an
  `Authorization` header, so the token used to ride the noVNC query string, where it sat in the
  DOM, in history, and in anything that later read `location`. The app now spends the token once
  on a normal authenticated `POST` for a single-use ticket, and the browser trades that ticket for
  an httpOnly cookie scoped to `/screen` that it can never read back. `?token=` is refused on
  `/screen/*` outright, and the cookie authenticates nothing else — presenting it to `/api/*` gets
  a 401.

  Fixes from the pre-release security review (see [SECURITY.md](SECURITY.md) → Audits):

  - The hub token is now always on — there is no unauthenticated mode. It's auto-generated when
    `POCKETROCKET_TOKEN` is unset, written to `<data>/hub-token` (0600), and printed at startup as
    `http://127.0.0.1:7788/#token=…`.
  - `Origin: null` is no longer whitelisted; REST/WS requests from a sandboxed iframe or any other
    `null`-origin context are rejected like any other foreign origin.
  - `/screen/*` (the noVNC desktop bridge) now requires the same bearer token as every other
    route, instead of being exempt.
  - Bash/path permission rules tightened: relative-path and post-`cd` resolution, denial of
    interpreter eval/exec flags, and `isInside` now requires the canonical path **and** its
    realpath both stay inside the allowed roots, instead of either one being enough.
  - Bot CRUD and tool-grant changes now go through a human approval card; a bot can no longer
    widen its own tool grants unattended.
  - Provider child processes get a per-provider environment allowlist instead of the hub's entire
    `process.env`.
  - `secrets.json` permissions are re-applied on every write, not just when the file is first
    created.
  - CI hardened: a top-level `permissions: contents: read`, every third-party GitHub Action pinned
    to a commit SHA, and Dependabot configured for `github-actions`, `npm`, and `cargo`.
  - Redacted the local Windows username and an internal SSH host alias out of screenshots, test
    fixtures, and docs, and widened `.gitignore` to catch `.env*`, `secrets.json`, `auth.json`,
    and `hub-token` going forward.

### Accessibility

- The provider/onboarding cards could not be reached with a keyboard: they are `role="radio"` on a
  `div` with neither `tabIndex` nor a key handler, which also made the onboarding wizard's first
  screen mouse-only. They now use a roving tabindex, Enter/Space to choose, and arrow keys to move
  between cards.
- Buttons had no focus ring of any kind. Every button, toggle chip and segmented control now shows
  one on keyboard focus, and text fields no longer stack the browser outline on top of theirs.
- No field in any dialog was programmatically labelled: the caption rendered as a plain `<span>`.
  Captions are now real `<label for>` elements tied to their control, and captions over groups of
  toggle buttons name the group through `aria-labelledby`. The API-key rows, the hub-token prompt
  and the sounds switch got accessible names too.
- Toggle chips report `aria-pressed`, the theme picker is a named group, bot avatars carry an
  `aria-label` instead of a mouse-only `title`, and decorative emoji are hidden from screen readers.
- Light-theme text failed WCAG AA, in some places badly: the `--dim` colour used for hints sat at
  2.15:1 where 4.5:1 is required, and `--muted`, `--accent`, `--ok`, `--warn` and `--bad` were all
  under the bar as well. Every text colour in both themes is now at least 4.5:1 against the
  lowest-contrast surface it appears on. The dark theme needed only one change.

### Fixed

- **A bot whose saved session had vanished was stuck forever.** The Claude CLI owns its own
  session store, not the hub, so a re-login, a `cleanupPeriodDays` sweep or a redeploy can drop the
  transcript the `sessions` row points at — after which every turn in that room died with "No
  conversation found with session ID" until someone nulled the row by hand. The runner now
  recognises that wording, forgets the dead token, says so in the room, and reruns the same input
  once from a fresh session.
- A turn that ran out of steps ended with `error_max_turns` and abandoned the job mid-task. It now
  resumes the same session and carries on, at most `MAX_TURN_CONTINUATIONS` times (default 2),
  each one re-checked against the remaining budget and the abort signal, and each announced in the
  room so a long turn is visible rather than mysteriously slow.
- The bundled hub reported version 0.1.0 whatever the real version was, and could not find the
  Browser tool's Playwright CLI, because it looked for its own files in the source layout rather
  than the installed one.
- The desktop app always ran the hub on its own bundled Node and reported it as "system node",
  because Windows resolves a bare `node` to the copy sitting next to the app before looking at
  your PATH. If you have Node 22.13+ installed, the app now uses it, as documented.
- Bots no longer fail with "Claude Code X does not support this model; version Y or newer is
  required" when a new model needs a newer CLI: the hub runs `claude update` and replays the turn
  once (only when no tool had run yet). If the update fails, the turn error says so and asks for a
  manual `claude update`.
- Server mode: the service user's Claude Code CLI is also kept current by an hourly cron job
  (`deploy/claude-update.sh`, installed by `setup-vps.sh`).
- Desktop no longer freezes the whole UI while connecting over SSH.
- Desktop: clearer SSH error messages (bad key, host unreachable, unknown or changed host key)
  instead of a generic connection failure.
- README's Quick start now gives the correct Claude Code install command (the native installer).

## [0.1.0]

- Initial internal version (Claudebot): Claude-only hub, DMs and group chats, memory, skills,
  routines, VPS deploy scripts with a shared virtual desktop.
