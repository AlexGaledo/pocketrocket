<p align="center"><img src="packages/site/assets/rocket.svg" alt="PocketRocket logo" width="96" height="96" /></p>

# PocketRocket

**Your pocket fleet of AI agents.**

[**Website**](https://pocketrocket-chi.vercel.app) · [Download](https://github.com/AlexGaledo/pocketrocket/releases/latest) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/AlexGaledo/pocketrocket?include_prereleases&label=release)](https://github.com/AlexGaledo/pocketrocket/releases)
![Desktop](https://img.shields.io/badge/desktop-Windows-blue)

PocketRocket is a messenger for a team of AI bots that run on your own computer with your Claude
subscription. Each bot has its own name, memory, skills and routines. Message one directly, put a
few in a group chat to hand work to each other, and approve anything risky before it happens.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/site/assets/app-dark.png" />
  <img alt="PocketRocket: a DM with a bot that writes a file in the workspace, showing the tool step inline, with the room's estimated usage in the right panel." src="packages/site/assets/app.png" />
</picture>

## Install and set up

From download to your first conversation, about five minutes.

### What you need

- **Windows 10 or 11** (64-bit). Nothing else to install first: the installer brings its own Node
  runtime and needs no admin rights.
- **A Claude subscription** (Pro or Max), or an Anthropic API key.

### 1. Download

Open the [latest release](https://github.com/AlexGaledo/pocketrocket/releases/latest) and download
`PocketRocket_<version>_x64-setup.exe` from **Assets**.

### 2. Run the installer

Double-click the file. The installer isn't code-signed yet, so Windows SmartScreen says *"Windows
protected your PC"*: click **More info** → **Run anyway**. It installs for your user only, adds a
Start menu shortcut, and doesn't need administrator rights.

### 3. Choose where PocketRocket runs

On first launch the app asks where the bots should live:

- **This PC** (recommended to start). Everything runs and stays on this computer.
- **Your server.** If you already run PocketRocket on a Linux server, the app can look through the
  servers in your `~/.ssh/config`. Tick the ones to check and it tells you which already run
  PocketRocket, which are reachable without it, and which need attention. It only ever uses your
  SSH key, never a password. If a server's key is new, you see its fingerprint and decide; if a
  key has *changed*, the app refuses to connect. Setting up a server is covered in
  [docs/SERVER.md](docs/SERVER.md).

You can switch later from the **Connection** menu.

### 4. Connect Claude

The setup wizard checks that Claude Code is installed and signed in, and re-checks by itself every
few seconds while you fix anything, so there's nothing to restart.

- **Not installed?** Open PowerShell and run:

  ```powershell
  irm https://claude.ai/install.ps1 | iex
  ```

- **Not signed in?** Run `claude` in a new terminal and log in with your Claude account in the
  browser window it opens.

When it's ready you'll see **Signed in as you@example.com · Claude Max** (or Pro). Using an API
key instead? Choose **Skip for now** and add it later in **Settings → Claude**.

### 5. Finish the wizard

1. **Your name**: what bots call you.
2. **Account** (optional): a PocketRocket account is only for future paid plans. **Skip for now**
   is fine; everything works signed out.
3. **Your first bot**: pick **Assistant**, **Coder** or **Researcher**. You can rename and retune it
   any time. Its chat opens straight away.

### 6. Start chatting

- **Message a bot** from the sidebar. Create more with **+** next to *Bots*.
- **Group chat**: create a room with up to 6 bots and @mention the one you want. Bots can @mention
  and hand off to each other.
- **Approvals**: before a bot runs a shell command, edits files outside its workspace, or changes
  your team, an approval card appears in the chat. Allow once, allow for the session, or deny.
- **Workspace**: files bots create live in a shared folder. The folder button in the sidebar opens
  it.
- **Right panel**: each bot's memory, skills, routines (scheduled check-ins) and usage.

What bots can and can't do, and everything else PocketRocket offers, is in
[docs/GUIDE.md](docs/GUIDE.md). Read [SECURITY.md](SECURITY.md) before giving a bot the Browser
or Desktop tool.

## Updating

There's no auto-updater yet. **Help → Check for updates** opens the releases page: download the
newer installer and run it over the existing install. Your bots, chats and settings are kept.

## Uninstalling

**Settings → Apps → Installed apps → PocketRocket → Uninstall.** The installer only ever added the
app folder and its shortcuts: no service, no scheduled task, no autostart entry.

**Your data is kept by default.** Uninstalling removes the program, not
`%APPDATA%\com.pocketrocket.app\`: the database, every bot's memory and skills, the shared
workspace, and logs. Reinstalling picks up where you left off. To erase it too, tick **"Also
delete all bots, conversations and settings"** in the uninstaller (unchecked by default).

## Troubleshooting

| You see | Do this |
|---|---|
| *"Windows protected your PC"* | **More info** → **Run anyway**. The installer is unsigned for now. |
| *Claude Code isn't set up on this computer* | Run the PowerShell install command from step 4; the wizard picks it up by itself. |
| *Found Claude Code but it didn't respond* | Wait a moment and choose **Check again**. The first start after installing can be slow. |
| *Claude needs sign-in* in the sidebar | Run `claude` in a terminal and log in. |
| *Can't reach the hub* | Choose **Retry**. If it keeps failing, **View → Open hub log** shows why. |
| A server shows *needs your SSH key* | Start the **OpenSSH Authentication Agent** service and run `ssh-add`, then scan again. |
| A server shows *new host key* | Compare the fingerprint with your server provider's, then confirm. Or run `ssh <host>` once in a terminal. |
| A server shows *host key changed* | Don't connect. Check with whoever runs the server; this can mean someone is intercepting the connection. |

Still stuck? [Open an issue](https://github.com/AlexGaledo/pocketrocket/issues/new/choose).

## More

- [docs/GUIDE.md](docs/GUIDE.md): features, how bots, rooms, memory and approvals work
- [docs/SERVER.md](docs/SERVER.md): run PocketRocket on a Linux server
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): run from source (macOS, Linux) and build the installer
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every setting and environment variable
- [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](./LICENSE) © 2026 Alex Galedo
