#!/usr/bin/env bash
# Claudebot "computer": a persistent XFCE desktop on a virtual display, exposed via VNC -> noVNC.
# - Desktop folder = $DATA/workspace (what bots write shows up on the desktop)
# - Desktop config/home persists in $DATA/desktop-home; Chromium profile in $DATA/browser-profile
# - CDP on 127.0.0.1:9222 (Browser tool), xdotool/scrot on DISPLAY :99 (Desktop tool)
# - noVNC on 127.0.0.1:6080, proxied by the hub at /screen/
set -euo pipefail
export DISPLAY=:99
DATA="${CLAUDEBOT_DATA:-$HOME/claudebot/data}"
PROFILE="$DATA/browser-profile"
DHOME="$DATA/desktop-home"
WS="$DATA/workspace"
W="${SCREEN_W:-1280}"; H="${SCREEN_H:-800}"
CHROME="${CHROME_BIN:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)}"
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then echo "chromium not found; run deploy/setup-vps.sh" >&2; exit 1; fi

mkdir -p "$PROFILE" "$WS/downloads" "$DHOME/.config/xfce4/xfconf/xfce-perchannel-xml" "$DHOME/.cache" "$DHOME/.local/share"
# Desktop + Downloads + Documents all point into the shared workspace.
cat > "$DHOME/.config/user-dirs.dirs" <<EOF
XDG_DESKTOP_DIR="$WS"
XDG_DOWNLOAD_DIR="$WS/downloads"
XDG_DOCUMENTS_DIR="$WS"
EOF
# Terminals open in the workspace (desktop folder), not in desktop-home.
mkdir -p "$DHOME/.config/xfce4/terminal"
grep -q MiscDefaultWorkingDir "$DHOME/.config/xfce4/terminal/terminalrc" 2>/dev/null || cat > "$DHOME/.config/xfce4/terminal/terminalrc" <<EOF
[Configuration]
MiscDefaultWorkingDir=$WS
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
Xvfb :99 -screen 0 "${W}x${H}x24" -nolisten tcp -ac +extension RANDR >/dev/null 2>&1 &
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

"$CHROME" --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --disable-features=TranslateUI --password-store=basic \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  --user-data-dir="$PROFILE" --window-position=0,0 --window-size="$W,$((H-40))" \
  "https://www.google.com" >/dev/null 2>&1 &

x11vnc -display :99 -localhost -nopw -forever -shared -noxdamage -rfbport 5900 -quiet >/dev/null 2>&1 &
exec websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
