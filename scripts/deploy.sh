#!/usr/bin/env bash
# Deploy PocketRocket to a VPS over SSH. Usage: scripts/deploy.sh [ssh-host] [remote-dir]
# Ships the source (no node_modules/data/dist), installs, builds the UI, restarts the systemd service.
set -euo pipefail
if [ -z "${1:-}" ]; then
  echo "usage: scripts/deploy.sh <host> [remote-dir]" >&2
  exit 1
fi
HOST="$1"
DIR="${2:-~/pocketrocket}"
cd "$(dirname "$0")/.."

echo "==> legacy migration check on $HOST"
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

echo "==> uploading to $HOST:$DIR"
tar --exclude=node_modules --exclude=data --exclude=dist --exclude=.env \
    --exclude='packages/*/node_modules' --exclude='packages/web/dist' -czf - . \
  | ssh "$HOST" "mkdir -p $DIR && tar -xzf - -C $DIR"

echo "==> install + build"
ssh "$HOST" "cd $DIR && export PATH=\$HOME/.local/bin:\$PATH && pnpm install --silent && pnpm build 2>&1 | grep -E 'built in|error' || true"

if [ "${SKIP_SCREEN:-0}" != "1" ]; then
  echo "==> screen setup (Xvfb + Chromium + noVNC; idempotent)"
  ssh "$HOST" "cd $DIR && bash deploy/setup-vps.sh" || echo "   (screen setup failed; hub still deploys. Rerun: ssh $HOST 'cd $DIR && bash deploy/setup-vps.sh')"
fi

echo "==> restart service"
ssh "$HOST" "systemctl restart pocketrocket && sleep 6 && systemctl is-active pocketrocket && curl -s http://127.0.0.1:7788/api/health && echo"

echo "==> done. Access: ssh -L 7788:127.0.0.1:7788 $HOST   then open http://127.0.0.1:7788"
