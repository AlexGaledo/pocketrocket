#!/usr/bin/env bash
# PocketRocket "computer": a persistent XFCE desktop on a virtual display, exposed via VNC -> noVNC.
# - Desktop folder = $DATA/workspace (what bots write shows up on the desktop)
# - Desktop config/home persists in $DATA/desktop-home; Chromium profile in $DATA/browser-profile
# - CDP on 127.0.0.1:9222 (Browser tool), xdotool/scrot on DISPLAY :99 (Desktop tool)
# - noVNC on 127.0.0.1:6080, proxied by the hub at /screen/
# Runs as the unprivileged `pocketrocket` user (see deploy/setup-vps.sh); everything above binds
# 127.0.0.1 only, VNC requires the password in $DATA/vnc-passwd, and X requires the cookie below.
set -euo pipefail
export DISPLAY=:99
DATA="${POCKETROCKET_DATA:-$HOME/pocketrocket/data}"
PROFILE="$DATA/browser-profile"
DHOME="$DATA/desktop-home"
WS="$DATA/workspace"
W="${SCREEN_W:-1280}"; H="${SCREEN_H:-800}"
CHROME="${CHROME_BIN:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)}"
if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then echo "chromium not found; run deploy/setup-vps.sh" >&2; exit 1; fi
if [ ! -f "$DATA/vnc-passwd" ]; then echo "vnc password not found; run deploy/setup-vps.sh" >&2; exit 1; fi

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

# X access control: a per-run MIT-MAGIC-COOKIE in desktop-home, not `-ac` (which disables access
# control entirely). Every X client below (and the hub's own xdotool/scrot, via XAUTHORITY set in
# the systemd unit) needs this same file to connect.
export XAUTHORITY="$DHOME/.Xauthority"
touch "$XAUTHORITY"
chmod 600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add :99 . "$(mcookie 2>/dev/null || openssl rand -hex 16)"

Xvfb :99 -auth "$XAUTHORITY" -screen 0 "${W}x${H}x24" -nolisten tcp +extension RANDR >/dev/null 2>&1 &
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
if [ "$userns_ok" != "1" ]; then
  echo "screen.sh: unprivileged user namespaces are restricted; Chromium's sandbox needs them as a non-root user. Falling back to --no-sandbox (re-run deploy/setup-vps.sh as root to enable kernel.unprivileged_userns_clone)." >&2
  SANDBOX_ARGS=(--no-sandbox)
fi

# No --remote-allow-origins: Playwright/CDP clients connect from Node over a plain WebSocket with
# no Origin header, which Chromium's remote-debugging Origin allowlist only checks/enforces when
# an Origin header is present (i.e. a browser page trying to reach it) — see deploy/setup-vps.sh
# header comment and the PocketRocket audit item 8 for the verification notes.
"$CHROME" "${SANDBOX_ARGS[@]}" --test-type --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --disable-features=TranslateUI --password-store=basic \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" --window-position=0,0 --window-size="$W,$((H-40))" \
  "https://www.google.com" >/dev/null 2>&1 &

x11vnc -display :99 -localhost -rfbauth "$DATA/vnc-passwd" -forever -shared -noxdamage -rfbport 5900 -quiet >/dev/null 2>&1 &
exec websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
