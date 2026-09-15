# Run on a server

The hub is the shared computer: run it on a Linux box and every bot works there, routines fire
while your laptop is closed, and a full Linux shell is available to bots.

```bash
# once, on the VPS: install Node 22.13+, pnpm, and the Claude CLI
scripts/deploy.sh <host>            # creates the `pocketrocket` user, uploads, installs, builds, (re)starts both systemd units
ssh -L 7788:127.0.0.1:7788 <host>   # then open the token URL printed by the hub (see below)
```

Everything runs as an unprivileged `pocketrocket` system user, not root; `deploy/setup-vps.sh`
creates it the first time. Log the Claude CLI in **as that user**, since that is who runs it:

```bash
sudo -u pocketrocket -H claude
```

The service (`/etc/systemd/system/pocketrocket.service`) binds `127.0.0.1:7788` only and requires
the hub token like every other mode: read it with
`sudo cat /home/pocketrocket/pocketrocket/data/hub-token` and open
`http://127.0.0.1:7788/#token=<token>` through the tunnel. **Never expose the port directly**;
reach it over an SSH tunnel or Tailscale. Data lives in `/home/pocketrocket/pocketrocket/data/` on
the VPS. Logs: `journalctl -u pocketrocket -f`.

## Screen: a persistent desktop the bots and you share

`deploy/setup-vps.sh` (run by `scripts/deploy.sh`) installs Xvfb + XFCE + x11vnc + noVNC +
xdotool/scrot + a pinned Playwright Chromium, and starts `pocketrocket-screen.service`, also as
`pocketrocket`, not root.

What persists (all under `data/`, backed up daily to `/var/backups/pocketrocket`, 7 kept):

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

Ops: `systemctl status pocketrocket-screen`, `journalctl -u pocketrocket-screen -f`. Restore a
backup: stop both services, untar into `/home/pocketrocket/pocketrocket`, `chown -R
pocketrocket:pocketrocket` it, start them again.
