# Desktop app

`packages/desktop` is a small native window (WebView2, Tauri) with three ways to run, switchable
from its **Connection** menu:

| Mode | What happens | State lives in |
|---|---|---|
| **Local: this PC** (default) | The app starts its own hub as a child process and shuts it down on quit. No network hop. | `%APPDATA%\com.pocketrocket.app\data\` — SQLite db (WAL), bot memories, workspace, skills. `hub.log` next to it. |
| **VPS over SSH tunnel** | Opens an SSH tunnel to the hub on your server itself, waits for it, and respawns the tunnel if it drops. Gets the virtual desktop/screen. | on the VPS |
| **Attach** | Connects to a hub you already run (`pnpm dev` / `pnpm start`). | wherever that hub points |

Node runtime: the desktop app looks for a system Node ≥ 22.13 on `PATH` first; if none is found,
it falls back to a Node 24 LTS binary bundled with the installer, so the app works out of the box
even with no Node installed.

## Building

Building the desktop app additionally requires Rust (MSVC toolchain), Visual Studio Build Tools,
WebView2 (bundled with Windows 11), and `cargo tauri`.

```bash
pnpm desktop:build      # -> packages/desktop/src-tauri/target/release/PocketRocket.exe
                        #    + bundle/nsis/PocketRocket_<version>_x64-setup.exe
pnpm desktop:dev
```

## Uninstalling

Apps & features → PocketRocket → Uninstall. The installer is per-user and installs nothing but the
app folder and its shortcuts: no Windows service, no scheduled task, no autostart entry, nothing
outside your own user profile.

**Your data is deliberately left behind.** Uninstalling removes the program, not
`%APPDATA%\com.pocketrocket.app\` — the SQLite database, every bot's memory and skills, the shared
workspace, `hub-token`, and `hub.log`. Reinstalling picks up exactly where you left off. To erase
it too, delete that folder by hand after uninstalling.
