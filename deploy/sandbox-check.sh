#!/usr/bin/env bash
# Bridge P7 acceptance test for the bot sandbox: builds the REAL bubblewrap argv the hub uses for a bot (packages/hub/src/
# sandboxCli.ts) and checks, from inside it, that a bot in project A's room cannot reach project B's folder, another bot's
# home, the vault key, the hub token or the database, while its own folders still work.
#
#   bash deploy/sandbox-check.sh                      # picks the first two projects and bots it finds
#   BOT_A=<id> BOT_B=<id> PROJECT_A=<slug> PROJECT_B=<slug> bash deploy/sandbox-check.sh
#
# Run as root or as the hub user (root re-runs itself as that user, because that is who the hub runs the CLI as).
# Reads only, except a short-lived file in bot A's own folder. Exit 0: no leak. Exit 1: a leak. Exit 3: could not test.
set -uo pipefail

APP_USER="${POCKETROCKET_USER:-pocketrocket}"
if [ "$(id -u)" = "0" ]; then
  exec runuser -u "$APP_USER" -- env "POCKETROCKET_DATA=${POCKETROCKET_DATA:-}" bash "$(readlink -f "$0")" "$@"
fi

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${POCKETROCKET_DATA:-$INSTALL_DIR/data}"
export POCKETROCKET_DATA="$DATA_DIR"
HUB_DIR="$INSTALL_DIR/packages/hub"

command -v bwrap >/dev/null 2>&1 || { echo "bwrap is not installed (apt-get install bubblewrap)"; exit 3; }
[ -x "$HUB_DIR/node_modules/.bin/tsx" ] || { echo "missing $HUB_DIR/node_modules/.bin/tsx (run pnpm install)"; exit 3; }

first_two() { find "$1" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | LC_ALL=C sort | head -2; }
read -r PA PB < <(first_two "$DATA_DIR/projects" | paste -sd' ')
read -r BA BB < <(first_two "$DATA_DIR/bots" | paste -sd' ')
PROJECT_A="${PROJECT_A:-${PA:-}}"; PROJECT_B="${PROJECT_B:-${PB:-}}"
BOT_A="${BOT_A:-${BA:-}}"; BOT_B="${BOT_B:-${BB:-}}"
if [ -z "$PROJECT_A" ] || [ -z "$PROJECT_B" ] || [ -z "$BOT_A" ] || [ -z "$BOT_B" ]; then
  echo "need two projects and two bots under $DATA_DIR (set PROJECT_A/PROJECT_B/BOT_A/BOT_B)"; exit 3
fi
[ "$PROJECT_A" != "$PROJECT_B" ] && [ "$BOT_A" != "$BOT_B" ] || { echo "A and B must differ"; exit 3; }

mapfile -d '' -t ARGV < <(cd "$HUB_DIR" && ./node_modules/.bin/tsx src/sandboxCli.ts print-argv --bot "$BOT_A" --project "$PROJECT_A")
[ "${#ARGV[@]}" -gt 10 ] || { echo "could not build the sandbox argv"; exit 3; }
box() { bwrap "${ARGV[@]}" -- "$@"; }

fail=0
leak() { echo "LEAK: $1"; fail=1; }
ok()   { echo "ok:   $1"; }
box /usr/bin/true || { echo "the sandbox itself does not start (see docs/SERVER.md, AppArmor)"; exit 3; }

# Must stay reachable.
box /usr/bin/test -d "$DATA_DIR/projects/$PROJECT_A" && ok "project A folder is mounted" || leak "project A folder is missing (the bot cannot do its job)"
box /usr/bin/test -d "$DATA_DIR/bots/$BOT_A" && ok "own bot home is mounted" || leak "own bot home is missing"
canary="$DATA_DIR/bots/$BOT_A/.sandbox-check-$$"
box /usr/bin/touch "$canary" && ok "own bot home is writable" || leak "own bot home is not writable"
rm -f "$canary"

# Must not exist inside.
hidden() { # description path
  if box /usr/bin/test -e "$2"; then leak "$1 is visible: $2"; else ok "$1 is hidden"; fi
}
hidden "vault key" "$DATA_DIR/vault.key"
hidden "hub token" "$DATA_DIR/hub-token"
hidden "database" "$DATA_DIR/pocketrocket.db"
hidden "project B folder" "$DATA_DIR/projects/$PROJECT_B"
hidden "bot B home" "$DATA_DIR/bots/$BOT_B"
hidden "service user's .ssh" "$HOME/.ssh"
hidden "service user's ~/.claude.json" "$HOME/.claude.json"
hidden "hub source" "$INSTALL_DIR/packages"

# The P7 test: cat a real file of project B with Bash.
file_b="$(find "$DATA_DIR/projects/$PROJECT_B" -type f -size -1M 2>/dev/null | head -1)"
if [ -n "$file_b" ]; then
  if box /usr/bin/cat "$file_b" >/dev/null 2>&1; then leak "cat of project B file succeeded: $file_b"; else ok "cat of a project B file fails"; fi
else
  echo "note: project B has no file to cat; the folder check above stands in for it"
fi
# Listing the data folder must show only mounted paths.
listing="$(box /usr/bin/ls -A "$DATA_DIR" 2>&1)"
for secret in vault.key hub-token pocketrocket.db credentials.json secrets.json; do
  printf '%s\n' "$listing" | grep -qx "$secret" && leak "data folder listing shows $secret"
done
[ "$fail" = 0 ] && ok "data folder listing shows no secrets"

# The CLI still runs inside.
if [ -x "$HOME/.local/bin/claude" ]; then
  box "$(readlink -f "$HOME/.local/bin/claude")" --version >/dev/null 2>&1 && ok "claude --version runs inside" || leak "claude does not run inside the sandbox"
fi

[ "$fail" = 0 ] && echo "PASS: no leak" || echo "FAIL: see LEAK lines"
exit "$fail"
