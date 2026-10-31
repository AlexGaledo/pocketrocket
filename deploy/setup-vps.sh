#!/usr/bin/env bash
# One-time (idempotent) VPS setup for PocketRocket Crew's screen: creates the unprivileged service
# user, X virtual display, VNC, noVNC, Chromium, the daily backup and hourly Claude CLI update
# cron jobs, and the screen unit.
#
# Security model: the hub (127.0.0.1:7790), noVNC (127.0.0.1:6081), the VNC server
# (127.0.0.1:5901) and Chromium's CDP (127.0.0.1:9223) all bind loopback only. Nothing here opens
# a firewall port or listens on a public interface, and nothing should ever be put behind a
# reverse proxy without adding auth in front of it. The only supported remote access path is an
# SSH tunnel: `ssh -L 7790:127.0.0.1:7790 <host>` (see README "Run on a server").
#
# Run as root on Ubuntu/Debian from the repo dir: bash deploy/setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DEBIAN_FRONTEND=noninteractive

APP_USER="pocketrocket-crew"
APP_HOME="/home/pocketrocket-crew"
INSTALL_DIR="$(pwd)"
DATA_DIR="$INSTALL_DIR/data"
# Pinned to @playwright/mcp's playwright-core peer version (packages/hub/node_modules/@playwright/mcp/package.json).
PLAYWRIGHT_VERSION="1.63.0-alpha-2026-08-31"

echo "==> pocketrocket-crew service user"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash --user-group "$APP_USER"

need_pkgs=()
for p in xvfb x11vnc novnc websockify xauth fonts-liberation fonts-noto-color-emoji dbus-x11 \
         xfwm4 xfce4-panel xfdesktop4 xfce4-settings thunar xfce4-terminal mousepad ristretto \
         adwaita-icon-theme xdotool scrot; do
  dpkg -s "$p" >/dev/null 2>&1 || need_pkgs+=("$p")
done
if [ ${#need_pkgs[@]} -gt 0 ]; then
  echo "==> apt install ${need_pkgs[*]}"
  apt-get update -qq
  apt-get install -y -qq "${need_pkgs[@]}" >/dev/null
fi

echo "==> unprivileged user namespaces (Chromium's sandbox needs these as a non-root user)"
if [ -e /proc/sys/kernel/unprivileged_userns_clone ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" != "1" ]; then
  echo "kernel.unprivileged_userns_clone=1" > /etc/sysctl.d/99-pocketrocket-crew-userns.conf
  sysctl -p /etc/sysctl.d/99-pocketrocket-crew-userns.conf >/dev/null
fi
# Newer Ubuntu (23.10+) gates unprivileged userns behind AppArmor instead; we don't weaken that
# system-wide policy automatically. screen.sh detects it at runtime and falls back to --no-sandbox.

if ! sudo -u "$APP_USER" -H bash -lc 'ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome' >/dev/null 2>&1; then
  echo "==> installing Chromium $PLAYWRIGHT_VERSION (system deps as root, browser cache as $APP_USER)"
  export PATH="$HOME/.local/bin:$PATH"
  (cd packages/hub && pnpm dlx "playwright@$PLAYWRIGHT_VERSION" install-deps chromium)
  (cd packages/hub && sudo -u "$APP_USER" -H env "PATH=$PATH" bash -lc "pnpm dlx playwright@$PLAYWRIGHT_VERSION install chromium")
fi

mkdir -p "$DATA_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR" 2>/dev/null || true
# VNC has no password of its own any more: the hub's /screen/ cookie auth is the gate (see deploy/screen.sh).
# Clear the files an earlier setup generated so nobody goes looking for a password that is never asked for.
rm -f "$DATA_DIR/vnc-passwd" "$DATA_DIR/vnc-passwd.txt"

echo "==> daily backup of data/ (keeps 7; copied, not symlinked, so a bot can't rewrite root's cron job)"
install -m 755 -o root -g root deploy/backup.sh /etc/cron.daily/pocketrocket-crew-backup

echo "==> hourly Claude Code CLI update (new models need a minimum CLI version)"
install -m 755 -o root -g root deploy/claude-update.sh /etc/cron.hourly/pocketrocket-crew-claude-update
/etc/cron.hourly/pocketrocket-crew-claude-update || echo "   (claude update failed; see: journalctl -t pocketrocket-crew-claude-update)"

echo "==> installing pocketrocket-crew.service (hub unit; scripts/deploy.sh restarts it after each deploy)"
cp deploy/pocketrocket-crew.service /etc/systemd/system/pocketrocket-crew.service
systemctl daemon-reload
systemctl enable pocketrocket-crew >/dev/null 2>&1 || true

echo "==> installing pocketrocket-crew-screen.service"
chmod +x deploy/screen.sh
stamp="$(cat deploy/pocketrocket-crew-screen.service deploy/screen.sh | md5sum | cut -d' ' -f1)"
prev="$(cat /etc/pocketrocket-crew-screen.stamp 2>/dev/null || true)"
cp deploy/pocketrocket-crew-screen.service /etc/systemd/system/pocketrocket-crew-screen.service
systemctl daemon-reload
systemctl enable pocketrocket-crew-screen >/dev/null 2>&1 || true
# Restart only when the screen files changed or it is down: a restart closes open tabs (logins persist).
if [ "$stamp" != "$prev" ] || ! systemctl is-active -q pocketrocket-crew-screen; then
  systemctl restart pocketrocket-crew-screen
  echo "$stamp" > /etc/pocketrocket-crew-screen.stamp
  sleep 4
else
  echo "   screen unchanged, left running"
fi
systemctl is-active pocketrocket-crew-screen
echo "screen: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6081/vnc.html)  cdp: $(curl -s http://127.0.0.1:9223/json/version | head -c 80)"
