# PocketRocket production checklist

Use before every public release. Status column: ☑ done and verified · ☐ open · ◐ partial. Updated 2026-11-03 (live VPS results at commits 724677b and 40373b2, sections 7 and 7b); v0.2.0 pre-release pass 2026-09-16; fork phases P0–P9 added 2026-11-01 (section 7b). Security reviews: reports kept privately outside the repo (see SECURITY.md → Audits); remediation is in CHANGELOG → Security. v1 scope: Claude only, approvals on by default, optional PocketRocket account — see CHANGELOG `[0.2.0]`.

## 1. Build and quality gates

| Item | Status | How to verify |
|---|---|---|
| Typecheck + Vite build clean | ☑ | `pnpm -r build` |
| Unit tests green | ◐ one known failure on master since 2026-11-02, see 7b finding 5 | `pnpm test` |
| Versions in sync (root, packages, tauri.conf, Cargo.toml) | ☑ | `pnpm version:sync --check` |
| `Cargo.lock` refreshed after a version bump | ☐ per release | `cargo check` then commit |
| CI green on `main` (`ci.yml`: ubuntu tests + windows desktop:prepare + cargo check) | ☑ run 34250487822 | GitHub Actions tab |
| Release workflow produces the NSIS installer (`release.yml`) | ☐ untested on a tag | push `v0.2.0` tag, watch Actions |
| `release.yml` workflow_dispatch dry run succeeds and its installer artifact installs cleanly on a fresh Windows account | ☐ | Actions → Release → Run workflow (no tag); download `pocketrocket-windows-installer` artifact, run it on an account with no prior PocketRocket data |
| CHANGELOG has an entry for the release | ☑ `[0.2.0]` filled in | `CHANGELOG.md` |

## 2. Security

This section tracks the private pre-release audit report (leaks, vulnerabilities, verified-OK, and its action order).

| Item | Status | How to verify |
|---|---|---|
| Hub binds `127.0.0.1` only | ☑ | `netstat -ano \| findstr 7790` |
| Origin check on REST + WS + `/screen/` upgrade, including `Origin: null` | ☑ tests | `curl -H "Origin: null" http://127.0.0.1:7790/api/bots` → 403 |
| Host check (DNS rebinding) | ☑ tests | `curl -H "Host: evil.example" ...` → rejected |
| Bearer token always required (audit B3/D3) — auto-generated to `<data>/hub-token` when `POCKETROCKET_TOKEN` unset, health stays open | ☑ | `/api/bots` 401 without token, `/api/health` 200 |
| `/screen/*` behind the same token (audit B2) | ☑ | `curl http://127.0.0.1:7790/screen/vnc.html` → 401 without token |
| `/screen/*` authenticated by a `/screen`-scoped httpOnly cookie, bought with a single-use ticket; no `?token=` there | ☑ tests | `curl 'http://127.0.0.1:7790/screen/vnc.html?token=<token>'` → 401; `screenTicket.test.ts` |
| Per-turn MCP token on `/mcp`; tools scoped to that turn | ☑ tests | `mcp/httpServer.test.ts` |
| Secrets file never returned by the API (`GET /api/secrets` = which keys set) | ☑ | `SecretsStore.test.ts` |
| No telemetry / no outbound calls except Claude, the GitHub releases page, Supabase auth (only when signed in), and these, each only after the user turns it on: **integration providers the user connected** (P4 tools, P5 trigger polling): `api.github.com` `github.com` (incl. device flow) · `accounts.google.com` `oauth2.googleapis.com` `openidconnect.googleapis.com` `gmail.googleapis.com` `www.googleapis.com` (Calendar, Drive) · `slack.com` (Web API, `apps.connections.open`) and **Slack Socket Mode `wss-*.slack.com`** (outbound WebSocket, P5) · `api.clickup.com` `app.clickup.com` · `login.microsoftonline.com` (incl. device flow) `graph.microsoft.com`; **Web Push services** (P9, per subscribed phone; the hub refuses any other endpoint): `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`; **git remotes the user names** (P7): the knowledge repo URL and Skills › From git URLs | ☐ | grep for `fetch(`/`https://`/`wss://` in hub; integration hosts live only in `packages/hub/src/integrations/*` and `services/TriggerService.ts`/`SlackSocketMode.ts`; push hosts in `services/WebPush.ts` (`PUSH_HOSTS`); SECURITY.md |
| Approvals ask by default for shell commands, out-of-workspace edits, and fleet/room changes; bypass mode is an explicit opt-in (Settings → Bots → Approvals, or `POCKETROCKET_BYPASS_PERMISSIONS` for the whole hub) | ☐ | fresh bot, unapproved shell command → expect a card; flip Approvals to bypass → expect none |
| Hub token: always required, minted on first run, **stable across restarts** (reused from `<data>/hub-token` unless `POCKETROCKET_ROTATE_TOKEN=1`) | ☑ | restart the hub, confirm an already-open tab stays authenticated |
| Account (Supabase auth): sign-in via GitHub (email off until custom SMTP), sign-out, session persists across a restart, app works fully signed out | ☐ | Settings → Account: sign in, close/reopen app, confirm still signed in; sign out; use the app signed out |
| Desktop first-run SSH scan: key auth only (never a password), against a running server, a server without SSH, an unknown host key (shown to confirm), a changed host key (refused), a key needing an agent/passphrase, and an unreachable host | ☐ | run the scan against one host in each state and confirm the reported outcome matches |
| Bot CRUD / tool-grant changes gated behind human approval (audit B6) | ☑ | attempt to widen a bot's tools, expect an approval card |
| `bashRules`/`pathRules` tightened: relative paths, interpreter flags, `isInside` AND-not-OR (audit B3–B5) | ◐ see SECURITY.md Threat model — best-effort against a cooperative model, not a hostile one | `permissions/rules.test.ts`, `permissions/pathRules.test.ts` |
| Provider children get a per-provider env allowlist instead of the hub's full `process.env` (audit B7) | ☑ | inspect `claude.ts`/`codex.ts`/`grok.ts`/`opencode/server.ts` spawn options |
| Secrets file permissions enforced on every write, not just creation (audit #17) | ☑ | `SecretsStore.test.ts` |
| VPS docs say never expose the port; SSH tunnel / Tailscale only | ☑ | `SECURITY.md`, `docs/SERVER.md` |
| Screen tab (server mode): no VNC password prompt — `x11vnc -nopw` on loopback, hub's `/screen` cookie auth is the gate | ☑ | open the Screen tab through the tunnel, confirm no password prompt; `curl` `/screen/vnc.html` without the cookie → 401 |
| CI: top-level `permissions: contents: read`, every third-party action SHA-pinned, Dependabot configured (audit #21) | ☑ | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml` |
| Screenshots/docs/fixtures redacted of the local username and SSH host alias (audit A) | ☑ | see this file's redaction grep in the audit report |
| Dependency audit | ☑ | `pnpm audit --prod` → 0 |
| Integration tokens encrypted at rest (AES-256-GCM, `vault.key` 0600) and `vault.key` left out of `backup.sh` archives (P4) | ☑ tests | `IntegrationVault.test.ts`; `tar -tzf /var/backups/pocketrocket-crew/data-*.tgz \| grep vault.key` → nothing |
| Integration write tools (send mail, post, comment, create) always show a card, also under bypass; a bot without a grant gets no integration tools (P4) | ☑ tests | `integrations/tools.test.ts` |
| Branch protection on `main` (required checks, no force-push), Dependabot alerts + security fixes | ☑ | `gh api repos/AlexGaledo/pocketrocket/branches/main/protection` |
| Secret scanning + push protection | ☐ not available on a private free-plan repo; auto-enabled when public | repo Settings → Code security |

## 3. Desktop app (Windows)

| Item | Status | How to verify |
|---|---|---|
| Installer builds locally (`pnpm desktop:build`) | ☑ release | `target/release/bundle/nsis/PocketRocket_<v>_x64-setup.exe` |
| Installer size acceptable | ☑ 29.7 MB (unused vendored Claude CLI pruned) | `PocketRocket_0.2.0_x64-setup.exe` |
| Runs with system Node ≥ 22.13 and with the bundled Node 24 sidecar | ☑ both | splash shows runtime; `hub.log` startup line |
| First run: onboarding wizard appears, provider check works, first bot created | ☑ Playwright run | fresh `%APPDATA%\com.pocketrocket.crew` |
| Legacy Claudebot data migrated on first launch | ☑ verified (config + db) | launch with old `com.claudebot.desktop` present |
| Quit kills the hub + provider children (no orphan `node`/`opencode`) | ☑ (shutdown deadlock fixed) | `tasklist` after quit |
| `hub.log` rotates (2 MB × 5) | ☑ code | fill the log |
| Help → Check for updates opens Releases; About shows version | ☑ | menu |
| Connection screen matches in-app settings, active mode indicated | ☑ (`docs/screenshots/desktop-connection.png`, checked menu items) | splash + menu check marks |
| SmartScreen warning documented (unsigned) | ☑ | README, site FAQ |
| Code signing certificate | ☐ deferred (decided) | — |
| Auto-updater | ☐ deferred (decided) | — |
| Uninstall leaves no service/task; data dir kept by default, deletable via checkbox (documented) | ☑ | No service, scheduled task or autostart entry (`grep -riE "schtasks\|autostart\|CurrentVersion.Run" packages/desktop/src-tauri/src` → nothing). The NSIS uninstaller deletes `$INSTDIR` + shortcuts, plus an opt-in "Also delete all bots, conversations and settings" checkbox (unchecked by default) that also removes `%APPDATA%\com.pocketrocket.crew\`. Data retention documented in README → Uninstalling. |
| Uninstall tested both ways: checkbox left unchecked (data dir survives) and checkbox ticked (data dir removed) | ☐ | uninstall once with the box unchecked, confirm `%APPDATA%\com.pocketrocket.crew\` still exists; reinstall, uninstall again with the box ticked, confirm it's gone |

## 4. Providers

v1 ships **Claude only**. Codex, OpenCode and Grok adapters exist in the codebase but are disabled
for this release — reachable only behind the dev-only `POCKETROCKET_PROVIDERS` flag, not exposed
in Settings or onboarding, and not part of this checklist. See CONTRIBUTING.md.

| Provider | Check detects install/login | Live DM turn | Approval card | Session resume | Cost shown | Status |
|---|---|---|---|---|---|---|
| Claude (Agent SDK) | ☑ | ☑ pong | ☑ | ☑ (cache read) | ☑ | ready |
| Codex / OpenCode / Grok | — | — | — | — | — | disabled for v1 (dev flag only) |

Model picker: Sonnet 5 (default), Opus 5, Fable 5.1, Haiku 4.5. DM a bot "Reply with exactly:
pong", then ask it to write a file outside the workspace to see an approval card.

## 5. Product / UX

| Item | Status |
|---|---|
| Sound cues: send, reply, approval, approve/deny, done, error, connected; toggle; reduced-motion respected | ☑ code + AudioContext verified, ☐ heard by a human |
| Redesigned Settings, sections **Account · Claude · Bots · Integrations · Knowledge · Devices · Appearance · About**: Claude login check, model default, API key field, Bots approvals toggle, name, sounds, theme, version. On a paired phone only Devices, read-only Appearance and About | ☐ |
| Onboarding wizard (welcome → Claude check → name → first bot → done) | ☐ retest against the Claude-only flow |
| Onboarding "Connect Claude" step retested signed in and signed out | ☐ sign out of Claude Code, run onboarding, confirm the step's error/instructions; sign in and confirm it shows the plan |
| Bot dialog model list: Sonnet 5, Opus 5, Fable 5.1, Haiku 4.5 | ☑ |
| Dark mode across app, splash, site | ☑ |
| Empty states, error toasts, interrupt button | ☑ pre-existing |
| Narrow-window layout: bot list and side panels collapse into drawers below the breakpoint | ☐ resize the window narrow, confirm panels become drawers and reopen without layout glitches |
| Accessibility pass (focus rings, labels, contrast) on new dialogs | ☑ see below |

The accessibility pass covered, and fixed:

- **Keyboard**: the provider cards are `role="radio"` on a `div` and had neither `tabIndex` nor a key
  handler, so a provider could not be chosen without a mouse — in the onboarding wizard too, which is the
  first screen a new user sees. They now use a roving tabindex with Enter/Space to select and arrows to move.
- **Focus rings**: `Button` had none at all; inputs had one but no `outline-none`, so the browser outline
  and the ring stacked. Every button, toggle chip and segmented control now shows a `focus-visible` ring.
- **Labels**: `Label` rendered a `<span>`, so no field in any dialog was programmatically labelled. A new
  `Field` wrapper mints an id that `Label` and the control share; captions over button groups render as a
  span named by `aria-labelledby` instead. API-key rows, the token prompt and the sounds switch got names.
- **State**: toggle chips report `aria-pressed`, the theme control is a named group, decorative avatars and
  emoji are `aria-hidden`, and bot avatars carry a real `aria-label` rather than a mouse-only `title`.
- **Contrast**: the light theme failed WCAG AA badly — `--dim` sat at **2.15:1** on `--card2` and `--warn`
  at 2.39:1, against a 4.5:1 requirement, and `--muted`/`--accent`/`--ok`/`--bad` were all under it too.
  Every text token in both themes is now ≥ 4.5:1 against the lowest-contrast surface it is used on. Dark
  mode needed only `--dim`. `packages/site/styles.css` mirrors the same values.

## 6. Website and repo

| Item | Status |
|---|---|
| Landing site builds/serves, dark mode, responsive, FAQ incl. SmartScreen | ☑ |
| Download button resolves latest GitHub Release (falls back to Releases page) | ☑ code, ☐ no release yet |
| Real screenshots in hero + README; OG image | ☑ |
| Site deployed to Vercel production, URL in README | ☑ https://pocketrocket-chi.vercel.app |
| README: installer-only setup walkthrough (download → SmartScreen → where it runs → Connect Claude → wizard → first chat), updating, uninstalling, troubleshooting; the rest moved to `docs/GUIDE.md`, `docs/SERVER.md`, `docs/DEVELOPMENT.md` | ☐ verify wording against the final UI |
| LICENSE (MIT), CONTRIBUTING, SECURITY, issue templates | ☑ |
| Repo public (currently private by decision) | ☐ flip when ready |
| Topics/description on GitHub, social preview image | ◐ description, homepage and 10 topics set (`gh repo view --json repositoryTopics,homepageUrl`); the social preview image can only be uploaded through repo Settings → General in a browser — use `packages/site/assets/og.png` |

## 6b. Known small issues

- Installed app inherited `mode: remote, sshHost: <host>` from the legacy config; that VPS still runs the old Claudebot build. Switch to "This PC" or redeploy with `scripts/deploy.sh <host>`.
- `pocketrocket.vercel.app` is taken by an unrelated site; production is `pocketrocket-chi.vercel.app` until a custom domain is added.

## 7. Server mode (optional path)

| Item | Status |
|---|---|
| `scripts/deploy.sh <host>` requires a host and installs as `pocketrocket-crew` (no Claudebot/stock migration; a stock PocketRocket on the same VPS is left alone) | ☑ code, ☐ run against the VPS: nobody watched the script run. On 2026-11-02 Crew was found installed at `/home/pocketrocket-crew/pocketrocket-crew` on 724677b, service up since 2026-10-31 |
| Screen service + backups renamed and running | ☐ verify after redeploy. 2026-11-02: Crew's screen service is installed but disabled because per-bot computers are on; backups not checked |
| Hub token: **always required in server mode too**, minted to `<data>/hub-token` on the VPS and stable across restarts; docs insist on tunnel-only access | ☑ |

## 7b. PocketRocket Crew phases: checks that need a VPS, a phone or a real account

Each phase's tests use fakes for these (`docs/changes/pN.md` → "Not verified" / "Known limits").

| Phase | Item | Status | How to verify |
|---|---|---|---|
| P0 | Crew and stock PocketRocket side by side on one VPS: separate users, units, ports (7790 vs 7788), screens (`:98` vs `:99`) | ◐ live 2026-11-02 on `crm-agency`: `pocketrocket` (7788) and `pocketrocket-crew` (7790) both active, separate users, all listening on loopback, stock untouched throughout. `:98` not exercised: Crew's screen service is disabled while per-bot computers are on | deploy both; `systemctl status pocketrocket-crew pocketrocket`; `ss -ltnp` shows only 127.0.0.1 |
| P1 | Per-bot computers: `pocketrocket-crew-computer@<slot>-<bot>` starts on first Browser/Desktop use, sleeps after `COMPUTER_IDLE_MIN`, at most `MAX_RUNNING_COMPUTERS` run, quota warning at 80% | ◐ live 2026-11-02. Start: two Browser bots each got their own unit, own tabs on separate CDP ports, correct answers from real turns. Sleep: an idle computer was found asleep with no unit running at 42 min idle (default 30); exact moment not observed. Cap: with `MAX_RUNNING_COMPUTERS=2`, waking a third put the idle one to sleep rather than refusing. Quota, live 2026-11-03 with a temporary 1 GB quota: badge turns amber at 88%, wake refused over 100% with the reason, and the bot says its computer tools are off. See finding 14 | two Browser bots; watch `systemctl --user list-units 'pocketrocket-crew-computer@*'` as the service user |
| P1 | Every computer port on loopback (CDP 9400+n, VNC 5800+n, noVNC 6200+n; X no TCP) | ☑ static test, ◐ on the VPS 2026-11-02: with computers awake, 58xx, 62xx and 94xx listen only on 127.0.0.1 (58xx also on [::1]); X no-TCP not checked live | `deployScripts.test.ts`; with a computer awake, `ss -ltnp` lists its 94xx/58xx/62xx ports on `127.0.0.1` only |
| P1 | Shared screen's logins move to the oldest Browser bot once; RAM sizing table holds | ◐ live 2026-11-03 with marker files, not a real profile: both folders moved to the oldest Browser bot once, `.legacy-migrated` written. RAM table not checked | first start with computers on; `docs/SERVER.md` table |
| P2 | `x11vnc -R viewonly/noviewonly` toggles a running computer, and a viewer really cannot click while the bot has control | ☑ live 2026-11-03 through the real Screen tab in Chrome: under user control clicks and keys reached the page; after Hand back a click and typing changed nothing | Screen tab: try to click while bot has control; Take over; click works |
| P2 | Claude CLI honours the PreToolUse `deny` for `mcp__browser__*` in bypass mode | ☑ live 2026-11-02, `browser_navigate` only: with control=user it was refused under approvals=ask and approvals=bypass, tab unchanged; setting restored to ask | bypass on, Take over, ask the bot to browse → refused |
| P2 | A real login through `request_takeover` (card → take over → hand back with note → bot continues) | ◐ live 2026-11-03 on a local test form: typed into the Screen tab, handed back with a note, bot continued. Parked path passed: after the 10 minute wait the card parks, and a later hand-back starts a new turn with the note. A restart loses it, finding 11. No real site login yet | spec manual test |
| P3 | Routines fire in `settings.timezone` on a UTC server; a turn cut off by `systemctl restart` resumes once | ☑ live 2026-11-03 on UTC: cron and `onceAt` in Asia/Manila fired on the minute, `onceAt` disabled itself. `systemctl restart` mid-turn: one system note, one resume, one complete reply. A routine parked on a card survived a restart and finished after allow. Stalled-handoff nudge not tested live | daily 09:00 Asia/Manila routine; restart mid-turn |
| P4 | A real OAuth round trip per provider (GitHub, Google, Slack, ClickUp, Teams); ClickUp accepts the loopback redirect; Microsoft device flow on a single-tenant app | ☐ | Settings › Integrations › Connect, Test connection |
| P4 | `vault.key` absent from backups (tar and restic) | ☑ static test, ◐ on the VPS 2026-11-03: real `backup.sh` run against a dummy tree left `vault.key` out. restic path not run. See findings 7 and 12 | `tar -tzf /var/backups/pocketrocket-crew/data-*.tgz \| grep vault.key` → nothing |
| P5 | Slack Socket Mode against a live app (connect, ack, reconnect on `disconnect`); GitHub `X-Poll-Interval` on `/repos/*/events`; ClickUp `date_updated_gt` over 100 tasks | ☐ needs real accounts. Live 2026-11-03 through test fire only: injected text ran no tool, rate limit skipped the third fire, a Bash request under approvals=bypass still raised a card | one trigger per source; Automations › Triggers shows last check and fires |
| P5 | Trigger turn resumed after a restart or a parked approval stays inside the trigger's daily budget | ☑ tests | `rooms/triggerBudget.test.ts` |
| P6 | Teach: password absent from the trace, distill to a pending skill, correction to a pending version, replay | ◐ live 2026-11-03 on one task (spec asks three): password field masked and its frame dropped, live skill unchanged until the version was approved, replay handed off for secrets and finished. Other fields leak, finding 10 | Teach on a form, Done, Distill, correct, approve, replay |
| P7 | Knowledge repo clones over ssh with a deploy key non-interactively (BatchMode) and pulls on the timer | ◐ live 2026-11-03 over `file://`: clone, pull on Sync now, bot answered from it. `ext::` refused. ssh deploy key and the timer not tested | Settings › Knowledge with a private `git@` URL; Sync now |
| P7 | A shell write into the knowledge repo is refused under bypass (and cards otherwise) | ☑ tests, ☑ live 2026-11-03: Bash write carded under ask and refused under bypass, file unchanged. Write tool under bypass not exercised (bot lacked the tool) | `permissions/knowledgeReadOnly.test.ts` |
| P8 | Auto model picks per turn; usage by model and cause | ◐ live 2026-11-03: routine and trigger on Haiku, chat on Sonnet, "think hard" on Opus; `/api/usage` returns `byModel` and `byCause`. Escalation on retry not exercised | one `auto` bot |
| P9 | Phone over Tailscale Serve with `POCKETROCKET_ALLOWED_HOSTS`: pair by QR, chat, answer a card; settings writes refused; revoke closes the phone's socket | ◐ live 2026-11-03 without a phone or Tailscale: pairing code single use; device token refused on settings, secrets, bot writes, pairing, git import and `/mcp`; revoke closed its socket in 23 ms and its next request got 401. Allowed host needs forwarded https, other hosts 403 | `tailscale serve --bg 7790`; pair an iPhone and an Android phone |
| P9 | Web Push delivered on iOS (installed PWA) and Android; payload has no content; `vapid.json` 0600 and kept in backups | ☐ push, ☑ `vapid.json` 600 on the VPS 2026-11-03 | Settings › Devices › Send a test; `stat -c %a data/vapid.json` → 600 |
| P9 | Tray and close-to-tray on Windows; Linux AppImage/deb and unsigned macOS dmg from the release workflow install and start the hub | ☐ | release workflow artifacts on each OS |

Findings from the 2026-11-02 tests (open unless stated):

1. One earlier run flagged a hand-back note as prompt injection. That run's prompt said "then stop" and its note asked for an odd word. Not reproduced in 8 normal runs. The note reaches the bot as a tool result (`agent/takeoverTool.ts:56-58`).
2. Cards and refusals name `pocketrocket-crew` because `settings.userName` is the OS user on a server that skipped onboarding (seen in `GET /api/settings`; used in `agent/takeoverTool.ts`).
3. Browser tools run with no approval card under approvals=ask. Open decision.
4. Deleting a bot removes its unit and its `data/computers` and `data/bots` folders, but leaves Playwright snapshots in `data/workspace/.playwright-mcp/`.
5. `RoutineScheduler.test.ts` "resolves a local once_at" fails since 2026-11-02, also on master. The test hardcodes `2026-11-02T09:00` (line 76), and `resolveSchedule` reads the real clock through `Cron`, not its `now` (`services/RoutineScheduler.ts:43-44`).
6. Fixed and live in 40373b2: the startup line no longer holds the token and the token was rotated. Old journal lines hold the dead token. Stock still has the leak at `packages/hub/src/hub.ts:295`.
7. `deploy/backup.sh:16-24` excludes `data/vault.key` but not `data/hub-token`, in both the tarball and restic paths, so backups hold the hub token. Confirmed by reading the script, not by opening an archive.
8. Fixed and live in 40373b2: bots run real Google Chrome with no `--test-type` or `--no-sandbox`. Stock still runs Chrome for Testing.

Findings from the 2026-11-03 tests (open):

9. **Secrets in Playwright snapshots.** After a user typed into a form on the Screen tab, the bot's page snapshot wrote `textbox "Password"` with the password and the API key in clear to `data/workspace/.playwright-mcp/page-*.yml`, mode 644. Every bot can read that folder, bot delete leaves it (finding 4), and the daily backup includes the workspace. In this run the value did not reach chat history or Claude transcripts.
10. **Recorder misses key and token fields.** `SECRET_NAME_RE` (`services/recorderPage.ts:9`) does not match `api_key` or `access_token`. Typed values landed in `trace.jsonl` in clear unless they matched a known key format, and screenshots kept the visible value. Pages with no title also leak URL query values: the `window` event (`services/Recorder.ts:444`) writes Chrome's title, which then holds the full URL, unredacted.
11. **A restart loses a parked takeover.** Control silently returned to the bot and the card became `expired`, while the system line still said the bot "will continue after that". No new turn and no notice. Parked approvals do survive.
12. **Backups are world-readable and hold the hub token.** `/var/backups/pocketrocket-crew/data-*.tgz` is mode 644 in a 755 folder and lists `data/hub-token`, so any local user on the VPS can read the token. A dummy-tree run shows `secrets.json`, `integrations.json` and `vapid.json` go in too.
13. Page URLs with secret query values appear in chat tool output through `browser_snapshot`.
14. The "% full" warning text is not shown while the computer is live (`RightPanel.tsx:714` area); only the amber badge is.
15. A bot waiting on a person shows "Waiting on a teammate" in the sidebar. A revoked device stays in the device list.

## 8. Release day

1. `pnpm version:sync X.Y.Z` → `cargo check` → update CHANGELOG → commit `Release vX.Y.Z`.
2. `git tag vX.Y.Z && git push --tags` → wait for `release.yml`.
3. Download the installer from the Release on a machine without the repo, install, run onboarding with Claude, one DM.
4. Confirm the site's download button points at the new asset.
5. Announce; watch issues.

Details in `docs/RELEASING.md`.
