#!/usr/bin/env bash
# Daily snapshot of Claudebot's persistent state (db, workspace, bot homes, skills, browser profile, desktop config).
# Installed as /etc/cron.daily/claudebot-backup by setup-vps.sh. Keeps the 7 newest archives.
set -euo pipefail
ROOT="${CLAUDEBOT_ROOT:-/root/claudebot}"
OUT="${CLAUDEBOT_BACKUPS:-/root/claudebot-backups}"
mkdir -p "$OUT"
stamp="$(date +%F-%H%M)"
tar -czf "$OUT/data-$stamp.tgz" -C "$ROOT" \
  --exclude='data/browser-profile/*/Cache' --exclude='data/browser-profile/*/Code Cache' \
  --exclude='data/browser-profile/*/GPUCache' --exclude='data/browser-profile/*/Service Worker' \
  --exclude='data/desktop-home/.cache' --exclude='data/workspace/node_modules' \
  data
ls -1t "$OUT"/data-*.tgz | tail -n +8 | xargs -r rm -f
echo "backup: $OUT/data-$stamp.tgz ($(du -h "$OUT/data-$stamp.tgz" | cut -f1))"
