#!/usr/bin/env bash
# PocketRocket "computer": a persistent XFCE desktop on a virtual display, exposed via VNC -> noVNC.
# Display and ports come from SCREEN_DISPLAY / CDP_PORT / VNC_PORT / NOVNC_PORT (defaults below:
# :99, 9222, 5900, 6080).
# - Desktop folder = $DATA/workspace (what bots write shows up on the desktop)
# - Desktop config/home persists in $DATA/desktop-home; Chromium profile in $DATA/browser-profile
# - CDP on 127.0.0.1:9222 (Browser tool), xdotool/scrot on DISPLAY :99 (Desktop tool)
# - noVNC on 127.0.0.1:6080, proxied by the hub at /screen/
# deploy/computer.sh reuses this script for per-bot computers: it also sets SCREEN_HOME / SCREEN_PROFILE /
# SCREEN_DESKTOP_DIR / SCREEN_DOWNLOAD_DIR (the defaults below keep the shared screen exactly as it was).
# Runs as the unprivileged `pocketrocket` user (see deploy/setup-vps.sh); everything above binds
# 127.0.0.1 only and X requires the cookie below. VNC itself has no password: the only way in is the
# hub's /screen/ proxy, which already demands the hub token (a /screen-scoped httpOnly cookie), and a
# second prompt for a VNC password on every Screen tab load added nothing but friction.
set -euo pipefail
DISP="${SCREEN_DISPLAY:-:99}"
CDP_PORT="${CDP_PORT:-9222}"; VNC_PORT="${VNC_PORT:-5900}"; NOVNC_PORT="${NOVNC_PORT:-6080}"
export DISPLAY="$DISP"
DATA="${POCKETROCKET_DATA:-$HOME/pocketrocket/data}"
PROFILE="${SCREEN_PROFILE:-$DATA/browser-profile}"
DHOME="${SCREEN_HOME:-$DATA/desktop-home}"
WS="$DATA/workspace"
DESK="${SCREEN_DESKTOP_DIR:-$WS}"
DL="${SCREEN_DOWNLOAD_DIR:-$WS/downloads}"
W="${SCREEN_W:-1280}"; H="${SCREEN_H:-800}"
# Real Google Chrome, the browser a person would use: logins go through it. Playwright's Chrome for Testing is
# labelled "only for automated testing", so it is only the fallback where Chrome has no build (Linux on ARM).
CHROME="${CHROME_BIN:-$(command -v google-chrome-stable || true)}"
if [ -z "$CHROME" ]; then
  CHROME="$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)"
  [ -z "$CHROME" ] || echo "screen.sh: google-chrome-stable not found; falling back to Chrome for Testing (run deploy/setup-vps.sh as root)" >&2
fi
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then echo "chromium not found; run deploy/setup-vps.sh" >&2; exit 1; fi

mkdir -p "$PROFILE" "$WS" "$DESK" "$DL" "$DHOME/.config/xfce4/xfconf/xfce-perchannel-xml" "$DHOME/.cache" "$DHOME/.local/share"
# Desktop + Downloads + Documents: the shared workspace on the shared screen, the bot's own disk on a per-bot one.
cat > "$DHOME/.config/user-dirs.dirs" <<EOF
XDG_DESKTOP_DIR="$DESK"
XDG_DOWNLOAD_DIR="$DL"
XDG_DOCUMENTS_DIR="$DESK"
EOF
# A per-bot desktop links the shared team folder in as ~/Shared and onto the desktop.
if [ "$DESK" != "$WS" ]; then
  for link in "$DHOME/Shared" "$DESK/Shared"; do
    if [ -L "$link" ] || [ ! -e "$link" ]; then ln -sfn "$WS" "$link"; fi
  done
fi
# Terminals open in the desktop folder, not in the desktop home.
mkdir -p "$DHOME/.config/xfce4/terminal"
grep -q MiscDefaultWorkingDir "$DHOME/.config/xfce4/terminal/terminalrc" 2>/dev/null || cat > "$DHOME/.config/xfce4/terminal/terminalrc" <<EOF
[Configuration]
MiscDefaultWorkingDir=$DESK
MiscMenubarDefault=FALSE
EOF
# Seed the default panel layout once so XFCE does not show its first-run wizard.
PANEL_XML="$DHOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
[ -f "$PANEL_XML" ] || cp /etc/xdg/xfce4/panel/default.xml "$PANEL_XML" 2>/dev/null || true
# Sensible desktop defaults once (dark-ish, no compositor on Xvfb).
XFWM_XML="$DHOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml"
[ -f "$XFWM_XML" ] || cat > "$XFWM_XML" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0"><property name="general" type="empty">
<property name="use_compositing" type="bool" value="false"/>
<property name="theme" type="string" value="Default"/>
</property></channel>
EOF

trap 'kill 0 2>/dev/null || true' EXIT

# X access control: a per-run MIT-MAGIC-COOKIE in desktop-home, not `-ac` (which disables access
# control entirely). Every X client below (and the hub's own xdotool/scrot, via XAUTHORITY set in
# the systemd unit) needs this same file to connect.
export XAUTHORITY="$DHOME/.Xauthority"
touch "$XAUTHORITY"
chmod 600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISP" . "$(mcookie 2>/dev/null || openssl rand -hex 16)"

Xvfb "$DISP" -auth "$XAUTHORITY" -screen 0 "${W}x${H}x24" -nolisten tcp +extension RANDR >/dev/null 2>&1 &
sleep 1

# XFCE session pieces run with HOME=$DHOME so every setting persists in data/.
export HOME="$DHOME" XDG_CONFIG_HOME="$DHOME/.config" XDG_CACHE_HOME="$DHOME/.cache" XDG_DATA_HOME="$DHOME/.local/share"
export XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=XFCE
eval "$(dbus-launch --sh-syntax)"
xfsettingsd >/dev/null 2>&1 &
sleep 0.5
xfwm4 --compositor=off >/dev/null 2>&1 &
xfce4-panel --disable-wm-check >/dev/null 2>&1 &
xfdesktop >/dev/null 2>&1 &
sleep 2

# Chromium sandbox needs unprivileged user namespaces now that this runs as a non-root user
# (deploy/setup-vps.sh enables kernel.unprivileged_userns_clone on Debian). Fall back to
# --no-sandbox only if the kernel actually refuses them.
SANDBOX_ARGS=()
userns_ok=1
if [ -e /proc/sys/kernel/unprivileged_userns_clone ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" != "1" ]; then
  userns_ok=0
fi
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "1" ]; then
  userns_ok=0
fi
# Ubuntu 23.10+ restricts user namespaces per program and ships a profile allowing them for Google Chrome alone,
# which also works under the unit's NoNewPrivileges (Chrome's setuid helper would not).
if [ "$(readlink -f "$CHROME")" = "/opt/google/chrome/google-chrome" ] && grep -qs "/opt/google/chrome/chrome" /etc/apparmor.d/chrome; then
  userns_ok=1
fi
if [ "$userns_ok" != "1" ]; then
  echo "screen.sh: unprivileged user namespaces are restricted; Chromium's sandbox needs them as a non-root user. Falling back to --no-sandbox (re-run deploy/setup-vps.sh as root to enable kernel.unprivileged_userns_clone)." >&2
  SANDBOX_ARGS=(--no-sandbox)
fi

# Keep logins across restarts. Many sites sign in with a session-only cookie, and Chrome discards those at startup
# unless it is set to continue where it left off. This also reopens the last tabs, so the start page only opens on
# a profile with no tabs to reopen; otherwise every start would add one more.
mkdir -p "$PROFILE/Default"
python3 - "$PROFILE/Default/Preferences" <<'PY' || echo "screen.sh: could not set Chrome to keep session cookies" >&2
import json, os, sys
path = sys.argv[1]
prefs = json.load(open(path)) if os.path.exists(path) else {}
prefs.setdefault("session", {})["restore_on_startup"] = 1
with open(path + ".tmp", "w") as f:
    json.dump(prefs, f)
os.replace(path + ".tmp", path)
PY
START_URL=()
[ -d "$PROFILE/Default/Sessions" ] || START_URL=("https://www.google.com")

# No --remote-allow-origins: Playwright/CDP clients connect from Node over a plain WebSocket with
# no Origin header, which Chromium's remote-debugging Origin allowlist only checks/enforces when
# an Origin header is present (i.e. a browser page trying to reach it) — see deploy/setup-vps.sh
# header comment and the PocketRocket audit item 8 for the verification notes.
# Smooth scrolling and page animations turn one scroll or hover into dozens of frames that VNC then has to encode
# and send; switching them off keeps the Screen tab responsive. Pages still render the same, just without tweening.
"$CHROME" "${SANDBOX_ARGS[@]}" --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \
  --disable-smooth-scrolling --force-prefers-reduced-motion \
  --disable-session-crashed-bubble --disable-features=TranslateUI --password-store=basic \
  --remote-debugging-port="$CDP_PORT" --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" --window-position=0,0 --window-size="$W,$((H-40))" \
  ${START_URL[@]+"${START_URL[@]}"} >/dev/null 2>&1 &

# P2: VNC_VIEWONLY=1 (per-bot computers) starts the viewer view-only: the bot has control until the user takes
# over, and the hub flips it live with `x11vnc -R viewonly|noviewonly` (services/ComputerControl.ts). Remote
# control goes through an X property, so it needs this display and its cookie, nothing on the network.
VNC_ARGS=()
if [ "${VNC_VIEWONLY:-0}" = "1" ]; then VNC_ARGS=(-viewonly); fi
# Frame rate: x11vnc follows Xvfb's DAMAGE events to find what changed instead of rescanning the whole frame on
# every poll (the old -noxdamage), and -wait/-defer halve its default 20 ms poll and send delays.
x11vnc -display "$DISP" -localhost -nopw -forever -shared -wait 10 -defer 10 ${VNC_ARGS[@]+"${VNC_ARGS[@]}"} -rfbport "$VNC_PORT" -quiet >/dev/null 2>&1 &
exec websockify --web /usr/share/novnc "127.0.0.1:$NOVNC_PORT" "127.0.0.1:$VNC_PORT"
