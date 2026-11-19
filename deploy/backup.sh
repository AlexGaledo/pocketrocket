#!/usr/bin/env bash
# Daily snapshot of PocketRocket's persistent state (db, workspace, bot homes, skills, browser profile, desktop config).
# Installed as /etc/cron.daily/pocketrocket-backup by setup-vps.sh. Keeps the 3 newest archives (KEEP in
# /etc/default/pocketrocket-backup changes that). Each one is a full copy of data/ (~5 GB on the live server),
# so on 2026-11-16 seven of them filled the 96 GB disk and the last three came out cut off. Now the old ones go
# before the new one is written, a run with too little free space is skipped, and an archive only gets its
# final name once tar has finished, so a cut-off one never takes a good one's place.
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
#
# Size: anything a package manager or build tool can recreate is left out at any depth under data/ (node_modules,
# .next, .nuxt, .turbo, .parcel-cache, .venv, venv, __pycache__, .pytest_cache, .mypy_cache, and a Rust target/
# that sits next to a Cargo.toml). dist/ and build/ are kept on purpose: they can be real output. The archive is
# zstd (data-<stamp>.tar.zst) when zstd is installed, else gzip (data-<stamp>.tgz); rotation handles both.
#
# Restore: untar into /home/pocketrocket/pocketrocket, move db-snapshot/pocketrocket.db to data/pocketrocket.db
# and .claude/projects to /home/pocketrocket/.claude/projects (see docs/SERVER.md). Untar with
#   tar --zstd -xf data-<stamp>.tar.zst -C /home/pocketrocket/pocketrocket     (or: zstd -dc FILE | tar -x -C DIR)
#   tar -xzf data-<stamp>.tgz -C /home/pocketrocket/pocketrocket               (older, gzip archives)
# Afterwards run `npm install` / `pnpm install` in a project to bring its node_modules back.
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
  'data/desktop-home/.cache'
  # Rebuildable dirs at any depth (tar matches a pattern without a leading / against any path component run).
  'node_modules' '.next' '.nuxt' '.turbo' '.parcel-cache' '.venv' 'venv'
  '__pycache__' '.pytest_cache' '.mypy_cache'
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
  restic forget --quiet --tag pocketrocket --keep-daily "${KEEP:-3}" --prune
  echo "backup: restic snapshot in $RESTIC_REPOSITORY"
  exit 0
fi

KEEP="${KEEP:-3}"
[[ "$KEEP" =~ ^[1-9][0-9]?$ ]] || { echo "backup: KEEP must be 1-99, got '$KEEP'" >&2; exit 2; }
mkdir -p "$OUT"
chmod 700 "$OUT"
# Both formats: gzip (.tgz) from before zstd, and .tar.zst.
list_archives() { ls -1t -- "$OUT"/data-*.tgz "$OUT"/data-*.tar.zst 2>/dev/null || true; }
find "$OUT" -maxdepth 1 \( -name 'data-*.tgz' -o -name 'data-*.tar.zst' \) -exec chmod 600 {} +
# Leftovers of a run that died mid-write.
find "$OUT" -maxdepth 1 -name 'data-*.partial' -delete
# Make room first: keep KEEP-1 old archives, so with the new one there are KEEP.
list_archives | tail -n +"$KEEP" | xargs -r rm -f
# Room for one more: the newest archive's size plus 2 GB, or 6 GB when there is none yet.
last="$(list_archives | head -n 1)"
if [ -n "$last" ]; then last_kb="$(du -k "$last" | cut -f1)"; else last_kb=6291456; fi
need_kb=$(( last_kb + 2097152 ))
free_kb="$(df -Pk "$OUT" | awk 'NR==2 {print $4}')"
if [ "$free_kb" -lt "$need_kb" ]; then
  echo "backup: skipped, $((free_kb / 1048576)) GB free in $OUT and a backup needs about $((need_kb / 1048576)) GB" >&2
  exit 1
fi
stamp="$(date +%F-%H%M)"
args=()
for e in "${EXCLUDES[@]}"; do args+=(--exclude="$e"); done
# Rust build output: a `target` dir is only skipped where a Cargo.toml sits beside it (tar cannot test that, so
# look for them). find does not follow symlinks and does not descend into dirs that are skipped anyway.
while IFS= read -r -d '' toml; do
  proj="${toml%/Cargo.toml}"
  [ -d "$proj/target" ] && [ ! -L "$proj/target" ] || continue
  rel="${proj#"$ROOT"/}/target"
  case "$rel" in *'*'*|*'?'*|*'['*|*'\'*) continue ;; esac # a glob character in the name would match too much
  args+=(--exclude="$rel")
done < <(find "$ROOT/data" \( -name node_modules -o -name target -o -name .git \) -prune -o -name Cargo.toml -type f -print0 2>/dev/null)
# zstd when installed (multi-threaded, level 12), else gzip. POCKETROCKET_COMPRESS=gzip forces gzip.
if [ "${POCKETROCKET_COMPRESS:-auto}" != gzip ] && command -v zstd >/dev/null 2>&1; then
  ext=tar.zst; comp=(-I 'zstd -T0 -12')
else
  ext=tgz; comp=(-z)
fi
final="$OUT/data-$stamp.$ext"
if ! tar -c "${comp[@]}" -f "$final.partial" "${args[@]}" -C "$ROOT" data "${EXTRA[@]}"; then
  rm -f "$final.partial"
  echo "backup: tar failed, nothing kept from this run" >&2
  exit 1
fi
mv "$final.partial" "$final"
echo "backup: $final ($(du -h "$final" | cut -f1))"
