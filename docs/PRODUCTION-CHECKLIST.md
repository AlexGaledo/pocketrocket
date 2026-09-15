# PocketRocket production checklist

Use before every public release. Status column: ☑ done and verified · ☐ open · ◐ partial. Updated 2026-09-16 (v0.2.0, pre-release). Security audit: `docs/AUDIT-2026-09-09.md`; remediation landed the same day (see CHANGELOG → Security). v1 scope: Claude only, approvals on by default, optional PocketRocket account — see CHANGELOG `[0.2.0]`.

## 1. Build and quality gates

| Item | Status | How to verify |
|---|---|---|
| Typecheck + Vite build clean | ☑ | `pnpm -r build` |
| Unit tests green | ☑ see CI | `pnpm test` |
| Versions in sync (root, packages, tauri.conf, Cargo.toml) | ☑ | `pnpm version:sync --check` |
| `Cargo.lock` refreshed after a version bump | ☐ per release | `cargo check` then commit |
| CI green on `main` (`ci.yml`: ubuntu tests + windows desktop:prepare + cargo check) | ☑ run 34250487822 | GitHub Actions tab |
| Release workflow produces the NSIS installer (`release.yml`) | ☐ untested on a tag | push `v0.2.0` tag, watch Actions |
| `release.yml` workflow_dispatch dry run succeeds and its installer artifact installs cleanly on a fresh Windows account | ☐ | Actions → Release → Run workflow (no tag); download `pocketrocket-windows-installer` artifact, run it on an account with no prior PocketRocket data |
| CHANGELOG has an entry for the release | ☑ `[0.2.0]` filled in | `CHANGELOG.md` |

## 2. Security

See [`docs/AUDIT-2026-09-09.md`](AUDIT-2026-09-09.md) for the full pre-release audit this section tracks (leaks, vulnerabilities, verified-OK, and the action order in its section D).

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
| No telemetry / no outbound calls except Claude, the GitHub releases page, and Supabase auth (only when signed in) | ☐ | grep for `fetch(`/`https://` in hub; SECURITY.md |
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
| Uninstall leaves no service/task; data dir kept by default, deletable via checkbox (documented) | ☑ | No service, scheduled task or autostart entry (`grep -riE "schtasks\|autostart\|CurrentVersion.Run" packages/desktop/src-tauri/src` → nothing). The NSIS uninstaller deletes `$INSTDIR` + shortcuts, plus an opt-in "Also delete all bots, conversations and settings" checkbox (unchecked by default) that also removes `%APPDATA%\com.pocketrocket.app\`. Data retention documented in README → Uninstalling. |
| Uninstall tested both ways: checkbox left unchecked (data dir survives) and checkbox ticked (data dir removed) | ☐ | uninstall once with the box unchecked, confirm `%APPDATA%\com.pocketrocket.app\` still exists; reinstall, uninstall again with the box ticked, confirm it's gone |

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
| Redesigned Settings, sections **Account · Claude · Bots · Appearance · About**: Claude login check, model default, API key field, Bots approvals toggle, name, sounds, theme, version | ☐ |
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
| `scripts/deploy.sh <host>` requires a host, migrates `/root/claudebot` → `/root/pocketrocket`, renames units | ☑ code, ☐ run against the VPS |
| Screen service + backups renamed and running | ☐ verify after redeploy |
| Hub token: **always required in server mode too**, minted to `<data>/hub-token` on the VPS and stable across restarts; docs insist on tunnel-only access | ☑ |

## 8. Release day

1. `pnpm version:sync X.Y.Z` → `cargo check` → update CHANGELOG → commit `Release vX.Y.Z`.
2. `git tag vX.Y.Z && git push --tags` → wait for `release.yml`.
3. Download the installer from the Release on a machine without the repo, install, run onboarding with Claude, one DM.
4. Confirm the site's download button points at the new asset.
5. Announce; watch issues.

Details in `docs/RELEASING.md`.
