#!/usr/bin/env bash
# Deploy Claudebot to a VPS over SSH. Usage: scripts/deploy.sh [ssh-host] [remote-dir]
# Ships the source (no node_modules/data/dist), installs, builds the UI, restarts the systemd service.
set -euo pipefail
HOST="${1:-crm-agency}"
DIR="${2:-~/claudebot}"
cd "$(dirname "$0")/.."

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
ssh "$HOST" "systemctl restart claudebot && sleep 6 && systemctl is-active claudebot && curl -s http://127.0.0.1:7788/api/health && echo"

echo "==> done. Access: ssh -L 7788:127.0.0.1:7788 $HOST   then open http://127.0.0.1:7788"
