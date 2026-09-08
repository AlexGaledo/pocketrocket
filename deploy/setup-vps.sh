#!/usr/bin/env bash
# One-time (idempotent) VPS setup for the PocketRocket screen: X virtual display, VNC, noVNC, Chromium.
# Run as root on Ubuntu/Debian from the repo dir: bash deploy/setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DEBIAN_FRONTEND=noninteractive

need_pkgs=()
for p in xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji dbus-x11 \
         xfwm4 xfce4-panel xfdesktop4 xfce4-settings thunar xfce4-terminal mousepad ristretto \
         adwaita-icon-theme xdotool scrot; do
  dpkg -s "$p" >/dev/null 2>&1 || need_pkgs+=("$p")
done
if [ ${#need_pkgs[@]} -gt 0 ]; then
  echo "==> apt install ${need_pkgs[*]}"
  apt-get update -qq
  apt-get install -y -qq "${need_pkgs[@]}" >/dev/null
fi

if ! ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome >/dev/null 2>&1; then
  echo "==> installing Chromium via Playwright (+ system deps)"
  export PATH="$HOME/.local/bin:$PATH"
  (cd packages/hub && pnpm dlx playwright@latest install --with-deps chromium)
fi

echo "==> daily backup of data/ (keeps 7)"
chmod +x deploy/backup.sh
ln -sf "$(pwd)/deploy/backup.sh" /etc/cron.daily/pocketrocket-backup

echo "==> installing pocketrocket-screen.service"
chmod +x deploy/screen.sh
stamp="$(cat deploy/pocketrocket-screen.service deploy/screen.sh | md5sum | cut -d' ' -f1)"
prev="$(cat /etc/pocketrocket-screen.stamp 2>/dev/null || true)"
cp deploy/pocketrocket-screen.service /etc/systemd/system/pocketrocket-screen.service
systemctl daemon-reload
systemctl enable pocketrocket-screen >/dev/null 2>&1 || true
# Restart only when the screen files changed or it is down: a restart closes open tabs (logins persist).
if [ "$stamp" != "$prev" ] || ! systemctl is-active -q pocketrocket-screen; then
  systemctl restart pocketrocket-screen
  echo "$stamp" > /etc/pocketrocket-screen.stamp
  sleep 4
else
  echo "   screen unchanged, left running"
fi
systemctl is-active pocketrocket-screen
echo "screen: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/vnc.html)  cdp: $(curl -s http://127.0.0.1:9222/json/version | head -c 80)"
