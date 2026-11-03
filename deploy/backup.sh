#!/usr/bin/env bash
# Daily snapshot of PocketRocket's persistent state (db, workspace, bot homes, skills, browser profile, desktop config).
# Installed as /etc/cron.daily/pocketrocket-backup by setup-vps.sh. Keeps the 7 newest archives.
# Per-bot computers (data/computers/<id>/: home, browser profile, files) are included, minus their caches.
#
# Optional and off by default: incremental, deduplicated snapshots with restic into a repository on this VPS
# (see docs/SERVER.md). Put RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE in /etc/default/pocketrocket-backup;
# when both are set and restic is installed, a restic snapshot (7 daily kept) replaces the tarball.
# data/vault.key is left out on purpose: it decrypts data/integrations.json (OAuth/API tokens for GitHub,
# Google, Slack, ...), so an archive alone must hold no usable token. Back the key up separately.
# data/hub-token is left out too: the hub writes a new one on start if a restore has none.
# Archives still hold data/secrets.json, so they are readable by root only.
set -euo pipefail
umask 077
if [ -r /etc/default/pocketrocket-backup ]; then . /etc/default/pocketrocket-backup; fi
ROOT="${POCKETROCKET_ROOT:-/home/pocketrocket/pocketrocket}"
OUT="${POCKETROCKET_BACKUPS:-/var/backups/pocketrocket}"
# Relative to $ROOT. Caches rebuild themselves; logins, cookies and files are what matter.
EXCLUDES=(
  'data/browser-profile/*/Cache' 'data/browser-profile/*/Code Cache'
  'data/browser-profile/*/GPUCache' 'data/browser-profile/*/Service Worker'
  'data/desktop-home/.cache' 'data/workspace/node_modules'
  'data/computers/*/browser/*/Cache' 'data/computers/*/browser/*/Code Cache'
  'data/computers/*/browser/*/GPUCache' 'data/computers/*/browser/*/Service Worker'
  'data/computers/*/home/.cache'
  'data/vault.key' 'data/hub-token'
  'data/bots/*/playwright-output' 'data/workspace/.playwright-mcp'
)

if [ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${RESTIC_PASSWORD_FILE:-}" ] && command -v restic >/dev/null 2>&1; then
  export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
  restic cat config >/dev/null 2>&1 || restic init
  args=()
  for e in "${EXCLUDES[@]}"; do args+=(--exclude "$ROOT/$e"); done
  restic backup --quiet --tag pocketrocket "${args[@]}" "$ROOT/data"
  restic forget --quiet --tag pocketrocket --keep-daily 7 --prune
  echo "backup: restic snapshot in $RESTIC_REPOSITORY"
  exit 0
fi

mkdir -p "$OUT"
chmod 700 "$OUT"
find "$OUT" -maxdepth 1 -name 'data-*.tgz' -exec chmod 600 {} +
stamp="$(date +%F-%H%M)"
args=()
for e in "${EXCLUDES[@]}"; do args+=(--exclude="$e"); done
tar -czf "$OUT/data-$stamp.tgz" -C "$ROOT" "${args[@]}" data
ls -1t "$OUT"/data-*.tgz | tail -n +8 | xargs -r rm -f
echo "backup: $OUT/data-$stamp.tgz ($(du -h "$OUT/data-$stamp.tgz" | cut -f1))"
