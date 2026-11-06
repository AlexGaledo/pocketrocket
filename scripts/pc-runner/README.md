# PocketRocket PC runner

Lets a bot on the VPS hub ask for a Claude job to run in a folder on this Windows PC. Every job needs two
approvals: the owner approves it in PocketRocket, and then you approve it again in a dialog on this PC. Nothing
runs without the second one.

Plain Node (22 or newer), no extra packages. Windows 11. No admin rights, no autostart, no scheduled task.

## How it works

1. The runner opens an outbound SSH tunnel: `ssh -N -L 7789:127.0.0.1:7788 crm-agency`. The PC opens no port
   and listens on loopback only. If ssh drops, the runner restarts it, waiting 2 s and then up to 60 s between
   tries. It uses BatchMode, so ssh logs in with your key and never asks for a password.
2. Through the tunnel it sends a heartbeat every 15 s with the names of the folders you allow, and asks for the
   next job every 5 s. It runs one job at a time.
3. For each job it checks the folder against your `config.json` again, read fresh from disk, then shows a
   **Run / Refuse** dialog with the bot, room, folder path, tools, and the full prompt in a scrollable box.
   If you press nothing for 10 minutes, the job is refused. So are Esc and closing the window.
4. If you press Run, it runs `claude -p --output-format json --permission-mode default --allowedTools <list>` in
   that folder, with the prompt on stdin. It stops the job after 15 minutes and sends back the result, capped
   at 20 KB, with its cost and duration.

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
       "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
       "Bash(pnpm test:*)", "Bash(npm test:*)"],
     "folders": {
       "pocketrocket": { "path": "C:\\Users\\you\\Desktop\\claude-grokbot" },
       "wika-notes": { "path": "C:\\Users\\you\\Documents\\wika-notes",
                       "allowedTools": ["Read", "Glob", "Grep", "mcp__wika__list_routes"] }
     }
   }
   ```
   - Folder names must match `^[a-z0-9][a-z0-9_-]{0,40}$`. The hub only knows the names; the paths stay on this PC.
   - A folder's `allowedTools`, when set, **replaces** `defaultAllowedTools` for that folder.
   - Check it: `node "%LOCALAPPDATA%\PocketRocketRunner\runner.mjs" check`
4. Pair. Copy the runner token from the hub, then run:
   ```powershell
   node "$env:LOCALAPPDATA\PocketRocketRunner\runner.mjs" pair
   ```
   This reads the token from the clipboard and writes it to `%LOCALAPPDATA%\PocketRocketRunner\token`. Then it
   removes inherited permissions so only your Windows user can read the file, and clears the clipboard. The
   token is never printed. If Windows clipboard history (Win+V) is on, delete the entry there too.
5. Double-click **PocketRocket Runner ON**.

## Tools

The default list lets Claude read files, edit them, and run a few git and test commands, nothing else. A tool
that isn't on the list is denied without a prompt, because `-p` mode has nobody to ask.

- You can add MCP **read** tools per folder, named `mcp__<server>__<tool>`, for example
  `mcp__wika__list_routes`.
- **Never add tools that send, delete or deploy**: email or message senders, `*_delete`, deploy, publish, payment,
  `Bash(git push:*)`, `Bash(curl:*)` and the like. If a prompt was injected, those are exactly what it would reach for.
- The runner refuses a config with plain `Bash`, `Bash(*)`, or anything that turns off permission checks.
  It never passes `--dangerously-skip-permissions` or `bypassPermissions`, and a unit test checks that.

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
