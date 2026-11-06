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
#
# The database is not copied as live files: tarring pocketrocket.db while the hub writes to it (and its -wal
# beside it) can give a copy that does not open. Instead SQLite's online backup API (python3's sqlite3; the
# server has no sqlite3 CLI) writes a consistent copy first, run as the database's owner so no root-owned
# -wal/-shm is ever left next to the live file. In the archive it is db-snapshot/pocketrocket.db.
# The service user's Claude Code transcripts (~/.claude/projects) are in it too, as .claude/projects: bot
# sessions resume from them, so losing them makes every bot forget its running conversations.
# Restore: untar into /home/pocketrocket/pocketrocket, move db-snapshot/pocketrocket.db to data/pocketrocket.db
# and .claude/projects to /home/pocketrocket/.claude/projects (see docs/SERVER.md).
set -euo pipefail
umask 077
if [ -r /etc/default/pocketrocket-backup ]; then . /etc/default/pocketrocket-backup; fi
ROOT="${POCKETROCKET_ROOT:-/home/pocketrocket/pocketrocket}"
OUT="${POCKETROCKET_BACKUPS:-/var/backups/pocketrocket}"
CLAUDE_HOME="${POCKETROCKET_CLAUDE_HOME:-/home/pocketrocket/.claude}"
SERVICE_USER="${POCKETROCKET_USER:-pocketrocket}"
DB="$ROOT/data/pocketrocket.db"
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
  # The live database; the consistent copy below goes in instead.
  'data/pocketrocket.db' 'data/pocketrocket.db-wal' 'data/pocketrocket.db-shm'
)

SNAP="$(mktemp -d)"
trap 'rm -rf "$SNAP"' EXIT
mkdir "$SNAP/db-snapshot"
if [ -f "$DB" ]; then
  owner="$(stat -c %U "$DB")"
  if [ "$(id -u)" = 0 ] && [ "$owner" != root ]; then
    chown "$owner" "$SNAP" "$SNAP/db-snapshot"
    as_owner() { runuser -u "$owner" -- "$@"; }
  else
    as_owner() { "$@"; }
  fi
  as_owner python3 - "$DB" "$SNAP/db-snapshot/pocketrocket.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1], timeout=60)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
check = dst.execute('PRAGMA quick_check').fetchone()[0]
dst.close()
src.close()
if check != 'ok':
    sys.exit('database copy failed quick_check: ' + check)
PY
  chown -R "$(id -u)" "$SNAP"
fi
# Extra sources besides data/, each given as <dir to change into> <path inside it>.
EXTRA=(-C "$SNAP" db-snapshot)
EXTRA_PATHS=("$SNAP/db-snapshot")
# This runs as root, but the service user (and so every bot) can write under its own home. Only follow the
# transcripts folder when neither it nor its parent is a symlink and both belong to the service user; otherwise a
# bot could point it at /root or /etc and have root archive that.
claude_ok() {
  local d
  for d in "$CLAUDE_HOME" "$CLAUDE_HOME/projects"; do
    [ -d "$d" ] && [ ! -L "$d" ] || return 1
    [ "$(stat -c %U "$d")" = "$SERVICE_USER" ] || return 1
  done
}
if claude_ok; then
  EXTRA+=(-C "$(dirname "$CLAUDE_HOME")" "$(basename "$CLAUDE_HOME")/projects")
  EXTRA_PATHS+=("$CLAUDE_HOME/projects")
elif [ -e "$CLAUDE_HOME/projects" ] || [ -L "$CLAUDE_HOME" ]; then
  echo "backup: skipping $CLAUDE_HOME/projects (a symlink, or not owned by $SERVICE_USER)" >&2
fi

if [ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${RESTIC_PASSWORD_FILE:-}" ] && command -v restic >/dev/null 2>&1; then
  export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
  restic cat config >/dev/null 2>&1 || restic init
  args=()
  for e in "${EXCLUDES[@]}"; do args+=(--exclude "$ROOT/$e"); done
  restic backup --quiet --tag pocketrocket "${args[@]}" "$ROOT/data" "${EXTRA_PATHS[@]}"
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
tar -czf "$OUT/data-$stamp.tgz" "${args[@]}" -C "$ROOT" data "${EXTRA[@]}"
ls -1t "$OUT"/data-*.tgz | tail -n +8 | xargs -r rm -f
echo "backup: $OUT/data-$stamp.tgz ($(du -h "$OUT/data-$stamp.tgz" | cut -f1))"
