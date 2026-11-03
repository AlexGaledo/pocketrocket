#!/usr/bin/env bash
# One-time (idempotent) VPS setup for PocketRocket Crew's screen: creates the unprivileged service
# user, X virtual display, VNC, noVNC, Chromium, the daily backup and hourly Claude CLI update
# cron jobs, and the screen unit.
#
# Security model: the hub (127.0.0.1:7790), noVNC (127.0.0.1:6081), the VNC server
# (127.0.0.1:5901) and Chromium's CDP (127.0.0.1:9223) all bind loopback only, and so does every per-bot
# computer (CDP 9400+n, VNC 5800+n, noVNC 6200+n, display :200+n; see deploy/computer.sh). Nothing here opens
# a firewall port or listens on a public interface, and nothing should ever be put behind a
# reverse proxy without adding auth in front of it. The only supported remote access path is an
# SSH tunnel: `ssh -L 7790:127.0.0.1:7790 <host>` (see README "Run on a server").
#
# Per-bot computers (default): every bot with Browser/Desktop gets its own display, Chromium profile and
# loopback ports (deploy/computer.sh, a systemd *user* unit the hub starts and stops itself). They all run as
# the same pocketrocket-crew uid, so this separates bots but does not isolate them from each other.
# POCKETROCKET_COMPUTERS=0 bash deploy/setup-vps.sh turns them off: the hub then refuses Browser and Desktop.
#
# Run as root on Ubuntu/Debian from the repo dir: bash deploy/setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DEBIAN_FRONTEND=noninteractive

APP_USER="pocketrocket-crew"
COMPUTERS="${POCKETROCKET_COMPUTERS:-1}"
case "$COMPUTERS" in 1|true|yes|on) COMPUTERS=1 ;; *) COMPUTERS=0 ;; esac
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

# Bots browse in real Google Chrome (deploy/screen.sh). Its package also adds Google's apt repo, so apt updates it.
if [ "$(dpkg --print-architecture)" = "amd64" ] && ! command -v google-chrome-stable >/dev/null 2>&1; then
  echo "==> installing Google Chrome"
  chrome_deb="$(mktemp --suffix=.deb)"
  curl -fsSL -o "$chrome_deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  chmod 644 "$chrome_deb"
  apt-get install -y -qq "$chrome_deb" >/dev/null
  rm -f "$chrome_deb"
fi

# Chrome for Testing is the fallback where Chrome has no build; install-deps below also covers Xvfb-side libraries.
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

echo "==> hub drop-in: per-bot computers = $COMPUTERS"
mkdir -p /etc/systemd/system/pocketrocket-crew.service.d
cat > /etc/systemd/system/pocketrocket-crew.service.d/computers.conf <<EOF
[Service]
Environment=POCKETROCKET_COMPUTERS=$COMPUTERS
EOF
systemctl daemon-reload

echo "==> per-bot computer user unit + lingering (the hub runs systemctl --user; no root needed)"
APP_UID="$(id -u "$APP_USER")"
loginctl enable-linger "$APP_USER"
UNIT_DIR="$APP_HOME/.config/systemd/user"
sudo -u "$APP_USER" mkdir -p "$UNIT_DIR"
install -m 644 -o "$APP_USER" -g "$APP_USER" "deploy/pocketrocket-crew-computer@.service" "$UNIT_DIR/pocketrocket-crew-computer@.service"
chmod +x deploy/computer.sh
for _ in $(seq 1 20); do [ -S "/run/user/$APP_UID/bus" ] && break; sleep 0.5; done
sudo -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/$APP_UID" systemctl --user daemon-reload \
  || echo "   (systemctl --user daemon-reload failed; check: loginctl show-user $APP_USER -p Linger)"

if [ "$COMPUTERS" = "1" ]; then
  echo "==> shared screen off (each bot now gets its own computer; the hub moves its logins to the first Browser bot)"
  cp deploy/pocketrocket-crew-screen.service /etc/systemd/system/pocketrocket-crew-screen.service
  systemctl daemon-reload
  systemctl disable --now pocketrocket-crew-screen >/dev/null 2>&1 || true
  chmod +x deploy/screen.sh
  rm -f /etc/pocketrocket-crew-screen.stamp
  echo "   computers start on demand: ss -ltnp | grep -E ':(94|58|62)[0-9][0-9] ' should list 127.0.0.1 only"
else
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
fi
