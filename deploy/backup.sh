#!/usr/bin/env bash
# Daily snapshot of PocketRocket Crew's persistent state (db, workspace, bot homes, skills, browser profile, desktop config).
# Installed as /etc/cron.daily/pocketrocket-crew-backup by setup-vps.sh. Keeps the 7 newest archives.
# data/vault.key is left out on purpose: it decrypts data/integrations.json (OAuth/API tokens for GitHub,
# Google, Slack, ...), so an archive alone must hold no usable token. Back the key up separately.
set -euo pipefail
ROOT="${POCKETROCKET_ROOT:-/home/pocketrocket-crew/pocketrocket-crew}"
OUT="${POCKETROCKET_BACKUPS:-/var/backups/pocketrocket-crew}"
mkdir -p "$OUT"
stamp="$(date +%F-%H%M)"
tar -czf "$OUT/data-$stamp.tgz" -C "$ROOT" \
  --exclude='data/browser-profile/*/Cache' --exclude='data/browser-profile/*/Code Cache' \
  --exclude='data/browser-profile/*/GPUCache' --exclude='data/browser-profile/*/Service Worker' \
  --exclude='data/desktop-home/.cache' --exclude='data/workspace/node_modules' \
  --exclude='data/vault.key' \
  data
ls -1t "$OUT"/data-*.tgz | tail -n +8 | xargs -r rm -f
echo "backup: $OUT/data-$stamp.tgz ($(du -h "$OUT/data-$stamp.tgz" | cut -f1))"
