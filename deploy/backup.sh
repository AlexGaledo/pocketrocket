#!/usr/bin/env bash
# Daily snapshot of PocketRocket's persistent state (db, workspace, bot homes, skills, browser profile, desktop config).
# Installed as /etc/cron.daily/pocketrocket-backup by setup-vps.sh. Keeps the 7 newest archives.
set -euo pipefail
ROOT="${POCKETROCKET_ROOT:-/home/pocketrocket/pocketrocket}"
OUT="${POCKETROCKET_BACKUPS:-/var/backups/pocketrocket}"
mkdir -p "$OUT"
stamp="$(date +%F-%H%M)"
tar -czf "$OUT/data-$stamp.tgz" -C "$ROOT" \
  --exclude='data/browser-profile/*/Cache' --exclude='data/browser-profile/*/Code Cache' \
  --exclude='data/browser-profile/*/GPUCache' --exclude='data/browser-profile/*/Service Worker' \
  --exclude='data/desktop-home/.cache' --exclude='data/workspace/node_modules' \
  data
ls -1t "$OUT"/data-*.tgz | tail -n +8 | xargs -r rm -f
echo "backup: $OUT/data-$stamp.tgz ($(du -h "$OUT/data-$stamp.tgz" | cut -f1))"
