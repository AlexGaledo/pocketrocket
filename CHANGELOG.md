# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Entries are grouped by feature area; per-phase notes live in `docs/changes/pN.md`.

### Bots know the owner by role

- Your messages reach bots tagged with your role, like `[Shiroo (owner)]`, so renaming yourself no longer makes bots treat you as a stranger, even in a chat that started under the old name.

### Fewer computers, and no fixed limit

- A bot's computer now starts when it first uses Browser or Desktop in a turn, not on every turn. Bots that only talk no longer hold one.
- Selecting a bot or opening the app no longer starts computers. Opening a bot's screen still does.
- No fixed limit on running computers. Memory decides: idle computers stop to make room, and a start is refused only when memory is short and all of them are busy. `MAX_RUNNING_COMPUTERS` still sets a cap if you want one.
- Several chats can share one computer. A chat that reaches a busy browser opens its own tab first, so they do not drive the same page. Bots find their tab by URL before closing it, since tab numbers shift.
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
