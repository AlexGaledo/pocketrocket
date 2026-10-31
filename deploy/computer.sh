#!/usr/bin/env bash
# One bot's own computer: deploy/screen.sh with its display, ports and folders derived from a slot.
#
#   computer.sh <slot> <botId>      or      computer.sh <slot>-<botId>   (the systemd instance name, %i)
#
# Run by the systemd *user* unit pocketrocket-crew-computer@<slot>-<botId>.service, which the hub starts and
# stops itself (services/ComputerManager.ts; no root). Slot n (1-99) is:
#   display :(200+n)   CDP 127.0.0.1:(9400+n)   VNC 127.0.0.1:(5800+n)   noVNC/websockify 127.0.0.1:(6200+n)
# These never collide with the shared Crew screen (:98, 9223, 5901, 6081), stock PocketRocket (:99, 9222,
# 5900, 6080) or the X11 TCP range. Every port binds 127.0.0.1 only (screen.sh), and X needs the per-computer
# MIT cookie in its home.
#
# Folders (under data/, which is what gets backed up):
#   data/computers/<botId>/home      XFCE HOME + .Xauthority      (was data/desktop-home)
#   data/computers/<botId>/browser   Chromium profile = this bot's logins (was data/browser-profile)
#   data/computers/<botId>/files     the bot's own disk: Desktop, Downloads; ~/Shared -> data/workspace
#
# Not isolation: every computer runs as the same uid, so one bot's shell can read another bot's profile.
set -euo pipefail
ARG1="${1:-}"; ARG2="${2:-}"
if [ -z "$ARG2" ]; then SLOT="${ARG1%%-*}"; BOT_ID="${ARG1#*-}"; else SLOT="$ARG1"; BOT_ID="$ARG2"; fi
if ! [[ "$SLOT" =~ ^[0-9]{1,2}$ ]] || [ "$SLOT" -lt 1 ] || [ "$SLOT" -gt 99 ]; then
  echo "computer.sh: slot must be 1-99, got '$SLOT'" >&2; exit 2
fi
if ! [[ "$BOT_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || [ "$BOT_ID" = "$ARG1" ]; then
  echo "computer.sh: bad bot id '$BOT_ID'" >&2; exit 2
fi

DATA="${POCKETROCKET_DATA:-$HOME/pocketrocket-crew/data}"
CDIR="$DATA/computers/$BOT_ID"
mkdir -p "$CDIR/home" "$CDIR/browser" "$CDIR/files/Desktop" "$CDIR/files/Downloads"
chmod 700 "$CDIR"

export POCKETROCKET_DATA="$DATA"
export SCREEN_DISPLAY=":$((200 + SLOT))"
export CDP_PORT="$((9400 + SLOT))" VNC_PORT="$((5800 + SLOT))" NOVNC_PORT="$((6200 + SLOT))"
export SCREEN_HOME="$CDIR/home" SCREEN_PROFILE="$CDIR/browser"
export SCREEN_DESKTOP_DIR="$CDIR/files/Desktop" SCREEN_DOWNLOAD_DIR="$CDIR/files/Downloads"
# P2: the bot has control when its computer starts, so the viewer can only watch (see screen.sh).
export VNC_VIEWONLY=1
exec bash "$(dirname "$0")/screen.sh"
