#!/usr/bin/env bash
# Kill switch for every key PocketRocket keeps on this server. Run as root on the VPS.
#
#   bash deploy/keys.sh inventory          Markdown table of every key location, by NAME only (never a value)
#   bash deploy/keys.sh disable            stop the hub, move every key file into /root/pocketrocket-keys-disabled-<ts>/,
#                                          leave an empty mcp-servers.json, save the rotate list there, start the hub
#   bash deploy/keys.sh restore <ts>       stop, put the files from that folder back with their owner and mode, start
#   bash deploy/keys.sh delete [--all]     type DELETE; disable, then shred the moved files; the rotate list stays in /root
#                                          --all (second confirm) also replaces the hub token and removes the Claude login
#
# What counts as a key file (all under data/ unless noted):
#   mcp-servers.json, secrets.json, integrations.json + vault.key (the encrypted integration tokens and their key),
#   pc-runner.json, account.json (Supabase session), vapid.json (Web Push key pair), every .env* except .env.example
#   under data/projects/. Left in place by disable: data/hub-token and ~pocketrocket/.claude/.credentials.json
#   (the Claude login: deleting it stops every bot). delete --all takes those two as well.
#
# Moving a file only stops THIS server from using the key. The key still works wherever else it was copied, and
# the daily backups in /var/backups/pocketrocket still hold secrets.json, mcp-servers.json and the .env files.
# Rotating each key at its provider (the rotate list says where) is what actually kills it.
#
# Safety: no value is ever printed or logged; JSON files are read with python3 and only their key names are
# printed. A source that is a symlink, or sits under a symlinked folder, is skipped (bots can write under
# data/projects, and shred on a planted symlink would destroy its target). Moved files live in a root-only
# folder (mkdir -m 700), so nothing the service user runs can swap them before shred.
#
# Test overrides: POCKETROCKET_DATA, POCKETROCKET_CLAUDE_HOME, POCKETROCKET_USER, KEYS_OUT_DIR (default /root),
# KEYS_PYTHON (default python3), KEYS_NO_SYSTEMCTL=1 (skip systemctl), and KEYS_ALLOW_NONROOT=1 (only together
# with KEYS_NO_SYSTEMCTL=1: run as a normal user against a fake data folder, skipping chown).
set -euo pipefail
umask 077

ROOT="${POCKETROCKET_ROOT:-/home/pocketrocket/pocketrocket}"
DATA="${POCKETROCKET_DATA:-$ROOT/data}"
CLAUDE_HOME="${POCKETROCKET_CLAUDE_HOME:-/home/pocketrocket/.claude}"
SERVICE_USER="${POCKETROCKET_USER:-pocketrocket}"
SERVICE="pocketrocket"
OUT_BASE="${KEYS_OUT_DIR:-/root}"
PY="${KEYS_PYTHON:-python3}"
NO_SYSTEMCTL="${KEYS_NO_SYSTEMCTL:-0}"
TEST_MODE=0
if [ "${KEYS_ALLOW_NONROOT:-0}" = 1 ] && [ "$NO_SYSTEMCTL" = 1 ]; then TEST_MODE=1; fi

die() { echo "keys: $*" >&2; exit 1; }
warn() { echo "keys: $*" >&2; }

if [ "$(id -u)" != 0 ] && [ "$TEST_MODE" != 1 ]; then die "run as root (sudo bash deploy/keys.sh ...)"; fi
command -v "$PY" >/dev/null 2>&1 || die "$PY is needed to read key names"
[ -d "$DATA" ] && [ ! -L "$DATA" ] || die "no data folder at $DATA (or it is a symlink)"
DATA="$(cd -P "$DATA" && pwd -P)"

# ---------------------------------------------------------------------------------------------------------
# Where to rotate a key, from its name or env var prefix. Matching is on the lowercased name.
rotate_url() {
  local s="${1,,}"
  case "$s" in
    *firecrawl*) echo "https://firecrawl.dev/app/api-keys" ;;
    *runpod*) echo "https://www.runpod.io/console/user/settings" ;;
    *supabase*) echo "https://supabase.com/dashboard/account/tokens" ;;
    *figma*) echo "figma.com: Settings, Security, Personal access tokens" ;;
    *composio*) echo "https://platform.composio.dev (Settings)" ;;
    *wika*) echo "https://dashboard.wikaph.com (MCP keys)" ;;
    *neon*) echo "https://console.neon.tech/app/settings/api-keys" ;;
    *vercel*) echo "https://vercel.com/account/tokens" ;;
    *railway*) echo "https://railway.com/account/tokens" ;;
    *openrouter*) echo "https://openrouter.ai/settings/keys" ;;
    *openai*) echo "https://platform.openai.com/api-keys" ;;
    *anthropic*) echo "https://console.anthropic.com/settings/keys" ;;
    *gemini*) echo "https://aistudio.google.com/apikey" ;;
    *google*|*gcp*|*gmail*|*youtube*) echo "https://console.cloud.google.com/apis/credentials" ;;
    xai*|*grok*) echo "https://console.x.ai" ;;
    *github*|gh_*) echo "https://github.com/settings/tokens" ;;
    *slack*) echo "https://api.slack.com/apps" ;;
    *stripe*) echo "https://dashboard.stripe.com/apikeys" ;;
    *resend*) echo "https://resend.com/api-keys" ;;
    *sendgrid*) echo "https://app.sendgrid.com/settings/api_keys" ;;
    *twilio*) echo "https://console.twilio.com (API keys)" ;;
    *cloudflare*|cf_*) echo "https://dash.cloudflare.com/profile/api-tokens" ;;
    aws_*|*aws*) echo "AWS console: IAM, Users, Security credentials" ;;
    *clickup*) echo "ClickUp: Settings, Apps (API token)" ;;
    *teams*|*microsoft*|*azure*) echo "https://entra.microsoft.com (App registrations, Certificates & secrets)" ;;
    *sentry*) echo "https://sentry.io/settings/account/api/auth-tokens/" ;;
    *upstash*) echo "https://console.upstash.com/account/api" ;;
    *pinecone*) echo "https://app.pinecone.io (API keys)" ;;
    *mongo*) echo "MongoDB Atlas: Database Access" ;;
    *elevenlabs*) echo "https://elevenlabs.io/app/settings/api-keys" ;;
    *replicate*) echo "https://replicate.com/account/api-tokens" ;;
    *huggingface*|hf_*) echo "https://huggingface.co/settings/tokens" ;;
    *notion*) echo "https://www.notion.so/my-integrations" ;;
    *linear*) echo "https://linear.app/settings/api" ;;
    *) echo "the service's dashboard" ;;
  esac
}

# Markdown cell: keep it on one line and out of the table syntax.
cell() { printf '%s' "$1" | tr '\n\r\t|' '    ' ; }
row() { printf '| %s | %s | %s | %s |\n' "$(cell "$1")" "$(cell "$2")" "$(cell "$3")" "$(cell "$4")"; }

# Names-only reader. Prints one TAB-separated line per name; never a value. Names are reduced to a safe charset.
names() {
  "$PY" - "$@" <<'PY' | tr -d '\r'
import json, re, sqlite3, sys
mode, path = sys.argv[1], sys.argv[2]
safe = lambda s: re.sub(r'[^A-Za-z0-9_.:@/-]', '?', str(s))[:80]
def load():
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)
try:
    if mode == 'mcp':
        d = load()
        if isinstance(d, dict):
            for name, v in d.items():
                bits = []
                if isinstance(v, dict):
                    if v.get('token'): bits.append('token')
                    for k in ('env', 'headers'):
                        if isinstance(v.get(k), dict) and v[k]:
                            bits.append(k + ': ' + ', '.join(safe(x) for x in v[k].keys()))
                print(safe(name) + '\t' + ('; '.join(bits) if bits else 'no token or env'))
    elif mode == 'keys':
        d = load()
        if isinstance(d, dict):
            for k in d.keys(): print(safe(k))
    elif mode == 'providers':
        db = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=10)
        for (p,) in db.execute('SELECT provider FROM integrations ORDER BY provider'): print(safe(p))
    elif mode == 'env':
        pat = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=')
        with open(path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                m = pat.match(line)
                if m: print(safe(m.group(1)))
except Exception as e:
    print('!unreadable (' + type(e).__name__ + ')')
PY
}

# Is this a regular, non-symlinked file whose folder chain under $2 has no symlink? (Same idea as claude_ok in backup.sh.)
safe_src() {
  local f="$1" base="$2" d
  case "$f" in *$'\n'*|*$'\t'*) return 1 ;; esac
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  d="$(dirname "$f")"
  [ -d "$d" ] && [ "$(cd -P "$d" && pwd -P)" = "$d" ] || return 1
  case "$d/" in "$base"/*) return 0 ;; *) return 1 ;; esac
}

CLAUDE_CREDS="$CLAUDE_HOME/.credentials.json"
claude_ok() {
  [ -d "$CLAUDE_HOME" ] && [ ! -L "$CLAUDE_HOME" ] || return 1
  [ "$TEST_MODE" = 1 ] || [ "$(stat -c %U "$CLAUDE_HOME")" = "$SERVICE_USER" ] || return 1
  [ -f "$CLAUDE_CREDS" ] && [ ! -L "$CLAUDE_CREDS" ]
}

CORE_FILES=(mcp-servers.json secrets.json integrations.json vault.key pc-runner.json account.json vapid.json)

# Every .env* under data/projects except .env.example, NUL-separated. node_modules and .git are not the user's keys.
project_envs() {
  [ -d "$DATA/projects" ] || return 0
  find "$DATA/projects" \( -name node_modules -o -name .git \) -prune -o \
    -type f -name '.env*' ! -name '.env.example' -print0
}

SKIPPED=()
# Fills SRC with the files to move. $1 = 1 adds hub-token and the Claude login (delete --all).
collect() {
  local all="${1:-0}" f n
  SRC=()
  for n in "${CORE_FILES[@]}"; do
    f="$DATA/$n"
    if [ -e "$f" ] || [ -L "$f" ]; then
      if safe_src "$f" "$DATA"; then SRC+=("$f"); else SKIPPED+=("data/$n"); fi
    fi
  done
  while IFS= read -r -d '' f; do
    if safe_src "$f" "$DATA/projects"; then SRC+=("$f"); else SKIPPED+=("${f#"$DATA"/}"); fi
  done < <(project_envs)
  if [ "$all" = 1 ]; then
    f="$DATA/hub-token"
    if [ -e "$f" ]; then if safe_src "$f" "$DATA"; then SRC+=("$f"); else SKIPPED+=("data/hub-token"); fi; fi
    if claude_ok; then SRC+=("$CLAUDE_CREDS"); elif [ -e "$CLAUDE_CREDS" ] || [ -L "$CLAUDE_CREDS" ]; then SKIPPED+=("$CLAUDE_CREDS"); fi
  fi
  return 0
}

# Path inside the disabled folder (and the manifest) for a source file.
rel_of() {
  case "$1" in
    "$CLAUDE_HOME"/*) printf 'claude-home/%s' "${1#"$CLAUDE_HOME"/}" ;;
    *) printf 'data/%s' "${1#"$DATA"/}" ;;
  esac
}
abs_of() {
  case "$1" in
    claude-home/*) printf '%s/%s' "$CLAUDE_HOME" "${1#claude-home/}" ;;
    data/*) printf '%s/%s' "$DATA" "${1#data/}" ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------
inventory() {
  local f n p
  echo "# PocketRocket key inventory"
  echo
  echo "Host: $(hostname 2>/dev/null || echo unknown). Made: $(date '+%F %T %Z'). Data: $DATA"
  echo
  echo "Names only: no value is printed. Rotating a key at its provider is what kills it; moving the file only stops this server using it."
  echo
  echo "| Service | Item | File | Rotate at |"
  echo "|---|---|---|---|"

  f="$DATA/mcp-servers.json"
  if [ -e "$f" ] || [ -L "$f" ]; then
    if safe_src "$f" "$DATA"; then
      while IFS=$'\t' read -r n p; do
        [ -n "$n" ] || continue
        row "$n" "MCP server ($p)" "data/mcp-servers.json" "$(rotate_url "$n $p")"
      done < <(names mcp "$f")
    else row "-" "SKIPPED: symlink" "data/mcp-servers.json" "check by hand"; fi
  fi

  f="$DATA/secrets.json"
  if [ -e "$f" ] || [ -L "$f" ]; then
    if safe_src "$f" "$DATA"; then
      while IFS= read -r n; do if [ -n "$n" ]; then row "${n%%_*}" "$n" "data/secrets.json" "$(rotate_url "$n")"; fi; done < <(names keys "$f")
    else row "-" "SKIPPED: symlink" "data/secrets.json" "check by hand"; fi
  fi

  # Integrations: tokens are AES-GCM encrypted in integrations.json (key in vault.key); the provider list is
  # in the database's integrations table, read here read-only.
  local have_vault=0
  { [ -e "$DATA/integrations.json" ] || [ -e "$DATA/vault.key" ]; } && have_vault=1
  if [ -f "$DATA/pocketrocket.db" ] && [ ! -L "$DATA/pocketrocket.db" ]; then
    while IFS= read -r p; do
      [ -z "$p" ] || row "$p" "Integration token (encrypted)" "data/integrations.json + data/vault.key" \
        "revoke in the app's Integrations or at the provider: $(rotate_url "$p")"
    done < <(names providers "$DATA/pocketrocket.db")
  fi
  if [ "$have_vault" = 1 ]; then
    row "Integrations" "encrypted token store and its key" "data/integrations.json, data/vault.key" "revoke each integration above"
  fi

  [ -e "$DATA/pc-runner.json" ] && row "PC runner" "runner pairing (present)" "data/pc-runner.json" "re-pair the PC runner (runner token)"
  [ -e "$DATA/hub-token" ] && row "PocketRocket app" "hub token" "data/hub-token" "keys.sh delete --all, then reconnect the app"
  [ -e "$DATA/account.json" ] && row "Supabase" "hub account session (refresh token)" "data/account.json" "sign out in the app, or $(rotate_url supabase)"
  [ -e "$DATA/vapid.json" ] && row "Web Push" "VAPID key pair" "data/vapid.json" "delete it: the hub mints a new one; phones re-enable notifications"

  while IFS= read -r -d '' f; do
    if safe_src "$f" "$DATA/projects"; then
      while IFS= read -r n; do
        [ -z "$n" ] || row "${n%%_*}" "$n" "data/${f#"$DATA"/}" "$(rotate_url "$n")"
      done < <(names env "$f")
    else
      row "-" "SKIPPED: symlink or odd name" "data/${f#"$DATA"/}" "check by hand"
    fi
  done < <(project_envs)

  if claude_ok; then
    row "Claude" "Claude login (deleting stops all bots)" "$CLAUDE_CREDS" "https://claude.ai/settings (sign out), then: sudo -u $SERVICE_USER -H claude auth login"
  elif [ -e "$CLAUDE_CREDS" ] || [ -L "$CLAUDE_CREDS" ]; then
    row "Claude" "SKIPPED: symlink or wrong owner" "$CLAUDE_CREDS" "check by hand"
  fi
  echo
  echo "Backups in /var/backups/pocketrocket (or your restic repository) still hold copies of these files."
}

# ---------------------------------------------------------------------------------------------------------
STOPPED=0
svc() {
  [ "$NO_SYSTEMCTL" = 1 ] && return 0
  systemctl "$1" "$SERVICE"
}
start_again() {
  if [ "$STOPPED" = 1 ]; then
    STOPPED=0
    svc start || warn "could not start $SERVICE; run: systemctl start $SERVICE"
  fi
}
stop_svc() { svc stop; STOPPED=1; trap start_again EXIT; }

owner_of() { stat -c '%U:%G:%a' "$1"; }
# -h: never follow a symlink. Only ever called on paths inside a root-only folder (see restore / install_new).
chown_to() { [ "$TEST_MODE" = 1 ] && return 0; chown -h -- "$1" "$2"; }

# Is the folder that will receive $1 a real directory, not a symlink, with no symlink in its chain?
dest_parent_ok() {
  local d
  d="$(dirname "$1")"
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(cd -P "$d" && pwd -P)" = "$d" ]
}

# Writes stdin to $1 as a NEW file owned by the service user, mode 600. The content is first written to a
# root-only temp folder, then `install` creates the destination with owner and mode already set, so nothing is
# ever chowned or chmodded inside the service user's writable folder. A symlink standing at $1 is removed first
# (rm removes the link, never its target).
install_new() {
  local dest="$1" work
  dest_parent_ok "$dest" || die "refusing to write $dest: its folder is missing or a symlink"
  work="$(mktemp -d)"
  chmod 700 "$work"
  cat > "$work/f"
  if [ -L "$dest" ]; then rm -f -- "$dest"; fi
  if [ "$TEST_MODE" = 1 ]; then install -m 600 -- "$work/f" "$dest"
  else install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 600 -- "$work/f" "$dest"; fi
  shred -u -- "$work/f" 2>/dev/null || rm -f -- "$work/f"
  rmdir -- "$work"
}

new_ts() { date +%Y%m%d-%H%M%S; }

# Moves every collected file into $OUT/files/<rel> and records owner/mode in $OUT/manifest.tsv.
move_out() {
  local f rel own
  : > "$OUT/manifest.tsv"
  for f in "${SRC[@]}"; do
    safe_src "$f" "$(dirname "$f")" || { SKIPPED+=("$(rel_of "$f")"); continue; }   # re-check right before the move
    rel="$(rel_of "$f")"
    own="$(owner_of "$f")"
    mkdir -p -m 700 "$OUT/files/$(dirname "$rel")"
    mv -- "$f" "$OUT/files/$rel"
    printf '%s\t%s\n' "$rel" "$own" >> "$OUT/manifest.tsv"
  done
}

write_empty_mcp() {
  printf '{}\n' | install_new "$DATA/mcp-servers.json"
}

# Same shape the hub mints (config.ts): 16 random bytes as 32 hex chars, 0600, owned by the service user.
# The value goes straight from python into install_new's root-only temp file; it is never echoed.
new_hub_token() {
  "$PY" -c 'import secrets,sys; sys.stdout.write(secrets.token_hex(16))' | install_new "$DATA/hub-token"
}

report_skipped() {
  local s
  [ "${#SKIPPED[@]}" -gt 0 ] || return 0
  warn "left in place (symlink, symlinked folder or odd name; check by hand):"
  for s in "${SKIPPED[@]}"; do warn "  $s"; done
}

disable_into() {   # $1 = ts, $2 = include hub-token + Claude login
  TS="$1"
  OUT="$OUT_BASE/pocketrocket-keys-disabled-$TS"
  [ ! -e "$OUT" ] || die "$OUT already exists"
  mkdir -m 700 -- "$OUT"
  inventory > "$OUT/rotate-list-$TS.md"
  chmod 600 "$OUT/rotate-list-$TS.md"
  collect "${2:-0}"
  stop_svc
  move_out
  write_empty_mcp
  [ "${2:-0}" = 1 ] && new_hub_token
  start_again
  report_skipped
}

cmd_disable() {
  disable_into "$(new_ts)" 0
  echo "keys: moved $(wc -l < "$OUT/manifest.tsv" | tr -d ' ') file(s) to $OUT"
  echo "keys: rotate list: $OUT/rotate-list-$TS.md"
  echo "keys: undo with: bash deploy/keys.sh restore $TS"
}

cmd_restore() {
  local ts="${1:-}" rel own user group mode dest src n=0
  [[ "$ts" =~ ^[0-9]{8}-[0-9]{6}$ ]] || die "usage: keys.sh restore <YYYYmmdd-HHMMSS>"
  OUT="$OUT_BASE/pocketrocket-keys-disabled-$ts"
  [ -d "$OUT" ] && [ ! -L "$OUT" ] && [ -f "$OUT/manifest.tsv" ] || die "no disabled set at $OUT"
  stop_svc
  while IFS=$'\t' read -r rel own; do
    [ -n "$rel" ] || continue
    case "$rel" in *..*) warn "skipping odd entry"; continue ;; esac
    src="$OUT/files/$rel"
    dest="$(abs_of "$rel")" || { warn "skipping odd entry"; continue; }
    [ -f "$src" ] && [ ! -L "$src" ] || { warn "missing in the disabled set: $rel"; continue; }
    IFS=: read -r user group mode <<< "$own"
    if ! [[ "$mode" =~ ^[0-7]{3,4}$ && "$user" =~ ^[A-Za-z0-9_.][A-Za-z0-9_.-]*\$?$ && "$group" =~ ^[A-Za-z0-9_.][A-Za-z0-9_.-]*\$?$ ]]; then
      warn "not restoring $rel: odd owner or mode in the manifest (file stays in $OUT)"; continue
    fi
    if ! dest_parent_ok "$dest"; then
      warn "not restoring $rel: its folder is gone or is a symlink (file stays in $OUT)"; continue
    fi
    # Owner and mode are set while the file is still in the root-only folder, never after it lands in a folder
    # the service user can write (where it could have been swapped for a symlink by then).
    chown_to "$user:$group" "$src"
    chmod -- "$mode" "$src"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      # Whatever stands there now (the empty mcp-servers.json, a freshly minted vapid.json) is kept aside, not lost.
      mkdir -p -m 700 "$OUT/replaced/$(dirname "$rel")"
      mv -f -T -- "$dest" "$OUT/replaced/$rel"
    fi
    dest_parent_ok "$dest" || { warn "not restoring $rel: its folder changed under us (file stays in $OUT)"; continue; }
    # -T: treat $dest as the file name itself; if a folder appeared there, fail instead of moving into it.
    mv -T -- "$src" "$dest"
    n=$((n + 1))
  done < "$OUT/manifest.tsv"
  start_again
  echo "keys: restored $n file(s) from $OUT"
  [ -d "$OUT/replaced" ] && echo "keys: files that stood in their place are in $OUT/replaced"
  echo "keys: the folder (with its rotate list) is kept; remove it when done: rm -r $OUT"
}

cmd_delete() {
  local all=0 a
  for a in "$@"; do
    case "$a" in --all) all=1 ;; *) die "unknown option: $a" ;; esac
  done
  echo "This moves every key file out of the hub and SHREDS it. There is no restore."
  printf 'Type DELETE to continue: '
  read -r a || a=""
  [ "$a" = DELETE ] || die "not confirmed; nothing changed"
  if [ "$all" = 1 ]; then
    echo "--all also replaces the hub token and removes the Claude login: every bot stops, the desktop app must"
    echo "reconnect (re-pair), and you must run: sudo -u $SERVICE_USER -H claude auth login"
    printf 'Type ALL to include them: '
    read -r a || a=""
    [ "$a" = ALL ] || die "not confirmed; nothing changed"
  fi
  disable_into "$(new_ts)" "$all"
  local list="$OUT_BASE/rotate-list-$TS.md"
  mv -- "$OUT/rotate-list-$TS.md" "$list"
  find "$OUT" -type f ! -type l -exec shred -u -- {} +
  rm -rf -- "$OUT"
  echo "keys: shredded. Rotate list kept at $list:"
  echo
  cat -- "$list"
  if [ "$all" = 1 ]; then
    echo
    echo "keys: hub token replaced: reconnect the desktop app. Claude login removed: sudo -u $SERVICE_USER -H claude auth login"
  fi
}

case "${1:-}" in
  inventory) inventory ;;
  disable) cmd_disable ;;
  restore) shift; cmd_restore "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  *) die "usage: keys.sh inventory | disable | restore <ts> | delete [--all]" ;;
esac
