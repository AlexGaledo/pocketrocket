# Run PocketRocket on a server

The hub is the shared computer: run it on a Linux box and every bot works there, routines fire
while your laptop is closed, and a full Linux shell is available to bots. The desktop app then
connects to it over an SSH tunnel. Deploying needs a checkout of this repo; everyday use needs
only the installer (see the [README](../README.md)).

## Connection modes in the desktop app

Switch from the **Connection** menu:

| Mode | What happens | State lives in |
|---|---|---|
| **Local: this PC** (default) | The app starts its own hub as a child process and shuts it down on quit. No network hop. | `%APPDATA%\com.pocketrocket.crew\data\` — SQLite db (WAL), bot memories, workspace, skills. `hub.log` next to it. |
| **VPS over SSH tunnel** | Opens an SSH tunnel to the hub on your server itself, waits for it, and respawns the tunnel if it drops. Gets the virtual desktop/screen. | on the VPS |
| **Attach** | Connects to a hub you already run (`pnpm dev` / `pnpm start`). | wherever that hub points |

On first run the app can scan the servers in your `~/.ssh/config` and connect to the ones you
tick — key auth only, it never tries a password; an unknown host key is shown for you to confirm,
and a changed host key is refused.

## Deploy

```bash
# once, on the VPS: install Node 22.13+, pnpm, and the Claude CLI
scripts/deploy.sh <host>            # creates the `pocketrocket-crew` user, uploads, installs, builds, (re)starts both systemd units
ssh -L 7790:127.0.0.1:7790 <host>   # then open the token URL printed by the hub (see below)
```

Everything runs as an unprivileged `pocketrocket-crew` system user, not root; `deploy/setup-vps.sh`
creates it the first time. Log the Claude CLI in **as that user**, since that is who runs it:

```bash
sudo -u pocketrocket-crew -H claude
```

The service (`/etc/systemd/system/pocketrocket-crew.service`) binds `127.0.0.1:7790` only and requires
the hub token like every other mode: read it with
`sudo cat /home/pocketrocket-crew/pocketrocket-crew/data/hub-token` and open
`http://127.0.0.1:7790/#token=<token>` through the tunnel. **Never expose the port directly**;
reach it over an SSH tunnel or Tailscale. Data lives in `/home/pocketrocket-crew/pocketrocket-crew/data/` on
the VPS. Logs: `journalctl -u pocketrocket-crew -f`.

## Screen: a persistent desktop the bots and you share

This is the **shared** screen, used when per-bot computers are off. With them on (the default on a
VPS), see [Per-bot computers](#per-bot-computers) below.

`deploy/setup-vps.sh` (run by `scripts/deploy.sh`) installs Xvfb + XFCE + x11vnc + noVNC +
xdotool/scrot + a pinned Playwright Chromium, and starts `pocketrocket-crew-screen.service`, also as
`pocketrocket-crew`, not root.

What persists (all under `data/`, backed up daily to `/var/backups/pocketrocket-crew`, 7 kept):

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

Ops: `systemctl status pocketrocket-crew-screen`, `journalctl -u pocketrocket-crew-screen -f`. Restore a
backup: stop both services, untar into `/home/pocketrocket-crew/pocketrocket-crew`, `chown -R
pocketrocket-crew:pocketrocket-crew` it, start them again.

## Per-bot computers

With per-bot computers on (the default from `deploy/setup-vps.sh`; `POCKETROCKET_COMPUTERS=0 bash
deploy/setup-vps.sh` keeps the one shared screen above), every bot that has the **Browser** or **Desktop**
tool gets its own computer: its own virtual display, XFCE desktop, Chromium profile (its own logins) and
disk. The shared screen unit is turned off. The Screen tab shows the bot selected in the right panel, with
its state (Asleep, Starting, Live), **Wake**, **Keep awake** and a disk badge.

**Not isolation.** Every computer runs as the same `pocketrocket-crew` user as the hub, so a bot with
shell access can read another bot's files, cookies and logins, exactly as it could read the one shared
profile before. Separate computers keep bots from clicking on each other's screens; they are not a security
boundary. Give Browser, Desktop and Bash only to bots you trust with every login on the server.

How it runs:

- A computer is the systemd **user** unit `pocketrocket-crew-computer@<slot>-<botId>.service`
  (`deploy/computer.sh`, which runs `deploy/screen.sh` with per-slot values). `setup-vps.sh` installs it
  into `~pocketrocket-crew/.config/systemd/user/` and runs `loginctl enable-linger pocketrocket-crew`, so
  the hub starts and stops computers with `systemctl --user` and needs no root. Computers are not hub child
  processes, so restarting the hub does not close them.
- Slot `n` (1–99) is display `:(200+n)`, CDP `127.0.0.1:(9400+n)`, VNC `127.0.0.1:(5800+n)` and noVNC
  `127.0.0.1:(6200+n)`. Every port binds loopback only. These ranges stay clear of the shared Crew screen
  (`:98`, 9223, 5901, 6081) and of stock PocketRocket (`:99`, 9222, 5900, 6080).
- The hub proxies `/screen/<botId>/*` to that bot's noVNC. A Screen tab ticket opens one bot's screen and
  nothing else.
- A computer starts the first time its bot uses Browser or Desktop in a turn (or when you press Wake). It
  stops after `COMPUTER_IDLE_MIN` minutes (default 30) with no tool use, nobody watching, no routine due
  within 10 minutes and Keep awake off. Its disk is kept.
- At most `MAX_RUNNING_COMPUTERS` (default 3) run at once. When another one is needed, the least recently
  used idle one is stopped; if all of them are busy, the bot runs that turn without Browser and Desktop and
  says why.
- Soft disk quota: `COMPUTER_QUOTA_GB` (default 10) per computer, measured hourly. At 80% the bot is warned
  in its prompt and the Screen tab badge turns amber; at 100% the computer does not start until space is
  freed. There is no hard quota (that needs root; see containers in the spec).
- The first time the hub starts with per-bot computers on, it moves the shared screen's
  `data/browser-profile` and `data/desktop-home` to the oldest bot with the Browser tool, so existing
  logins carry over. It waits until the shared screen is stopped (setup-vps.sh stops it) and writes
  `data/computers/.legacy-migrated` when done.

Set the knobs in a drop-in, for example `systemctl edit pocketrocket-crew`:

```ini
[Service]
Environment=MAX_RUNNING_COMPUTERS=2
Environment=COMPUTER_IDLE_MIN=20
Environment=COMPUTER_QUOTA_GB=5
```

What persists per bot (under `data/`, so it is backed up):

- `data/computers/<botId>/home`: XFCE settings and the X auth cookie (was `data/desktop-home`)
- `data/computers/<botId>/browser`: the Chromium profile, so this bot's logins (was `data/browser-profile`)
- `data/computers/<botId>/files`: the bot's own disk, `Desktop` and `Downloads`. `~/Shared` and
  `Desktop/Shared` link to `data/workspace`, the folder every bot and you share.

Deleting a bot stops its computer and erases `data/computers/<botId>`.

Ops (as root):

```sh
U=pocketrocket-crew; R="XDG_RUNTIME_DIR=/run/user/$(id -u $U)"
sudo -u $U env $R systemctl --user list-units 'pocketrocket-crew-computer@*'
sudo -u $U env $R journalctl --user -u 'pocketrocket-crew-computer@*' -f
ss -ltnp | grep -E ':(94|58|62)[0-9]{2} '    # every computer port must show 127.0.0.1
```

### RAM sizing

Rough figures for planning; measure on your own VPS (`systemd-cgtop`, `free -m`). The hub itself needs
about 300 MB, and each running bot turn adds a Claude Code process of about 300–400 MB. Each **running**
computer (Xvfb, XFCE, Chromium with a few tabs) takes about 350–600 MB; asleep computers take none.

| VPS RAM | `MAX_RUNNING_COMPUTERS` | Concurrent turns (`MAX_CONCURRENT_TURNS`) |
|---|---|---|
| 2 GB | 1 | 2 |
| 4 GB | 2–3 (default 3 is tight) | 3–4 |
| 8 GB | 4–6 | 4 |
| 16 GB | 8–12 | 6–8 |

Add swap on small VPSes; Chromium is the part that grows with heavy sites.

### Backups with many bots

The daily tarball includes every computer but skips browser and desktop caches (`deploy/backup.sh`), so its
size grows with logins and the files bots keep, bounded by the per-bot quota. For incremental, deduplicated
backups that stay on the VPS, install restic and create `/etc/default/pocketrocket-crew-backup`
(root-only, mode 600):

```sh
RESTIC_REPOSITORY=/var/backups/pocketrocket-crew-restic
RESTIC_PASSWORD_FILE=/root/.pocketrocket-crew-restic-pass
```

With both set, the daily job takes a restic snapshot instead of a tarball and keeps 7 daily snapshots. It is
off until you create that file. Offsite copies are up to you.
