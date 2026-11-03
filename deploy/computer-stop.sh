#!/usr/bin/env bash
# Closes one bot's Chrome before systemd signals the rest of its computer.
#
#   computer-stop.sh <slot>-<botId>     (the systemd instance name, %i)
#
# systemd signals every process in the unit at once, so the X display goes away while Chrome is still saving, and
# Chrome exits as crashed with its latest cookies unwritten. Chrome saves everything on SIGTERM if the display is
# still up. Only its main process carries --remote-debugging-port.
set -u
SLOT="${1%%-*}"
if ! [[ "$SLOT" =~ ^[0-9]{1,2}$ ]]; then echo "computer-stop.sh: bad instance '${1:-}'" >&2; exit 0; fi
PID="$(pgrep -o -u "$(id -u)" -f -- "--remote-debugging-port=$((9400 + SLOT))( |\$)" || true)"
[ -n "$PID" ] || exit 0
kill -TERM "$PID" 2>/dev/null || exit 0
# Well inside the hub's 30 second limit on `systemctl --user stop`. A stuck Chrome is then left to systemd.
for _ in $(seq 1 40); do
  # Z counts as gone: Chrome's parent, websockify, does not reap it, so it stays listed until the unit ends.
  case "$(ps -o stat= -p "$PID" 2>/dev/null)" in ''|Z*) exit 0 ;; esac
  sleep 0.25
done
echo "computer-stop.sh: Chrome $PID still running after 10 seconds" >&2
exit 0
