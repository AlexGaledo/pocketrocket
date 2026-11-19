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
| Hub binds `127.0.0.1` only | ☑ | `netstat -ano \| findstr 7788` |
| Origin check on REST + WS + `/screen/` upgrade, including `Origin: null` | ☑ tests | `curl -H "Origin: null" http://127.0.0.1:7788/api/bots` → 403 |
| Host check (DNS rebinding) | ☑ tests | `curl -H "Host: evil.example" ...` → rejected |
| Bearer token always required (audit B3/D3) — auto-generated to `<data>/hub-token` when `POCKETROCKET_TOKEN` unset, health stays open | ☑ | `/api/bots` 401 without token, `/api/health` 200 |
| `/screen/*` behind the same token (audit B2) | ☑ | `curl http://127.0.0.1:7788/screen/vnc.html` → 401 without token |
| `/screen/*` authenticated by a `/screen`-scoped httpOnly cookie, bought with a single-use ticket; no `?token=` there | ☑ tests | `curl 'http://127.0.0.1:7788/screen/vnc.html?token=<token>'` → 401; `screenTicket.test.ts` |
| Per-turn MCP token on `/mcp`; tools scoped to that turn | ☑ tests | `mcp/httpServer.test.ts` |
| Secrets file never returned by the API (`GET /api/secrets` = which keys set) | ☑ | `SecretsStore.test.ts` |
| No telemetry / no outbound calls except Claude, the GitHub releases page, Supabase auth (only when signed in), and these, each only after the user turns it on: **integration providers the user connected** (P4 tools, P5 trigger polling): `api.github.com` `github.com` (incl. device flow) · `accounts.google.com` `oauth2.googleapis.com` `openidconnect.googleapis.com` `gmail.googleapis.com` `www.googleapis.com` (Calendar, Drive) · `slack.com` (Web API, `apps.connections.open`) and **Slack Socket Mode `wss-*.slack.com`** (outbound WebSocket, P5) · `api.clickup.com` `app.clickup.com` · `login.microsoftonline.com` (incl. device flow) `graph.microsoft.com` · `api.telegram.org` (Telegram notifications: `getMe`, `sendMessage`, and a short `getUpdates` poll only while linking; content-free); **Web Push services** (P9, per subscribed phone; the hub refuses any other endpoint): `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`; **git remotes the user names** (P7): the knowledge repo URL and Skills › From git URLs | ☐ | grep for `fetch(`/`https://`/`wss://` in hub; integration hosts live only in `packages/hub/src/integrations/*` and `services/TriggerService.ts`/`SlackSocketMode.ts`; push hosts in `services/WebPush.ts` (`PUSH_HOSTS`); SECURITY.md |
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
| Integration tokens encrypted at rest (AES-256-GCM, `vault.key` 0600) and `vault.key` left out of `backup.sh` archives (P4) | ☑ tests | `IntegrationVault.test.ts`; `tar -tzf /var/backups/pocketrocket/data-*.tgz \| grep vault.key` → nothing |
| Integration write tools (send mail, post, comment, create) always show a card, also under bypass; a bot without a grant gets no integration tools (P4) | ☑ tests | `integrations/tools.test.ts` |
| Branch protection on `main` (required checks, no force-push), Dependabot alerts + security fixes | ☑ | `gh api repos/AlexGaledo/pocketrocket/branches/main/protection` |
| Secret scanning + push protection | ☐ not available on a private free-plan repo; auto-enabled when public | repo Settings → Code security |

## 3. Desktop app (Windows)

| Item | Status | How to verify |
|---|---|---|
| Installer builds locally (`pnpm desktop:build`) | ☑ release | `target/release/bundle/nsis/PocketRocket_<v>_x64-setup.exe` |
| Installer size acceptable | ☑ 29.7 MB (unused vendored Claude CLI pruned) | `PocketRocket_0.2.0_x64-setup.exe` |
| Runs with system Node ≥ 22.13 and with the bundled Node 24 sidecar | ☑ both | splash shows runtime; `hub.log` startup line |
| First run: onboarding wizard appears, provider check works, first bot created | ☑ Playwright run | fresh `%APPDATA%\com.pocketrocket.app` |
| Legacy Claudebot data migrated on first launch | ☑ verified (config + db) | launch with old `com.claudebot.desktop` present |
| Quit kills the hub + provider children (no orphan `node`/`opencode`) | ☑ (shutdown deadlock fixed) | `tasklist` after quit |
| `hub.log` rotates (2 MB × 5) | ☑ code | fill the log |
| Help → Check for updates opens Releases; About shows version | ☑ | menu |
| Connection screen matches in-app settings, active mode indicated | ☑ (`docs/screenshots/desktop-connection.png`, checked menu items) | splash + menu check marks |
| SmartScreen warning documented (unsigned) | ☑ | README, site FAQ |
| Code signing certificate | ☐ deferred (decided) | — |
| Auto-updater | ☐ deferred (decided) | — |
| CSP on the bundled pages (splash `index.html`, Server terminal `terminal.html`): `csp` in `tauri.conf.json`, no `unsafe-eval`, no inline script (page scripts live in `ui/splash.js` and `ui/terminal.js`), `connect-src` only Tauri IPC | ☐ written 2026-11, not yet run in the app | build the installer, open the splash (connect, scan, save a connection) and the Server terminal (type, paste, resize, Reconnect); devtools console shows no `Refused to ...` lines. The directive-by-directive reasoning is in [DEVELOPMENT.md](DEVELOPMENT.md#content-security-policy) |
| CSP on the hub's own web UI (the main window after the splash, and the phone PWA): the hub must send it as a header, since the Tauri `csp` does not apply to a page loaded from `http://127.0.0.1` | ☐ open, hand-off to the hub (nothing sends it today) | `curl -sI http://127.0.0.1:7788/` shows `content-security-policy`; click through chat, Files preview (image, PDF, audio, video, SVG), Screen tab, Settings in the app and look for CSP violations |
| Capability review: every file in `capabilities/` grants the least it needs. `default.json` (main) and `terminal.json` (terminal) hold `core:default` for the bundled pages only; `hub-notify.json` gives the hub origin `http://127.0.0.1:*` the two notification commands and nothing else (no `core:*`, no app commands) | ☐ | read `capabilities/*.json`; from devtools on the hub page `__TAURI__.core.invoke('get_config')` and `invoke('plugin:dialog|message', ...)` are both refused; any new capability or `remote` URL needs a reviewer |
| Desktop notifications (U7): the hub page can raise a local OS notification, only while the app window is unfocused, content-free ("A bot needs you"), never in a plain browser | ☐ plugin and `web/src/lib/notify.ts` added, not yet called from anywhere | with a build that calls `notify()`: unfocus or minimize the window and trigger it, expect one toast; focused window, expect none; same page in Chrome, expect none and no console error; Windows Focus Assist and "notifications off for PocketRocket" are respected |
| Bot pop-out (U1): the pop-out button opens `bot-<id>` windows, built in Rust from `window.open` (`on_new_window`), loading only the hub origin; the new window gets only the two notification commands via `hub-notify.json` (`windows: ["main","bot-*"]`), no new commands | ☐ `cargo check` and web tests pass, not run in the app | click pop-out on a bot, expect a small window with that chat; open the same bot twice, expect the existing window focused; devtools `__TAURI__.core.invoke('get_config')` refused; closing the pop-out never hides the app to tray |
| Uninstall leaves no service/task; data dir kept by default, deletable via checkbox (documented) | ☑ | No service, scheduled task or autostart entry (`grep -riE "schtasks\|autostart\|CurrentVersion.Run" packages/desktop/src-tauri/src` → nothing). The NSIS uninstaller deletes `$INSTDIR` + shortcuts, plus an opt-in "Also delete all bots, conversations and settings" checkbox (unchecked by default) that also removes `%APPDATA%\com.pocketrocket.app\`. Data retention documented in README → Uninstalling. |
| Uninstall tested both ways: checkbox left unchecked (data dir survives) and checkbox ticked (data dir removed) | ☐ | uninstall once with the box unchecked, confirm `%APPDATA%\com.pocketrocket.app\` still exists; reinstall, uninstall again with the box ticked, confirm it's gone |

## 4. Providers

v1 ships **Claude only**. Codex, OpenCode and Grok adapters exist in the codebase but are disabled
for this release — reachable only behind the dev-only `POCKETROCKET_PROVIDERS` flag, not exposed
in Settings or onboarding, and not part of this checklist. See CONTRIBUTING.md.

| Provider | Check detects install/login | Live DM turn | Approval card | Session resume | Cost shown | Status |
|---|---|---|---|---|---|---|
| Claude (Agent SDK) | ☑ | ☑ pong | ☑ | ☑ (cache read) | ☑ | ready |
| Gemini (`agy acp` 1.5.12, API key, VPS) | ☑ apiKey / gemini-api-key | ☑ | partial: shell asks, file writes do not (strict turns run read-only) | ☑ (`session/resume`) | ☑ tokens, $0 (agy reports no cost) | opt-in (`POCKETROCKET_PROVIDERS`), `untested`, best-effort permissions |
| Codex / OpenCode / Grok | — | — | — | — | — | disabled for v1 (dev flag only) |

Model picker: Sonnet 5 (default), Opus 5, Fable 5.1, Haiku 4.5. DM a bot "Reply with exactly:
pong", then ask it to write a file outside the workspace to see an approval card.

### 4a. Gemini live test (v0.5.0, spec 01 task P2-4). Owner, then pr-backend

Gemini (`agy acp`, Google's Antigravity CLI) is in the code as `maturity: 'untested'` and opt-in only. Live-tested
2026-11-19 on the VPS (Linux) with `agy` 1.5.12 at `/home/pocketrocket/.local/bin/agy`, a Gemini API key in Secrets and
`~/.gemini/antigravity-cli/settings.json` `{"modelProvider":"gemini"}`. It stays `untested` and off by default: `agy`
does not ask before its own file writes (G6), the Google sign-in was not tried (G12) and no real limit was captured
(G11). Strict turns (routines, triggers, workflow steps, a failover backup) on Gemini therefore run in `agy`'s `plan`
mode, or are refused when that mode is missing (see G6).

Setup: install `agy` from https://antigravity.google (PocketRocket never downloads it), run `agy` once in a terminal and
sign in with the Google AI account, then start the hub with `POCKETROCKET_PROVIDERS=gemini` and `POCKETROCKET_DEBUG=1`.
Create a bot and set its provider to `gemini` (`PATCH /api/bots/:id {"provider":"gemini"}` until the picker ships).

| # | Check | Status | How |
|---|---|---|---|
| G1 | Detection: Settings › Providers › Gemini (or `POST /api/providers/gemini/check`) finds `agy`, shows its version and `exePath`. Record the install folder on PC and VPS so it can join the lookup after `AGY_EXE` | ☑ | found `agy` 1.5.12 on the VPS at `/home/pocketrocket/.local/bin/agy`. On Windows the official installer (`irm https://antigravity.google/cli/install.ps1 | iex`) puts it at `%LOCALAPPDATA%\agy\bin\agy.exe` (1.5.12, recorded 2026-11-19). Neither folder is in the built-in lookup yet (only `AGY_EXE` and PATH) |
| G2 | Reported auth: what `check()` returns as `auth` / `authMethod` on the Google login and on an API key. If both say `unknown`, find where `agy` reports its auth (its `initialize` `_meta`, a status command) and send it to pr-backend for `parseGeminiAuth` | ☑ | after #179: `auth: apiKey`, `authMethod: gemini-api-key`. `agy` reports no method in use; `initialize` lists `authMethods` oauth-personal, oauth-business, gemini-api-key, agent-platform; `agentCapabilities.loadSession`; session resume/close/load/list/additionalDirectories; `_meta.antigravity {tier, systemPrompt.append}`. The hub infers apiKey from the key in the spawn env plus `modelProvider: "gemini"` |
| G3 | API-key variable: does `agy` read `GEMINI_API_KEY`? Set it in Settings › Secrets, sign out of Google, run a DM turn | ☑ | `agy` reads `GEMINI_API_KEY`, but only with `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` |
| G4 | DM turn: "Reply with exactly: pong" gets `pong`; a second message resumes the session (check `session/resume` or `session/load` in the debug log) | ☑ | DM answered; the next message resumed the session; context size reported (window 1,048,576) |
| G5 | Hand-off: in a group, the Gemini bot hands off to a Claude bot with `@` or the hand-off tool; the hub tools reach it (HTTP MCP, or the stdio bridge if `agy` lacks `mcpCapabilities.http`; note which) | ☑ | the Gemini bot called `mcp_pocketrocket_handoff` and the Claude bot answered (HTTP MCP). A hand-off-only turn wrote no usage row; fixed in the G13 PR (a run that called a tool is accounted) |
| G6 | **Does `agy` ask before writes and shell?** Ask it to write a file outside the workspace and to run `rm` on a temp file: an approval card must appear. Note which ACP `kind` and `locations` it sends | partial | shell asks: kind `execute`, card tool `acp:execute:run_command`, `rawInput.CommandLine`; deny ends the turn in <1 s, no `agy` left. **File writes do not ask**: `write_file` to `/tmp/g6-probe.txt` (outside the workspace) ran with no `session/request_permission`, in `agy`'s `default` mode, approvals on `ask`. So Gemini stays `best-effort`, and strict turns run read-only: `plan` mode before the prompt, refused if `agy` offers no `plan` or refuses the switch, stopped if it announces an edit/delete/move/switch_mode call or leaves `plan`. Still to check live: that `agy` in `plan` refuses `write_file` |
| G7 | Modes: which modes or `mode` config options `agy` lists; on a routine with an API key, the strict turn switched to the asking mode (debug log `session/set_mode`) | ☑ | modes `default` ("Ask before edits and commands, per your permission settings"), `accept-edits`, `plan`. Strict turns now pick `plan` (not `default`, which lets writes through) |
| G8 | Models: which `model` config option values `agy` offers; replace `GEMINI_MODELS` with them | ☑ | `model` values: gemini-4-neon, gemini-4-carbon, gemini-4-hydrogen, gemini-4-argon, gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro (current). `models.availableModels` adds effort variants (`-low`/`-high`, `-xhigh`), not offered. `GEMINI_MODELS` replaced; old ids read as gemini-3.1-pro / gemini-3.8-flash |
| G9 | Interrupt: Stop during a long answer ends the turn as stopped within a few seconds, and no `agy` process is left (Task Manager / `ps`) | ☑ | Stop ended the turn in ~0.2 s, no `agy` left |
| G10 | Unattended guard: on the Google login a routine posts "did not run: Gemini on a Google sign-in…" and does not run; Run now on the same routine runs; with the API key the routine runs and still cards | ☑ | after #179: a scheduled one-shot routine ran on the API key; usage row provider=gemini, model=gemini-3.1-pro, tokens recorded, cost $0. Google-login refusal not tried (no Google login on the VPS) |
| G11 | Limit fixture: when a Gemini limit is hit, save the JSON-RPC error and any `notice` update from the debug log as `providers/__fixtures__/gemini/limit-quota.agy.json`; the note must read as a limit with a reset time, not the raw text | ☐ | no real limit hit yet; `geminiLimit` still matches the synthetic fixture |
| G12 | Where `agy` stores its login on the PC and on the VPS (and whether the VPS needs a keyring or a device-code login). Recommend the API key on the VPS | ☑ | API key is the working path on the VPS. Google sign-in tried on the owner's Windows PC 2026-11-19 (agy 1.5.12): `agy` opens the browser, the login lands in Windows Credential Manager (`gemini:antigravity`) and also in a plain file `~\.gemini\oauth_creds.json`, so that file's ACL matters. After it, ACP `session/new` succeeds with `_meta.antigravity.tier` = "Antigravity Starter Quota" (`g1-plus-tier`) and default model `gemini-3.8-flash-high`; no `modelProvider` setting, so the hub treats it as the Google sign-in (unattended turns stay refused). The tier in `session/new` `_meta` could label the auth instead of `unknown` (cosmetic). Google sign-in on the headless VPS not tried |
| G13 | Record the tested `agy` version in `AGY_TESTED`, set `GEMINI_INFO.maturity = 'verified'` and `testedVersions`, and add Gemini to the default enabled list | partial | `AGY_TESTED` = 1.5.12, `testedVersions: '1.5.12'`, `GEMINI_MODELS` from G8. Kept `untested` and opt-in (not in the default enabled list) because of G6, G11, G12. Flip to `verified` after: `plan` refuses writes live, a Google sign-in run, a captured limit |

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
| `scripts/deploy.sh <host>` requires a host and installs as `pocketrocket` | ☑ code, ☐ run against the VPS: nobody watched the script run. On 2026-11-02 Crew was found installed at `/home/pocketrocket/pocketrocket` on 724677b, service up since 2026-10-31 |
| Screen service + backups renamed and running | ☐ verify after redeploy. 2026-11-02: the screen service is installed but disabled because per-bot computers are on; backups not checked |
| Hub token: **always required in server mode too**, minted to `<data>/hub-token` on the VPS and stable across restarts; docs insist on tunnel-only access | ☑ |

## 7b. PocketRocket phases: checks that need a VPS, a phone or a real account

Each phase's tests use fakes for these (`docs/changes/pN.md` → "Not verified" / "Known limits").

| Phase | Item | Status | How to verify |
|---|---|---|---|
| P1 | Per-bot computers: `pocketrocket-computer@<slot>-<bot>` starts on first Browser/Desktop use, sleeps after `COMPUTER_IDLE_MIN`, at most `MAX_RUNNING_COMPUTERS` run, quota warning at 80% | ◐ live 2026-11-02. Start: two Browser bots each got their own unit, own tabs on separate CDP ports, correct answers from real turns. Sleep: an idle computer was found asleep with no unit running at 42 min idle (default 30); exact moment not observed. Cap: with `MAX_RUNNING_COMPUTERS=2`, waking a third put the idle one to sleep rather than refusing. Quota, live 2026-11-03 with a temporary 1 GB quota: badge turns amber at 88%, wake refused over 100% with the reason, and the bot says its computer tools are off. See finding 14 | two Browser bots; watch `systemctl --user list-units 'pocketrocket-computer@*'` as the service user |
| P1 | Every computer port on loopback (CDP 9400+n, VNC 5800+n, noVNC 6200+n; X no TCP) | ☑ static test, ◐ on the VPS 2026-11-02: with computers awake, 58xx, 62xx and 94xx listen only on 127.0.0.1 (58xx also on [::1]); X no-TCP not checked live | `deployScripts.test.ts`; with a computer awake, `ss -ltnp` lists its 94xx/58xx/62xx ports on `127.0.0.1` only |
| P1 | Shared screen's logins move to the oldest Browser bot once; RAM sizing table holds | ◐ live 2026-11-03 with marker files, not a real profile: both folders moved to the oldest Browser bot once, `.legacy-migrated` written. RAM table not checked | first start with computers on; `docs/SERVER.md` table |
| P2 | `x11vnc -R viewonly/noviewonly` toggles a running computer, and a viewer really cannot click while the bot has control | ☑ live 2026-11-03 through the real Screen tab in Chrome: under user control clicks and keys reached the page; after Hand back a click and typing changed nothing | Screen tab: try to click while bot has control; Take over; click works |
| P2 | Claude CLI honours the PreToolUse `deny` for `mcp__browser__*` in bypass mode | ☑ live 2026-11-02, `browser_navigate` only: with control=user it was refused under approvals=ask and approvals=bypass, tab unchanged; setting restored to ask | bypass on, Take over, ask the bot to browse → refused |
| P2 | A real login through `request_takeover` (card → take over → hand back with note → bot continues) | ◐ live 2026-11-03 on a local test form: typed into the Screen tab, handed back with a note, bot continued. Parked path passed: after the 10 minute wait the card parks, and a later hand-back starts a new turn with the note. It also survives a restart, finding 11. No real site login yet | spec manual test |
| P3 | Routines fire in `settings.timezone` on a UTC server; a turn cut off by `systemctl restart` resumes once | ☑ live 2026-11-03 on UTC: cron and `onceAt` in Asia/Manila fired on the minute, `onceAt` disabled itself. `systemctl restart` mid-turn: one system note, one resume, one complete reply. A routine parked on a card survived a restart and finished after allow. Stalled-handoff nudge not tested live | daily 09:00 Asia/Manila routine; restart mid-turn |
| P4 | A real OAuth round trip per provider (GitHub, Google, Slack, ClickUp, Teams); ClickUp accepts the loopback redirect; Microsoft device flow on a single-tenant app | ☐ | Settings › Integrations › Connect, Test connection |
| P4 | `vault.key` absent from backups (tar and restic) | ☑ static test, ◐ on the VPS 2026-11-03: real `backup.sh` run against a dummy tree left `vault.key` out. restic path not run. See findings 7 and 12 | `tar -tzf /var/backups/pocketrocket/data-*.tgz \| grep vault.key` → nothing |
| P5 | Slack Socket Mode against a live app (connect, ack, reconnect on `disconnect`); GitHub `X-Poll-Interval` on `/repos/*/events`; ClickUp `date_updated_gt` over 100 tasks | ☐ needs real accounts. Live 2026-11-03 through test fire only: injected text ran no tool, rate limit skipped the third fire, a Bash request under approvals=bypass still raised a card | one trigger per source; Automations › Triggers shows last check and fires |
| P5 | Trigger turn resumed after a restart or a parked approval stays inside the trigger's daily budget | ☑ tests | `rooms/triggerBudget.test.ts` |
| P6 | Teach: password absent from the trace, distill to a pending skill, correction to a pending version, replay | ◐ live 2026-11-03 on one task (spec asks three): password field masked and its frame dropped, live skill unchanged until the version was approved, replay handed off for secrets and finished. Other fields leak, finding 10 | Teach on a form, Done, Distill, correct, approve, replay |
| P7 | Knowledge repo clones over ssh with a deploy key non-interactively (BatchMode) and pulls on the timer | ◐ live 2026-11-03 over `file://`: clone, pull on Sync now, bot answered from it. `ext::` refused. ssh deploy key and the timer not tested | Settings › Knowledge with a private `git@` URL; Sync now |
| P7 | A shell write into the knowledge repo is refused under bypass (and cards otherwise) | ☑ tests, ☑ live 2026-11-03: Bash write carded under ask and refused under bypass, file unchanged. Write tool under bypass not exercised (bot lacked the tool) | `permissions/knowledgeReadOnly.test.ts` |
| P8 | Auto model picks per turn; usage by model and cause | ◐ live 2026-11-03: routine and trigger on Haiku, chat on Sonnet, "think hard" on Opus; `/api/usage` returns `byModel` and `byCause`. Escalation on retry not exercised | one `auto` bot |
| P9 | Phone over Tailscale Serve with `POCKETROCKET_ALLOWED_HOSTS`: pair by QR, chat, answer a card; settings writes refused; revoke closes the phone's socket | ◐ live 2026-11-03 without a phone or Tailscale: pairing code single use; device token refused on settings, secrets, bot writes, pairing, git import and `/mcp`; revoke closed its socket in 23 ms and its next request got 401. Allowed host needs forwarded https, other hosts 403 | `tailscale serve --bg 7788`; pair an iPhone and an Android phone |
| P9 | Web Push delivered on iOS (installed PWA) and Android; payload has no content; `vapid.json` 0600 and kept in backups | ☐ push, ☑ `vapid.json` 600 on the VPS 2026-11-03 | Settings › Devices › Send a test; `stat -c %a data/vapid.json` → 600 |
| P9 | Tray and close-to-tray on Windows; Linux AppImage/deb and unsigned macOS dmg from the release workflow install and start the hub | ☐ | release workflow artifacts on each OS |

Findings from the 2026-11-02 tests (open unless stated):

1. One earlier run flagged a hand-back note as prompt injection. That run's prompt said "then stop" and its note asked for an odd word. Not reproduced in 8 normal runs. The note reaches the bot as a tool result (`agent/takeoverTool.ts:56-58`).
2. Cards and refusals name `pocketrocket` because `settings.userName` is the OS user on a server that skipped onboarding (seen in `GET /api/settings`; used in `agent/takeoverTool.ts`).
3. Browser tools run with no approval card under approvals=ask. Open decision.
4. Fixed and live in 22e9ec0: Playwright output now lives in the bot's home, so deleting the bot removes it. Claude session transcripts in the service user's `~/.claude/projects` still outlive the bot.
5. `RoutineScheduler.test.ts` "resolves a local once_at" fails since 2026-11-02, also on master. The test hardcodes `2026-11-02T09:00` (line 76), and `resolveSchedule` reads the real clock through `Cron`, not its `now` (`services/RoutineScheduler.ts:43-44`).
6. Fixed and live in 40373b2: the startup line no longer holds the token and the token was rotated. Old journal lines hold the dead token. Stock still has the leak at `packages/hub/src/hub.ts:295`.
7. Fixed and live in 22e9ec0: `data/hub-token` is left out of the tarball and restic paths. A real run on the VPS: 0 matches in the archive.
8. Fixed and live in 40373b2: bots run real Google Chrome with no `--test-type` or `--no-sandbox`. Stock still runs Chrome for Testing.

Findings from the 2026-11-03 tests (open):

9. Fixed and live in 22e9ec0: a patch to `playwright-core` leaves `type=password` values out of snapshots (live: not in chat, not on disk), and output moved to the bot's home. **Still open:** a key typed into an ordinary visible text field does appear in the snapshot and so reaches the model and its Claude transcript, like anything else on the page. The patch is tied to this `playwright-core` version; `deployScripts.test.ts` fails if an upgrade drops it.
10. Fixed and live in 22e9ec0: key and token fields are secret by name, id, label or placeholder; pages whose URL holds a credential keep no frames; window titles are scrubbed. Live: 0 secrets in the trace, 0 frames kept.
11. Fixed and live in 22e9ec0: a parked takeover is restored from its card. Live: control stayed with the user over `systemctl restart`, and a hand-back started a new turn with the note. Clicking through the viewer right after a restart not re-checked. A takeover still waiting inside its turn expires on restart; that turn resumes and can ask again.
12. Fixed and live in 22e9ec0: archives 600 and the folder 700, older archives included (`sudo -u nobody` refused). Archives still hold `secrets.json`, `integrations.json` and `vapid.json`, readable by root only.
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
