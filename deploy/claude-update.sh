#!/usr/bin/env bash
# Hourly: keep the service user's Claude Code CLI current. New models require a minimum CLI
# version ("Claude Code X does not support this model; version Y or newer is required"), and the
# CLI's own auto-updater doesn't run for the headless turns the hub spawns.
# Installed by deploy/setup-vps.sh as /etc/cron.hourly/pocketrocket-claude-update (copied, not
# symlinked, so a bot can't rewrite root's cron job). The update itself runs as the service user.
set -euo pipefail
APP_USER="pocketrocket"

sudo -u "$APP_USER" -H bash -lc 'export PATH="$HOME/.local/bin:$PATH"; command -v claude >/dev/null || exit 0; claude update' 2>&1 \
  | logger -t pocketrocket-claude-update
