# Fork decisions (answers to grok-bot-parity.md §6)

Decided 2026-10-31. The user said "start all phases" and asked for one specific behavior for integrations (see Q4). Every other answer below is the recommended default. Any of them can be revisited.

| Q | Decision |
|---|---|
| Q1 Identity | The product is **PocketRocket Crew**. It must install side by side with stock PocketRocket, so it gets its own Tauri identifier `com.pocketrocket.crew`, default port **7790**, systemd units `pocketrocket-crew*.service` and service user `pocketrocket-crew`. Its localStorage keys use the prefix `prcrew.`. |
| Q2 Upstream | Keep the code mergeable with upstream: leave the `@pocketrocket/*` package scope, the `mcp__pocketrocket__*` tool names and the `POCKETROCKET_*` env names alone. Remote `upstream` = `AlexGaledo/pocketrocket`. Supabase account sign-in stays wired but optional, and nothing new goes to the cloud. |
| Q3 Isolation | Option B: each bot gets its own display, Chromium profile and CDP/VNC ports, running as the same uid. The UI must **not** call this isolation. Containers are deferred. `MAX_RUNNING_COMPUTERS` defaults to 3 and can be set by env. |
| Q4 OAuth | **Settings → Integrations offers two ways to connect each provider:** (a) **Connect with OAuth**, which uses the user's own OAuth app (client id and secret pasted into Settings) with PKCE and a loopback redirect, or (b) **Paste a key/token** (GitHub PAT, Slack bot/app token, Google service account or app password where that works, ClickUp API key). Both are stored in the IntegrationVault. No PocketRocket-owned OAuth apps. |
| Q5 Events | Events arrive by outbound polling, plus Slack Socket Mode. No public inbound webhooks and no relay. |
| Q6 Bypass | Turns started by a trigger or a routine **always** go through approvals, even when the hub is in bypass mode. |
| Q7 Sharing | Connections are shared at the account level, but each bot must be **granted** access before it can use one. |
| Q8 Backups | Backups stay on the VPS only. `vault.key` is excluded from backups. A restic option is documented but off. |
| Q9 Phone | Ship a PWA. Off-loopback access needs **opt-in** `POCKETROCKET_ALLOWED_HOSTS` (HTTPS/tailnet only) and is off by default. No native iOS app. |
| Q10 Push | Web Push is opt-in and carries **no content**. |
| Q11 Platforms | Tray/close-to-tray first, then Linux AppImage/deb in CI, then macOS (unsigned). |
| Q12 Providers | The Grok adapter stays dev-only. The model router stays within the active provider. |
| Q13 Plans | Free and self-hosted. No plan gating. |

## Merge conventions for parallel phases
- Each phase works on its own branch `phase/pN-*` in its own git worktree under `C:\Users\alex\desktop\prc-wt\pN`.
- **DB migrations:** each phase may only use its own block of versions in the P0 migration runner. P0 uses 1–9, P1 10–19, P2 20–29, P3 30–39, P4 40–49, P5 50–59, P6 60–69, P7 70–79, P8 80–89, P9 90–99. Migrations are additive only.
- **CHANGELOG:** do not edit `CHANGELOG.md`. Write the release notes for the phase to `docs/changes/pN.md`, and the integrator merges them in.
- **Shared files** (`protocol.ts`, `models.ts`, `schema.ts`, `botTools.ts`, `SettingsDialog.tsx`, `RightPanel.tsx`): append new code in clearly separated blocks rather than reordering existing code, so merges stay simple.
