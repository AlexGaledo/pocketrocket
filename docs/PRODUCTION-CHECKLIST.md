# PocketRocket production checklist

Use before every public release. Status column: ☑ done and verified · ☐ open · ◐ partial. Updated 2026-09-08 (v0.1.0, pre-release).

## 1. Build and quality gates

| Item | Status | How to verify |
|---|---|---|
| Typecheck + Vite build clean | ☑ | `pnpm -r build` |
| Unit tests green | ☑ 152 | `pnpm test` |
| Versions in sync (root, packages, tauri.conf, Cargo.toml) | ☑ | `pnpm version:sync --check` |
| `Cargo.lock` refreshed after a version bump | ☐ per release | `cargo check` then commit |
| CI green on `main` (`ci.yml`: ubuntu tests + windows desktop:prepare + cargo check) | ☑ run 34250487822 | GitHub Actions tab |
| Release workflow produces the NSIS installer (`release.yml`) | ☐ untested on a tag | push `v0.1.0` tag, watch Actions |
| CHANGELOG has an entry for the release | ◐ Unreleased filled | `CHANGELOG.md` |

## 2. Security

| Item | Status | How to verify |
|---|---|---|
| Hub binds `127.0.0.1` only | ☑ | `netstat -ano \| findstr 7788` |
| Origin check on REST + WS + `/screen/` upgrade | ☑ tests | `curl -H "Origin: http://evil.example" http://127.0.0.1:7788/api/bots` → 403 |
| Host check (DNS rebinding) | ☑ tests | `curl -H "Host: evil.example" ...` → rejected |
| Bearer token required in desktop mode (`POCKETROCKET_TOKEN`), health stays open | ☑ | `/api/bots` 401 without token, `/api/health` 200 |
| Per-turn MCP token on `/mcp`; tools scoped to that turn | ☑ tests | `mcp/httpServer.test.ts` |
| Secrets file never returned by the API (`GET /api/secrets` = which keys set) | ☑ | `SecretsStore.test.ts` |
| No telemetry / no outbound calls except the chosen provider and GitHub releases page | ☑ | grep for `fetch(`/`https://` in hub |
| Approval cards for out-of-workspace/dangerous ops: Claude full, OpenCode via permission API, Codex/Grok via `request_approval` | ◐ Claude + OpenCode live-verified; Codex/Grok fixtures only | README "Permissions by provider" |
| VPS docs say never expose the port; SSH tunnel / Tailscale only | ☑ | `SECURITY.md`, README |
| Dependency audit | ☐ | `pnpm audit --prod` |
| Secret scanning + branch protection on GitHub | ☐ | repo Settings → Code security; protect `main` |

## 3. Desktop app (Windows)

| Item | Status | How to verify |
|---|---|---|
| Installer builds locally (`pnpm desktop:build`) | ☑ release | `target/release/bundle/nsis/PocketRocket_<v>_x64-setup.exe` |
| Installer size acceptable | ☑ 29.7 MB (unused vendored Claude CLI pruned) | `PocketRocket_0.1.0_x64-setup.exe` |
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
| Uninstall leaves no service/task; data dir kept (documented) | ☐ | Apps & features → uninstall, inspect `%LOCALAPPDATA%` |

## 4. Providers

| Provider | Check detects install/login | Live DM turn | Approval card | Session resume | Cost shown | Status |
|---|---|---|---|---|---|---|
| Claude (Agent SDK) | ☑ | ☑ pong | ☑ | ☑ (cache read) | ☑ | ready |
| OpenCode (serve + SDK) | ☑ | ☑ pong (free model; paid path untested, Zen account has no payment method) | ☑ real permission ask | ☑ | ☑ from OpenCode | ready |
| Codex (CLI) | ☑ fake CLI | ☐ needs `codex login` | ☐ | ☐ | ☑ estimate | **needs Alex** |
| Grok (Grok Build CLI) | ☑ fake CLI | ☐ needs `grok login` or `XAI_API_KEY` | ☐ | ☐ | ☑ estimate | **needs Alex** |

Manual steps for the two open rows:

```powershell
# Codex
npm i -g @openai/codex
codex login            # or: codex login --with-api-key
codex exec --json --skip-git-repo-check -c mcp_servers.demo.url="http://127.0.0.1:9/mcp" - <<< "say hi"   # proves -c MCP injection is accepted
# Grok
irm https://x.ai/cli/install.ps1 | iex
grok login             # or paste an XAI_API_KEY from console.x.ai into Settings
```
Then Settings → provider → DM a bot "Reply with exactly: pong", then ask it to write a file on the Desktop to see an approval card.

## 5. Product / UX

| Item | Status |
|---|---|
| Sound cues: send, reply, approval, approve/deny, done, error, connected; toggle; reduced-motion respected | ☑ code + AudioContext verified, ☐ heard by a human |
| Settings dialog: provider cards with live check, default model, API keys, name, sounds, theme | ☑ |
| Onboarding wizard (welcome → provider → name → first bot → done) | ☑ live (Playwright) |
| Bot dialog model list follows the active provider | ☑ |
| Dark mode across app, splash, site | ☑ |
| Provider switch resets invalid bot models with a visible system message | ☑ tests |
| Empty states, error toasts, interrupt button | ☑ pre-existing |
| Accessibility pass (focus rings, labels, contrast) on new dialogs | ◐ |

## 6. Website and repo

| Item | Status |
|---|---|
| Landing site builds/serves, dark mode, responsive, FAQ incl. SmartScreen | ☑ |
| Download button resolves latest GitHub Release (falls back to Releases page) | ☑ code, ☐ no release yet |
| Real screenshots in hero + README; OG image | ☑ |
| Site deployed to Vercel production, URL in README | ☑ https://pocketrocket-chi.vercel.app |
| README: install, providers table, permissions, server mode, development | ☑ |
| LICENSE (MIT), CONTRIBUTING, SECURITY, issue templates | ☑ |
| Repo public (currently private by decision) | ☐ flip when ready |
| Topics/description on GitHub, social preview image | ☐ |

## 6b. Known small issues

- Switching provider from a cold model cache does not reset bot models until the background refresh lands; harmless at turn time (`resolveModelId` maps it), but Settings may briefly show a foreign model.
- Installed app inherited `mode: remote, sshHost: crm-agency` from the legacy config; that VPS still runs the old Claudebot build. Switch to "This PC" or redeploy with `scripts/deploy.sh crm-agency`.
- `pocketrocket.vercel.app` is taken by an unrelated site; production is `pocketrocket-chi.vercel.app` until a custom domain is added.

## 7. Server mode (optional path)

| Item | Status |
|---|---|
| `scripts/deploy.sh <host>` requires a host, migrates `/root/claudebot` → `/root/pocketrocket`, renames units | ☑ code, ☐ run against the VPS |
| Screen service + backups renamed and running | ☐ verify after redeploy |
| Hub token: server mode has none by design; docs insist on tunnel-only access | ☑ |

## 8. Release day

1. `pnpm version:sync X.Y.Z` → `cargo check` → update CHANGELOG → commit `Release vX.Y.Z`.
2. `git tag vX.Y.Z && git push --tags` → wait for `release.yml`.
3. Download the installer from the Release on a machine without the repo, install, run onboarding with Claude, one DM.
4. Confirm the site's download button points at the new asset.
5. Announce; watch issues.

Details in `docs/RELEASING.md`.
