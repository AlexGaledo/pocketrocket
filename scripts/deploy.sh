#!/usr/bin/env bash
# Deploy PocketRocket Crew to a VPS over SSH. Usage: scripts/deploy.sh [ssh-host] [remote-dir]
# Ships the source (no node_modules/data/dist), runs the VPS setup (creates the pocketrocket-crew
# service user, packages, screen), installs + builds as that user, and restarts both units.
set -euo pipefail
if [ -z "${1:-}" ]; then
  echo "usage: scripts/deploy.sh <host> [remote-dir]" >&2
  exit 1
fi
HOST="$1"
DIR="${2:-/home/pocketrocket-crew/pocketrocket-crew}"
APP_USER="pocketrocket-crew"
cd "$(dirname "$0")/.."

echo "==> ensuring the $APP_USER service user exists on $HOST"
ssh "$HOST" "id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /bin/bash --user-group $APP_USER"

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
ssh "$HOST" "systemctl restart pocketrocket-crew && sleep 6 && systemctl is-active pocketrocket-crew && curl -s http://127.0.0.1:7790/api/health && echo"

cat <<EOF

==> done. Access: ssh -L 7790:127.0.0.1:7790 $HOST   then open http://127.0.0.1:7790

One-time, on the VPS as root (provider CLIs must be logged in as the service user, since that's
who runs them):
  sudo -u $APP_USER -H claude                # or whichever provider CLI(s) you use
  sudo -u $APP_USER -H opencode auth login

Tunnel + open:  ssh -L 7790:127.0.0.1:7790 $HOST   then http://127.0.0.1:7790 -> Screen tab
EOF
