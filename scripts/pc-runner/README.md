# PocketRocket PC runner

Lets a bot on the VPS hub ask for a Claude job to run in a folder on this Windows PC. Every job needs two
approvals: the owner approves it in PocketRocket, and then you approve it again in a dialog on this PC. Nothing
runs without the second one.

Plain Node (22 or newer), no extra packages. Windows 11. No admin rights, no autostart, no scheduled task.

## How it works

1. The runner opens an outbound SSH tunnel: `ssh -N -L 127.0.0.1:7789:127.0.0.1:7788 crm-agency`. The PC opens no port
   and listens on loopback only. If ssh drops, the runner restarts it, waiting 2 s and then up to 60 s between
   tries. It uses BatchMode, so ssh logs in with your key and never asks for a password.
2. Through the tunnel it sends a heartbeat every 15 s with the names of the folders you allow, and asks for the
   next job every 5 s. It runs one job at a time.
3. For each job it checks the folder against your `config.json` again, read fresh from disk, then shows a
   **Run / Refuse** dialog with the bot, room, folder path, tools, and the full prompt in a scrollable box.
   If you press nothing for 10 minutes, the job is refused. So are Esc and closing the window.
4. If you press Run, it runs `claude -p` in that folder, with the prompt on stdin and isolated from the folder's
   own config (see "Isolation"). It stops the job after 15 minutes and sends back the result, capped at 20 KB,
   with its cost and duration.

Before the runner sends its token anywhere, it checks that whatever listens on `127.0.0.1:<localPort>` is its
own ssh process (`Get-NetTCPConnection`, owner pid = ssh pid). It does this when the tunnel starts and after every
restart. If another program holds the port, the runner sends nothing, logs `port_squatted`, kills its ssh and
backs off.

## Setup

1. Make sure `ssh crm-agency` works from PowerShell with your key and no password prompt.
2. Install. This copies the runner to `%LOCALAPPDATA%\PocketRocketRunner` and puts two Desktop shortcuts there:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pc-runner\install.ps1
   ```
3. Edit `%LOCALAPPDATA%\PocketRocketRunner\config.json` (the install starts it from `config.example.json`):
   ```json
   {
     "sshAlias": "crm-agency",
     "localPort": 7789,
     "defaultAllowedTools": ["Read", "Glob", "Grep", "Edit", "Write",
       "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"],
     "folders": {
       "pocketrocket": { "path": "C:\\Users\\you\\Desktop\\claude-grokbot" },
       "wika-notes": { "path": "C:\\Users\\you\\Documents\\wika-notes",
                       "mcpServers": ["wika-dashboard"],
                       "allowedTools": ["Read", "Glob", "Grep", "mcp__wika-dashboard__list_routes"] }
     }
   }
   ```
   - Folder names must match `^[a-z0-9][a-z0-9_-]{0,40}$`. The hub only knows the names; the paths stay on this PC.
   - A folder's `allowedTools`, when set, **replaces** `defaultAllowedTools` for that folder.
   - `claudePath` (optional) is the absolute path to `claude.exe`. Without it, the runner uses
     `%USERPROFILE%\.local\bin\claude.exe`, then `claude.exe` in an absolute `PATH` folder (never the current
     folder). It is resolved once at start, and the runner refuses to start if it sits inside an allowlisted folder.
   - Check it: `node "%LOCALAPPDATA%\PocketRocketRunner\runner.mjs" check`. This also resolves claude and copies
     the MCP servers your folders name (see below).
4. Pair. Copy the runner token from the hub, then run:
   ```powershell
   node "$env:LOCALAPPDATA\PocketRocketRunner\runner.mjs" pair
   ```
   This reads the token from the clipboard and writes it to `%LOCALAPPDATA%\PocketRocketRunner\token`. Then it
   removes inherited permissions so only your Windows user can read the file, and clears the clipboard. The
   token is never printed. If Windows clipboard history (Win+V) is on, delete the entry there too.
5. Double-click **PocketRocket Runner ON**.

## Tools

The default list lets Claude read and edit files and run `git status`, `git diff`, `git log` and `git show`, nothing
else. A tool that isn't on the list is denied without a prompt, because `-p` mode has nobody to ask.

- **Test runners are opt-in per folder.** `Bash(pnpm test:*)` and `Bash(npm test:*)` run scripts from the repo, and
  together with Edit/Write that means a job can run any code it writes. Add them only to folders where you accept
  that.
- **Edit/Write plus any shell command counts as running code, git included.** A file edit can turn the next
  `git status` into a program run, through `core.fsmonitor`, `core.pager` or aliases in `.git/config`, or through
  filter/diff drivers named in `.gitattributes`. The default list has both, so the dialog shows a red line on
  every such job: **"This job can run code in this folder."** `check` warns too. A folder that only needs reading
  can use `["Read", "Glob", "Grep"]` plus git commands, and gets no warning.
- These are always denied, whatever the list says:
  - `git ... --output=<file>`, which writes a file anywhere
  - `git ... --ext-diff`, which runs a configured diff program
  - `git -c ...`, which sets any config for one command
  - Edit or Write on `.git/**` (also nested), `.gitattributes` and `.gitmodules`
- Every git a job runs gets a hardened environment:
  - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=NUL`, so no system or user git config (`git status/diff/log/show`
    don't need your git identity)
  - forced `core.fsmonitor=false`, `core.pager=cat`, `core.hooksPath=NUL` and `core.sshCommand=` through
    `GIT_CONFIG_COUNT`, which overrides the repo's own `.git/config`
  - `GIT_DIR`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, pagers and editors removed

  `diff.external` can't be forced off: git has no "none" value, and an empty one breaks every `git diff`. A job
  can't plant one, because `.git/**` is denied. One that is already in your own clone's `.git/config` would run.
- Claude Code itself auto-approves some read-only shell commands such as `whoami`, even when they aren't on the
  list. Anything that writes or runs a program is denied.
- **MCP servers.** A job sees only the servers its folder names in `mcpServers`, and only the tools of theirs you
  list in `allowedTools` as `mcp__<server>__<tool>` (for example `mcp__wika-dashboard__list_routes`). Define a server
  in `config.json` under a top-level `"mcpServers": { "<name>": { ...definition... } }`. Or leave it out, and
  `check` copies its definition from your `~/.claude.json` into `mcp-snapshot.json`. Run `check` again after you
  change it there.
  - Servers authenticated with a header token in their definition (like `wika-dashboard`) work as copied.
  - OAuth-backed servers (supabase, figma): on the PC this was tested on, neither had a stored OAuth login, so
    they reported "needs authorization" with and without strict config. Whether an OAuth login made with
    `claude mcp` / `/mcp` carries over to the runner's `--strict-mcp-config` run is **not verified**. Run a test
    job before relying on one.
- **Never add tools that send, delete or deploy**: email or message senders, `*_delete`, deploy, publish, payment,
  `Bash(git push:*)`, `Bash(curl:*)` and the like. If a prompt was injected, those are exactly what it would reach for.
- The runner refuses a config with plain `Bash`, `Bash(*)`, plain `PowerShell`, or anything that turns off
  permission checks. It never passes `--dangerously-skip-permissions` or `bypassPermissions`, and a unit test
  checks that.

## Isolation

A job folder is a repo that bots can push to, so its own `.claude/settings.json`, `.claude/settings.local.json`
(allow rules, hooks) and `.mcp.json` (an MCP server is a program) are treated as hostile. Every job runs with:

| Flag | Effect |
|---|---|
| `--restricted` | ignores user, project and local settings files, refuses bypassPermissions, keeps the file tools inside the folder |
| `--setting-sources ""` | loads no settings files |
| `--settings <runner temp file>` | the only settings: `defaultMode: dontAsk`, an empty allow list, the git denials above, `disableAllHooks: true` |
| `--permission-mode dontAsk` + `--permission-prompts none` | anything not pre-approved is denied |
| `--strict-mcp-config --mcp-config <runner temp file>` | only the folder's `mcpServers`; `.mcp.json` and `~/.claude.json` servers are ignored |
| `--tools <built-ins>` | only the built-in tools the list names exist |
| `--allowedTools` / `--disallowedTools` | the folder's list, and the always-denied git commands and git-metadata edits |
| `--no-session-persistence` | no transcript is left on disk |
| process environment | the hardened git environment above |

Every flag was checked against `claude --help` (Claude Code 2.1.319). `--permission-mode default` is not one of
that version's listed choices, so the runner uses `dontAsk`, which denies anything not pre-approved.

The isolation was tested on Windows 11 in a throwaway git repo that had:
- `.claude/settings.json` and `settings.local.json` allowing `Bash(*)`, with `defaultMode: bypassPermissions` and
  hooks on SessionStart, UserPromptSubmit and PreToolUse that each write a marker file
- a `.mcp.json` stdio server that writes a marker file when it starts

The owner's own user settings also had `defaultMode: bypassPermissions`. Results:
- `node -e "...writeFileSync..."` was denied.
- `git diff --output=OUT.txt` and `git -c core.pager=cat diff` were denied.
- No hook or MCP marker file appeared, and no `mcp__` tools were loaded.
- Only `whoami` ran, because Claude Code auto-approves read-only commands.
- The repo's `.git/config` also had a planted `core.fsmonitor` that writes `%TEMP%\pr-pwned.txt`. It fired on a
  plain `git status`. The job's `git status` and `git diff` worked and did not create the file.
- Edit on `.git/config`, and Write of `.gitattributes` and `.gitmodules` (at the repo root), were all denied.
  The files were unchanged or not created.

## Threat model, in plain words

- **Two approvals.** The owner approves the job in the hub, and you approve it again on this PC after reading the
  full prompt. Someone with only the hub, or only the hub token, can queue a job, but nothing runs until you
  press Run here.
- **A stolen hub token isn't enough.** The runner token lets the hub hand out jobs and lets this PC fetch them.
  Neither token can start Claude on this PC without the local dialog.
- **The allowlist is on this PC.** A job naming a folder you didn't list is refused before any dialog, and the
  hub never learns your paths.
- **allowedTools limits the damage of an injected prompt.** If a prompt contains hidden instructions (from a web
  page, an email, a file), Claude can still only use the listed tools, in that one folder, for at most 15 minutes.
  Edits in the folder are possible, so keep folders under git and review the diff.
- **The folder can't widen its own job.** Settings, hooks and MCP servers that a bot commits to the repo are not
  loaded (see "Isolation"). The claude binary may not live inside an allowlisted folder.
- **No token to a stranger.** The token is sent only after the local port is confirmed to belong to the runner's own
  ssh process, so another program grabbing 127.0.0.1:7789 first gets nothing.
- **No inbound port.** The PC dials out over SSH; the hub stays on the VPS's loopback.
- **Logs** in `%LOCALAPPDATA%\PocketRocketRunner\logs\runner-YYYY-MM-DD.log` hold each job's id, bot, room,
  folder, the first 200 characters of the prompt, your decision, cost and duration. They never hold the
  output or the token.

## Turning it off

- Double-click **PocketRocket Runner OFF**. This stops the runner, its ssh tunnel, any running job and any open
  dialog. The runner never starts by itself; it is off until you press ON again.
- To unpair, delete `%LOCALAPPDATA%\PocketRocketRunner\token`. You may first need
  `icacls "%LOCALAPPDATA%\PocketRocketRunner\token" /grant:r "%USERNAME%:F"`, because the file is read-only even
  to you. Also revoke the runner token in the hub.
- To remove the runner completely, turn it off, delete the two Desktop shortcuts and the
  `%LOCALAPPDATA%\PocketRocketRunner` folder.
- On the server, `deploy/keys.sh disable` moves `data/pc-runner.json` away with the other keys (see
  docs/SERVER.md, "Kill switch").

## Files

| File | What it is |
|---|---|
| `runner.mjs` | the program: `pair`, `check`, `run` |
| `lib.mjs` | pure helpers (config check, folder check, claude args, output cap), tested by `lib.test.mjs` |
| `confirm.ps1` | the Run / Refuse dialog; it reads the job from a temp JSON file and never puts it into script text |
| `runner-on.ps1` / `runner-off.ps1` | start hidden and write `runner.pid` / stop the runner and everything it started |
| `install.ps1` | copies the files and makes the Desktop shortcuts |

Tests: `node --test scripts/pc-runner`. For development, `POCKETROCKET_RUNNER_DIR` points the runner at another
data folder, and `POCKETROCKET_RUNNER_NO_TUNNEL=1` talks to a hub already listening on `localPort` without ssh.
