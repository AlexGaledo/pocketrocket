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

## Migration blocks for the OpenBot gap work (recorded 2026-11-17)
Versions 200-249 are already used on `origin/main` (highest is 240, `packages/hub/src/db/migrations.ts`), and no unmerged
`origin/*` branch claims a block above it. The OpenBot gap specs (`docs/specs/openbot-gaps/`) use these blocks, additive
only, under the same rules as the P0-P9 blocks above:

| Block | Gap / phase | Contents |
|---|---|---|
| 250-259 | Gap 2 Phases 1-2: steering and queue | `lane_journal.status` (steer rows), `lane_journal.owner_ref`, `messages.cancelled_at` |
| 260-269 | Gap 2 Phase 3: workflows | `workflows`, `workflow_runs` |
| 270-279 | ~~Gap 1: providers and failover~~ Taken first by the Claude Code bridge P3 PC session mirror (270-271) | `pc_sessions`, `pc_session_entries`, `pc_session_tombstones` |
| 280-289 | Gap 3: chat channels | `channel_links`, Telegram link/offset state |
| 290-299 | Gap 4: multiplayer (deferred) | `user_invites`, `room_members` |

300-309 stays reserved for gap 2 media steps, if they are ever built. (On `origin/main`, Telegram notifications use 300.)

**Moved 2026-11-19:** gap 1 (providers and failover) uses **310-319**, because 270-279 was already used on `origin/main`.
M6 uses 310 `bots.provider`, 311 `bots.backup` and 312 `usage.provider`. M8 uses 313 `failover_cards`; 314-319 stay free.

## OpenBot gaps: owner decisions (interview 2026-11-17)
Full answers are in `docs/specs/openbot-gaps/05-owner-decisions.md`; the concluded plan is `06-direction.md` in the same
folder. The decisions other work must respect:

| Topic | Decision |
|---|---|
| Clean room | Agents may read OpenBot source (PolyForm Noncommercial) to learn behaviour; never copy code, identifiers, strings or assets. |
| Licence and money | **MIT + CLA** from the first outside PR. Free now. If ever sold: **managed self-host** (customer's own cloud and API key, setup/support fee); no multi-tenant hosting, no seats. Distribution budget **$0/yr**. |
| Ship order | **Steering + workflows first**, then providers. |
| Steering | A message to a busy bot **joins the running turn**; Ctrl+Enter or the Send menu queues (Alt+Enter is the desktop full-screen toggle); bot hand-offs always queue. Stop re-queues unanswered steers and the bot answers them right after. Automation turns can be steered and stay strict. Non-steering providers queue with a reason. Queue controls: cancel, edit, send now, pause; no reorder. |
| Workflows | **React Flow canvas (`@xyflow/react`, MIT), lazy-loaded**, over a `{nodes, edges}` graph that a Steps list also renders; v1 linear only. Image/video steps deferred. |
| Providers | Next release ships **Claude + Gemini** (Gemini after a live test); Codex/Grok/OpenCode stay dev-only and frozen. Gemini on the Google login runs **only attended turns**; unattended turns run only when `agy` reports API-key auth. |
| Failover | **Ask with a card**; the limited turn ends at once with the reset time; a press queues a new turn on the one owner-set backup, **always strict**. Nothing switches silently. |
| Channels | **No WhatsApp.** Scope now: **Telegram notifications only**, content-free, owner only. Allow-once from chat and auto-reply wait for the chat phase. |
| Distribution | Unsigned + checksums + attestations now; apply to SignPath in parallel; decide on unbundling the Agent SDK after SignPath answers. Updates: daily check (and every 24 h while running), ask before installing, never during a turn or live card. Docker: Linux `--network host` first. Multiplayer deferred until gap 1 settles credentials, then API key or Team/Enterprise login only. |
