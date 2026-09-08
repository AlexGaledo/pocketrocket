#!/usr/bin/env bash
# Deploy PocketRocket to a VPS over SSH. Usage: scripts/deploy.sh [ssh-host] [remote-dir]
# Ships the source (no node_modules/data/dist), runs the VPS setup (creates the pocketrocket
# service user, packages, screen), installs + builds as that user, and restarts both units.
set -euo pipefail
if [ -z "${1:-}" ]; then
  echo "usage: scripts/deploy.sh <host> [remote-dir]" >&2
  exit 1
fi
HOST="$1"
DIR="${2:-/home/pocketrocket/pocketrocket}"
APP_USER="pocketrocket"
cd "$(dirname "$0")/.."

echo "==> legacy migration check on $HOST (claudebot -> pocketrocket rename)"
ssh "$HOST" '
  if [ -d /root/claudebot ] && [ ! -d /root/pocketrocket ]; then
    echo "   migrating /root/claudebot -> /root/pocketrocket"
    systemctl stop claudebot claudebot-screen || true
    systemctl disable claudebot claudebot-screen || true
    mv /root/claudebot /root/pocketrocket
    mv /root/claudebot-backups /root/pocketrocket-backups 2>/dev/null || true
    rm -f /etc/systemd/system/claudebot.service /etc/systemd/system/claudebot-screen.service /etc/cron.daily/claudebot-backup
    systemctl daemon-reload
  fi
' || true

echo "==> non-root migration check on $HOST (root install -> pocketrocket service user)"
ssh "$HOST" "DIR='$DIR' bash -s" <<'REMOTE' || true
set -e
if [ -d /root/pocketrocket ] && [ ! -d "$DIR" ]; then
  echo "   migrating /root/pocketrocket -> $DIR"
  systemctl stop pocketrocket pocketrocket-screen 2>/dev/null || true
  id -u pocketrocket >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/pocketrocket --shell /bin/bash --user-group pocketrocket
  mkdir -p "$(dirname "$DIR")"
  mv /root/pocketrocket "$DIR"
  mv /root/pocketrocket-backups /var/backups/pocketrocket 2>/dev/null || true
  rm -f /etc/cron.daily/pocketrocket-backup /etc/systemd/system/pocketrocket.service /etc/systemd/system/pocketrocket-screen.service
  systemctl daemon-reload
fi
REMOTE

echo "==> ensuring the pocketrocket service user exists on $HOST"
ssh "$HOST" 'id -u pocketrocket >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/pocketrocket --shell /bin/bash --user-group pocketrocket'

echo "==> uploading to $HOST:$DIR"
ssh "$HOST" "mkdir -p '$DIR'"
tar --exclude=node_modules --exclude=data --exclude=dist --exclude=.env \
    --exclude='packages/*/node_modules' --exclude='packages/web/dist' -czf - . \
  | ssh "$HOST" "tar -xzf - -C '$DIR'"

echo "==> chown $DIR to $APP_USER"
ssh "$HOST" "chown -R $APP_USER:$APP_USER '$DIR'"

if [ "${SKIP_SCREEN:-0}" != "1" ]; then
  echo "==> vps setup (system user, Xvfb + Chromium + noVNC + cron + systemd units; idempotent)"
  ssh "$HOST" "cd '$DIR' && bash deploy/setup-vps.sh" || echo "   (vps setup failed; hub still deploys. Rerun: ssh $HOST 'cd $DIR && bash deploy/setup-vps.sh')"
  # setup-vps.sh may create data/ (vnc password, etc.) as root before the chown above ran against it.
  ssh "$HOST" "chown -R $APP_USER:$APP_USER '$DIR'"
fi

echo "==> install + build (as $APP_USER)"
ssh "$HOST" "DIR='$DIR' APP_USER='$APP_USER' bash -s" <<'REMOTE'
set -e
sudo -u "$APP_USER" -H bash -lc "cd '$DIR' && export PATH=\$HOME/.local/bin:\$PATH && pnpm install --silent && pnpm build 2>&1 | grep -E 'built in|error' || true"
REMOTE

echo "==> restart service"
ssh "$HOST" "systemctl restart pocketrocket && sleep 6 && systemctl is-active pocketrocket && curl -s http://127.0.0.1:7788/api/health && echo"

cat <<EOF

==> done. Access: ssh -L 7788:127.0.0.1:7788 $HOST   then open http://127.0.0.1:7788

One-time, on the VPS as root (provider CLIs must be logged in as the service user, since that's
who runs them):
  sudo -u $APP_USER -H claude                # or whichever provider CLI(s) you use
  sudo -u $APP_USER -H opencode auth login

VNC password for the Screen tab (noVNC prompts for it): cat $DIR/data/vnc-passwd.txt
Tunnel + open:  ssh -L 7788:127.0.0.1:7788 $HOST   then http://127.0.0.1:7788 -> Screen tab
EOF
