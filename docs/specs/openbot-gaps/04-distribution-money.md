# Gap 4: Distribution and money

Status: plan, **revised after review 2026-11-17**. Owner answers in `05-owner-decisions.md` are applied (see the end) and
the required changes from `review-infra.md` and `review-backend.md` (hub parts) are folded in. Planner only; no product code
changed.
Inputs: `00-openbot-recon.md`, `docs/specs/auth-identity.md`, `docs/specs/decisions.md`, `docs/RELEASING.md`,
`docs/PRODUCTION-CHECKLIST.md`, `docs/SERVER.md`, `packages/desktop/src-tauri/*`, `.github/workflows/release.yml`,
`deploy/`, `supabase/migrations/`.

**Owner constraints (interview, 2026-11-17):**
- The distribution budget is **$0 a year for now**. Only free routes are planned here. Paid options appear only as later upgrades.
- Ship priority is steering and workflows first, then providers.
- Most of this gap is pr-infra work, so it can run beside those priorities without taking pr-backend time. The exception is multiplayer, which is deferred.

## Problem / user story

OpenBot ships a signed Windows build, a notarized macOS build, Linux, Docker, a one-line server install, native mobile
apps, multiplayer and paid hosting. PocketRocket ships an unsigned Windows NSIS installer and has no updater, so every
user must notice a new release and reinstall it by hand. It also has unsigned, unverified Linux and macOS builds, no
container or one-line server install, and one human per hub.

- *As a user*, I want to install without scary warnings and get fixes without downloading installers by hand.
- *As a self-hoster*, I want a one-command server install that I can verify.
- *As the owner*, I want to keep the option to earn money later without boxing myself in now.

## What exists today (verified)

| Area | Today | Where |
| --- | --- | --- |
| Windows installer | NSIS, `currentUser`, unsigned. A pre-install hook stops the bundled `node.exe` | `tauri.conf.json:33-34,50-59`; `nsis/hooks.nsh:11-23` |
| Updater | None. The menu item "Check for updates" opens the Releases page | `lib.rs:550,1394,1475`; `RELEASING.md:4`; checklist rows 65-66 "deferred (decided)" |
| Updater JSON | Explicitly off | `release.yml:111,210` (`uploadUpdaterJson: false`) |
| Linux / macOS | Already built by CI: AppImage + deb on `ubuntu-22.04`, and an **unsigned, ad-hoc** dmg on `macos-15` (arm64 only), uploaded into the release the Windows job creates | `release.yml:138-211`; decision Q11; checklist row 169 still ☐ (never installed and verified) |
| Deb deps | webkit2gtk-4.1, gtk3, ayatana-appindicator | `tauri.conf.json:45-49` |
| Bundled third-party code | Node sidecar (`externalBin`) and the hub's `node_modules`, **including `@anthropic-ai/claude-agent-sdk`**. Its licence is "© Anthropic PBC. All rights reserved". The vendored CLI binary is pruned | `tauri.conf.json:41-44`; `scripts/build-hub.mjs:91-128`; SDK `LICENSE.md` |
| Server install | `scripts/deploy.sh <host>` tars the local tree, then runs `deploy/setup-vps.sh` as root (Ubuntu/Debian, systemd, Xvfb/VNC/Chrome) | `docs/SERVER.md:22-26`; `deploy/setup-vps.sh:1-60` |
| Hub bind | Hardcoded loopback | `packages/hub/src/config.ts:74` (`HOST = '127.0.0.1'`) |
| Phone | PWA + Web Push + pairing over Tailscale Serve, with opt-in `POCKETROCKET_ALLOWED_HOSTS` | decision Q9; `config.ts:368-389`; `packages/web/public/manifest.json`, `sw.js` |
| Identity | `users` table with roles `owner/admin/member` (only `owner` used), owner password, sessions, audit log | `db/migrations.ts:382-414`; `repos.ts:21-31`; `auth-identity.md` phases 1-2 |
| Single human assumptions | Every human message is authored by the owner. The prompt calls the owner "its only human". Approvals are decided by `'owner'` | `RoomRouter.ts:158`; `SettingsStore.ts:189` (`ownerTag`); `PromptBuilder.ts:156,160`; `PermissionBroker.ts:304,662`; `repos.ts:532` |
| Request principal | `{kind:'hub', sessionId?, userId?}` or a device or the runner | `api/guard.ts:281-286` |
| Plans | Supabase `profiles.plan in ('free','pro')`, set server-side only, and nothing gated behind it (decision Q13) | `supabase/migrations/20260912000000_profiles.sql:8`; `AccountService.ts:36,41,296-306` |
| Licence / repo | MIT. The repo is **public** (`gh repo view`, 2026-11-17: 1 star, 0 forks; confirmed again by review-infra). Checklist line 130 still says private, which is stale | `LICENSE`; `package.json:4`; checklist line 130 |
| Contributors | Only the owner (AlexGaledo; commits as SPlinterRed and as Alexander Galedo), plus dependabot and 3 Claude-co-authored commits. 68 human PRs, all by AlexGaledo | `gh api .../contributors`, `gh pr list` |

## Verdict per sub-feature

| # | Sub-feature | Verdict | One line |
| --- | --- | --- | --- |
| a1 | Tauri auto-updater | **Go (now, $0)** | Free minisign key. GitHub Releases hosts `latest.json`. It is also the biggest SmartScreen relief: only the first install meets the warning (see below). |
| a2 | Windows code signing | **Go-with-limits** | $0 route: unsigned plus SHA-256 sums plus GitHub build attestations, and apply to SignPath Foundation. **Expect "no" unless the Agent SDK is fetched at first run** (revised after review). Azure Artifact Signing is **not available to individuals in the Philippines**. Paid OV is later. |
| b1 | Linux AppImage/deb | **Go (verify only)** | Already built. Needs a real install test, a note on AppArmor for Ubuntu 23.10+, and AppImage-only updates. |
| b2 | macOS notarized | **Later (paid)** | Notarization needs the Apple Developer Program at 99 USD a year. Keep the unsigned arm64 dmg and document the "Open Anyway" step. Intel Macs are not built. |
| c1 | One-line server installer | **Go** (L) | Install from a tagged, attested release tarball into `releases/<ver>` with a `current` symlink, keeping the data path; installs Node 24; wraps `setup-vps.sh` (revised after review). |
| c2 | Docker image | **Go-with-limits** | A headless image (no Screen, no per-bot computers, **no closed CLIs inside**; users install them into the volume) on GHCR, free for a public repo, amd64 and arm64. Linux host networking only, because the hub binds 127.0.0.1 only (`config.ts:74`). |
| c3 | Nix flake / Umbrel | **No-go (now)** | Umbrel exposes apps on the LAN behind its own auth, which conflicts with principle 1 (loopback, SSH-tunnel only). Nix has low demand and an ongoing maintenance cost. Revisit on request. |
| d | Native iOS/Android apps | **No-go (now)** | Store fees (Apple 99 USD/yr, Google Play 25 USD once), store review of a remote-shell controller, and decision Q9 already chose the PWA. Revisit only if PWA push or install limits block real users. |
| e | Multiplayer (several humans) | **Later, go-with-limits** | It builds on auth phase 3. It is **blocked on a credentials question** (gap 1): other humans directing bots spend the owner's Claude login. |
| f | Hosted servers / team seats | **No-go now; later only as "managed self-host" or bring-your-own API key** | Anthropic does not let third-party products route users' Pro/Max credentials or offer claude.ai login without approval. Multi-tenant hosting also needs isolation the hub does not have (decision Q3). |
| g | Licence | **MIT + CLA (decided)**, via cla-assistant.io, before the first outside PR | The owner is the sole copyright holder today, so relicensing *future* versions stays possible. PolyForm NC would forfeit free OSS signing and block at-work use. |

## Cost table

All prices were checked 2026-11-17. "Now" means fits the $0 budget.

| Item | Cost | Now? | Notes and source |
| --- | --- | --- | --- |
| Tauri updater signing key | $0 | Yes | `tauri signer generate`. Signing "cannot be disabled", and losing the key means no more updates to existing installs. https://v2.tauri.app/plugin/updater/ |
| GitHub Releases hosting `latest.json` | $0 | Yes | Endpoint `.../releases/latest/download/latest.json` (same page). |
| SHA-256 sums + GitHub artifact attestations | $0 | Yes | Attestations work in public repos on every plan. https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations |
| CI runners (Windows, macOS arm64, Linux x64/arm64) | $0 | Yes | Standard runners are free and unlimited for public repos. The arm64 Linux runners are GA (2025-08-07). https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/ |
| GHCR image hosting | $0 | Yes | Free for public packages. |
| SignPath Foundation (OSS signing) | $0 | Apply | The conditions are listed under *Windows signing* below. https://signpath.org/terms |
| Azure Artifact Signing (ex Trusted Signing) | $9.99/mo Basic | **Not eligible** | "Individual developers must be located in the United States or Canada." Organizations: US, CA, EU, UK, AU, NZ, JP, KR, SG, CH, NO, IL; the **Philippines is not listed**. The docs page is dated 2026-05-21 and was updated 2026-10-08. A paid Azure subscription is required. https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart , https://learn.microsoft.com/en-us/azure/artifact-signing/faq , https://azure.microsoft.com/en-us/products/artifact-signing |
| Certum Open Source Code Signing | about €69 for 1 year (set with reader; a cloud variant exists) | Later | The subject reads "Open Source Developer <name>". Certificates are capped at about 459 days from 2026-02-27. https://shop.certum.eu/open-source-code-signing.html |
| OV code signing (Sectigo or SSL.com resellers) | about $65-$226 a year, plus a token or cloud HSM fee | Later | Reseller prices are unverified with the CAs. Multi-year single certificates ended in Feb 2026. https://sslinsights.com/best-code-signing-certificate-providers/ , https://www.ssl.com/guide/esigner-pricing-for-code-signing/ |
| EV code signing | about $300-$600 a year | **Not worth it** | Microsoft: EV gives "Same as OV since 2024 — no longer instant bypass" of SmartScreen. https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation |
| Apple Developer Program (notarization) | 99 USD a year | Later | Individuals are listed under their legal name and need a card that can be charged in USD. https://developer.apple.com/support/enrollment/ |
| Google Play developer | 25 USD once | No | Only needed for native Android (sub-feature d). |
| Hosted servers (if ever) | VPS cost per customer, plus a payment provider, legal and support | No | See f. |

## Licensing options

| Option | Open source (OSI)? | Can others sell or host it? | Effect on PocketRocket | Free SignPath signing? |
| --- | --- | --- | --- | --- |
| **MIT (today)** | Yes | Yes, freely | Maximum adoption and the "free MIT tool" stance. Anyone could resell hosting. Selling hosting, support or seats ourselves is still fine. | Yes |
| **MIT + CLA** | Yes | Yes | Same as MIT, but keeps the right to relicense future versions or sell commercial licences once outside contributors arrive. A DCO alone does *not* grant relicensing. | Yes, until we actually sell a "commercial dual licence" |
| **AGPL-3.0 (+ CLA)** | Yes | Yes, but anyone who hosts it must publish their changes | Deters closed hosted clones. Some companies ban AGPL internally. Contributors' patches are AGPL. | Yes, unless we dual-license commercially |
| **Open core** (MIT core, proprietary team/hosted parts) | The core is | The core is | The usual "sell later" model. The paid parts live in a separate service or package (for example the Supabase plans, hosted control plane and seat billing). It needs no relicense of the existing code. | Yes for the MIT app, provided the signed installer ships no proprietary parts |
| **BSL 1.1** | No ("is not an Open Source license") | Only under the Additional Use Grant. It converts to a GPL-compatible licence by the Change Date, at most 4 years. https://mariadb.com/bsl11/ | Source-available. It blocks competing hosted services but loses the "open source" label. | No |
| **PolyForm Noncommercial 1.0.0** (OpenBot) | No | Noncommercial use only. Hobby, research, charities, education and government are allowed; any commercial purpose is outside the grant. There is a 32-day cure period. https://polyformproject.org/licenses/noncommercial/1.0.0 | It would bar freelancers and staff from using PocketRocket at work without a paid licence. That contradicts the current free positioning and needs licence enforcement. | No |

**Can an MIT project relicense later?** Yes, for new versions, if every copyright holder agrees, or if all contributions
came in under a CLA that grants relicensing. Copies already released under MIT (v0.2.0, v0.3.0 once tagged, and every public commit)
**stay MIT forever**, so anyone may fork the last MIT version. Today the owner is the only human author (see the table
above). The 3 Claude-co-authored commits are AI-assisted output committed by the owner, and dependabot only bumps
version numbers. Relicensing is therefore cleanly in the owner's hands **now**. That ends with the first merged outside
PR unless a CLA is in place first. This is not legal advice; a lawyer should confirm before any actual relicense.

**Recommendation:**
- Stay MIT.
- Add a short CLA through **cla-assistant.io** (free; not the archived CLA Assistant Lite action), and a line in `CONTRIBUTING.md` before accepting the first outside PR.
- If selling comes later, sell **services**, not licences: managed setup, hosting under BYO key, support and templates. That keeps the app MIT and eligible for free OSS signing.

## Technical feasibility and compatibility

### a1. Tauri updater (go). Revised after review 2026-11-17

Owner decision 05 §04 #6: **daily check at launch, ask before installing**, never during a turn or open approval.
Ships in **v0.3.0** together with everything already on `main` (05 Round 3 #1; `main` is already versioned 0.3.0 at
`package.json:5`, `Cargo.toml:3`, `tauri.conf.json:5`, and only v0.2.0 was released).

**Wiring (A1).**
- `Cargo.toml`: `tauri-plugin-updater = "=2.12.0"`. 2.13.x and 2.14.x require `tauri ^2.12`; **2.12.0 is the last version
  that accepts the locked tauri 2.11.6** (resolved by pr-infra with `cargo metadata`; adds about 30 crates). Add a
  Dependabot `ignore` for updater 2.13+, or a group that moves tauri, notification and updater together.
- `tauri.conf.json`: `plugins.updater.pubkey`; endpoint
  `https://github.com/AlexGaledo/pocketrocket/releases/latest/download/latest.json`; Windows `installMode: "passive"`
  (per-user install, `:52`, so no UAC).
- The plugin is registered in Rust only. The check is a Rust-internal call, not a `#[tauri::command]`, so there is no IPC
  surface, and no capability file (including `hub-notify.json`) gains `updater:*`. The CSP (`tauri.conf.json:29`) is
  unaffected.
- **`createUpdaterArtifacts` is not set in `tauri.conf.json`.** With it on, `cargo tauri build` fails without
  `TAURI_SIGNING_PRIVATE_KEY`, which would break every local build and the manual-dispatch dry run. Instead the **tag build
  steps only** pass `--config '{"bundle":{"createUpdaterArtifacts":true}}'`. Local builds, `pnpm desktop:build` and dry runs
  work with no key and produce no `.sig`.
- **Endpoint override for testing.** An env var (for example `POCKETROCKET_UPDATE_ENDPOINT`) replaces the endpoint, but the
  shell accepts it only when it is an `https://github.com/AlexGaledo/pocketrocket/releases/...` URL (`latest/download/` or
  `download/vX.Y.Z/`); anything else is ignored with a log line. This lets the owner point an installed build at a
  prerelease's `latest.json` without a special build. A unit test covers accept and reject.
- **CI gains `cargo test`.** `ci.yml` runs only `cargo check` today (`.github/workflows/ci.yml:76` Windows, `:118` Linux/macOS),
  so the endpoint and override tests would never run. Add a `cargo test` step after each `cargo check`.

**Release pipeline: draft, then finalize (A2).** The draft's "set `uploadUpdaterJson: true` and verify it merges" is not
safe: `tauri-action` merges `latest.json` with read-modify-delete-upload and no lock, the Linux and macOS jobs run in
parallel, and today the Windows job publishes **non-draft** (`releaseDraft: false`) before the Unix jobs build, so
`releases/latest/download/latest.json` would serve a partial file or a 404, and Tauri rejects the whole file if one
platform entry is bad.
- **Windows job:** keeps its gates; `environment: release`; `releaseDraft: true`; keeps `uploadUpdaterJson: false`; outputs
  `releaseId`; attests `*-setup.exe`.
- **Unix matrix:** `releaseId` from the Windows job; `uploadUpdaterJson: false`; same environment; macOS `--bundles app,dmg`
  if the `.app.tar.gz` and its `.sig` do not appear with `dmg` alone; attests its own bundles.
- **New `finalize` job** (`needs: [release, release-unix]`, `environment: release`): downloads the draft's assets; a new
  `scripts/updater-json.mjs` builds `latest.json` with exactly `windows-x86_64` → `-setup.exe`, `linux-x86_64` →
  `.AppImage` (**never the `.deb`**), `darwin-aarch64` → `.app.tar.gz`, plus CHANGELOG notes and `pub_date`, and **fails** if
  any entry lacks a URL or signature; writes `SHA256SUMS.txt` over every asset; attests both files; uploads them; publishes
  as a **prerelease** (which `releases/latest` ignores). The assembler is unit-tested in `pnpm test` with fixture `.sig` files.
- **Staged rollout (owner, each release):** an installed build with the endpoint override set to
  `.../releases/download/vX.Y.Z/latest.json` updates from the previous version on a clean Windows VM; then
  `gh release edit vX.Y.Z --prerelease=false --latest`.
- **First real test needs two updater builds.** v0.2.0 has no updater, so v0.3.0 cannot be updated *to* by anyone. Plan a
  **v0.3.1-rc.1 prerelease right after v0.3.0**: install v0.3.0 on the clean VM, point the override at the RC's
  `latest.json`, and update. Only then is the owner VM test real. Testing on a "test
  fork" does not work: both release jobs are gated on `github.repository == 'AlexGaledo/pocketrocket'` with owner and repo
  hardcoded.
- Attestation: `actions/attest-build-provenance` pinned to v4.2.2 (`4d101475d8b20a2381f78447822ac1eab6504dd8`);
  `id-token: write` and `attestations: write` only on the jobs that attest.

**Signing key custody.**
- Generate offline with a password (`cargo tauri signer generate`); keep key and password in the password manager plus one
  offline copy; write restore and planned-rotation steps in `RELEASING.md`.
- **Signing key in the `release` environment only**: owner as required reviewer, deployment branch/tag rule `v*` (free on a
  public repo). A GitHub environment **cannot filter by event**, only by branch or tag, so the manual-dispatch **dry-run
  steps must not reference `environment: release`**: they build without the key (and without `createUpdaterArtifacts`) and
  never publish. `TAURI_SIGNING_PRIVATE_KEY` and its password go in **step-level** `env` on the build
  steps, never job-level, so `pnpm install`, tests and postinstall scripts never see them. Rust build scripts in the same
  step still can; the full fix is signing in a separate job, which SignPath would force anyway.
- Correction: a **planned** rotation needs no reinstall (a release signed with the old key can carry the new pubkey). Only a
  **lost** key strands installs.

**Update UX in the shell (A4).**
- **The check runs in every desktop mode** (`local`, `remote`, `attach`; `lib.rs:6`, `:140`): the desktop app itself needs
  updating whatever hub it talks to. Only the hold and the busy gate depend on the mode (see below).
- Check at launch **and every 24 h while running**: P9 made close-to-tray the default in local mode (`lib.rs:62-63`), so the
  app can run for weeks.
- An automatic check never opens a modal over work. When an update is found: a system notification ("PocketRocket 0.4.1 is
  ready") and the app menu and tray item become "Install update 0.4.1…"; a third item "What's new in 0.4.1" opens the release
  page. The native dialog opens only from that item or "Check for updates" (which uses the plugin instead of
  `RELEASES_URL`, `lib.rs:550`, `:1394`, `:1475`). Two buttons: `Install and restart` / `Later`, or
  `Install when bots are idle` / `Later` while busy. **Resolved:** the locked `tauri-plugin-dialog` 2.7.3
  (`Cargo.lock`) supports custom labels through `MessageDialogButtons::OkCancelCustom`. Remember a skipped version in `config.json`. Offline is silent on the
  automatic check.
- Copy: "Installing restarts the app; running replies will stop." Do not promise "pick up where they left off" until the
  crash-loss bug (pending approvals lost on a crash) is fixed.
- **Idle-only install with a maintenance hold (local mode only).** The shell calls `POST /api/maintenance/hold {minutes}`:
  the router stops starting new turns (items stay journaled; like `freeze()` but reversible) until
  `POST /api/maintenance/release` or expiry, so a routine cannot fire between the check and the installer stopping
  `node.exe`. `minutes` is capped (for example 1-30; larger values are clamped). The hold is checked **again after a lane
  acquires its turn slot** (`RoomRouter.ts:307`, `await this.acquire()`), because a lane already waiting on the semaphore
  when the hold began would otherwise start anyway. The shell then polls `GET /api/busy` until `blocking` is 0.
- **`/api/busy` returns one `blocking` number** = running turns + live **unparked** approval cards: the only work a restart
  would lose. It also reports `pendingLanes`, `parkedCards` and `waitingRuns` **for display only**. Pending lane items are
  journaled and resume after a restart (`RoomRouter.ts:283-286` writes the journal row; `FollowUp.ts:77-115` resumes it), parked
  cards last up to 24 h (`MAX_PARK_MS`) and waiting workflow runs restart, so none of them block; otherwise one parked
  routine card would block updates for a day. The counts need getters: `BotRunner.activeTurns` (`BotRunner.ts:120`) and
  `PermissionBroker.pending` (`PermissionBroker.ts:123`) are private, so add `activeTurnCount()` and `liveCardCount()`
  and wire them into the route in `hub.ts`.
- **Auth for the three maintenance routes and `/api/busy`:** hub token (bearer) or the owner's browser session, as for
  every other route under `checkToken` (`api/guard.ts:186`). Paired devices are refused: the routes stay out of
  `DEVICE_ALLOW` (`api/guard.ts:321`).
- **Clean stop: `POST /api/maintenance/stop`** reuses `hub.shutdown()` (`hub.ts:770`, which freezes the router and closes
  providers and the database) and replies before it exits. The shell calls it, waits up to about 5 s for the child to exit,
  then **falls back to the existing hard kill** (`kill_child` at `lib.rs:1531-1538`, `kill_tree` / `taskkill /t /f` at
  `proc.rs:94-100`).
- On Windows the updater exits the app before the installer runs; the Job Object (KILL_ON_JOB_CLOSE, `proc.rs`) kills node,
  `claude.exe` and ssh, and the NSIS pre-install hook (`nsis/hooks.nsh`) is a backstop for orphaned pre-0.3 `node.exe`. No
  bundled `.node` addons, so nothing locks `$INSTDIR\hub\`. The real risk is an abrupt stop, so `on_before_exit` calls
  `/api/maintenance/stop` and falls back to the hard kill after the timeout; on macOS and Linux the app calls `restart()`
  after the same clean stop.
- **Remote mode:** a desktop update does not touch a server hub. The shell **never holds or stops a VPS hub**; it installs
  after the normal two-button question (the SSH tunnel simply reconnects). The server is updated through B2.
- **Attach mode, or a hub that answers 404** on `/api/busy` (an older hub): no hold and no busy gate; the shell **just asks
  the user** ("Bots may be working. Install and restart now?"). The splash page's calls (`/api/health`, `/api/providers/claude/check`) must stay backward compatible
  with older server hubs.
- About (A5) inside the desktop app: version plus "Updates are checked daily by the desktop app. Use the PocketRocket menu ›
  Check for updates." The webview never triggers an install; any "update ready" line would be a read-only event from Rust.

**Platforms.** Windows (NSIS) and Linux **AppImage**; `.deb` users update from the release page. macOS (unsigned, ad-hoc):
verify the replaced `.app` still launches through Gatekeeper.

**SmartScreen and Smart App Control.** The updater downloads with Rust, so the new installer carries no Mark-of-the-Web and
should not trigger SmartScreen; only the first browser download meets the warning. On Windows 11 with **Smart App Control**
on, unsigned apps without reputation are blocked with no per-app override, and the updater path does not help; only signing
does. Verify on a clean VM with SAC on and document it in the FAQ.

### a2. Windows signing at $0. Revised after review 2026-11-17

Owner decision 05 §04 #1: **unsigned + checksums + attestations now; apply to SignPath Foundation in parallel**; decide on
unbundling the Agent SDK only after SignPath answers.

1. **Unsigned + verifiable (now).** `SHA256SUMS.txt` and attestations come from the finalize job (above). A sums file from
   the same release only catches corruption; the **trust anchor is `gh attestation verify <file> -R AlexGaledo/pocketrocket`**.
   Docs and `install.sh` say so.
2. **SignPath Foundation: expect "no" unless the SDK is fetched at first run.** The terms say "The project may not contain any
   proprietary, non open-source component", with an exception only for GPL-style System Libraries. The installer bundles
   `@anthropic-ai/claude-agent-sdk` ("© Anthropic PBC. All rights reserved", `scripts/build-hub.mjs:91-103`), the only
   non-OSS component (every other prod dependency is MIT, Apache-2.0, ISC, BSD, 0BSD or Unlicense). Ask in writing anyway.
   Before applying:
   - Pin the Node sidecar's exact version and SHA-256 in the repo (`fetch-node.mjs` resolves "the newest v24 LTS" at build
     time, so builds are not "verifiable").
   - Publish the code-signing policy page with the exact phrase "Free code signing provided by SignPath.io, certificate by
     SignPath Foundation"; keep product name and version metadata consistent; MFA for all maintainers.
   - If signing happens, order matters: SignPath signs `-setup.exe` (manual approval, asynchronous), then `tauri signer sign`
     runs on the **signed** file, then `latest.json` is built, all in the finalize job. Only the outer setup.exe gets signed.
3. **If SignPath refuses (expected):** A10 fetches the SDK at first run (one dependency-free tarball, about 5 MB, checked
   against the `sha512` in `pnpm-lock.yaml`), which is the same idea as the user's own `claude.exe` today. Size L, split
   pr-infra/pr-backend, with offline-retry onboarding UX. Owner decides after the answer.
4. **Paid later:** Certum Open Source (about €69/yr) or OV. EV is not worth it.

### b. Linux and macOS. Revised after review 2026-11-17

- **Linux:** builds exist (`release.yml:138-211`). Close checklist row 169 with real installs on Ubuntu 22.04 and 24.04.
  Test the AppArmor userns restriction on 23.10+ and document the fix rather than weakening policy. Add an arm64 AppImage on
  **`ubuntu-22.04-arm`** (not 24.04-arm), so its glibc floor matches x64 (2.35). `fetch-node.mjs` **already supports**
  `aarch64-unknown-linux-gnu` (`:32`).
- **macOS:** keep unsigned (`release.yml:193-194`); macOS 15 users use System Settings › Privacy & Security › "Open Anyway";
  arm64 only; notarization (99 USD/yr, Node sidecar with JIT entitlements) is later.

### c. Server distribution. Revised after review 2026-11-17

- **Server release tarball (B1):** `pocketrocket-server-X.Y.Z.tar.gz` (hub + web build), architecture-independent (assert no
  `*.node` files), plus `install.sh` with its version baked in; both in the sums and attestation.
- **`install.sh` (B2, size L):**
  - Installs **Node 24** from the official tarball checked against `SHASUMS256.txt` (no script installs Node today;
    `SERVER.md:25` says to do it by hand).
  - Code goes to **`/home/pocketrocket/pocketrocket/releases/<ver>`** with a **`current` symlink**; data **stays at
    `/home/pocketrocket/pocketrocket/data`**. The draft's `/opt/pocketrocket/<ver>` would break shipped desktops, which read
    the token only from `/home/pocketrocket/pocketrocket/data/hub-token` (`lib.rs:236`); `pocketrocket.service`,
    `backup.sh` and `keys.sh` assume that root too. The scan still classifies the server through `unit_pocketrocket=1`
    (`scan.rs:590`).
  - Unit `ExecStart` changes from `tsx src/index.ts` to `node current/hub.mjs`; existing VPSes move from the source layout to
    the release layout; rollback flips the symlink back.
  - Playwright through `node <release>/node_modules/playwright/cli.js install chromium` (a release has no pnpm and no
    `packages/hub`; `setup-vps.sh:69-70` uses `pnpm dlx` today).
  - Runs the attestation check when `gh` is present, else the checksum with a printed warning. Never opens a port. Documented
    as download, read, then run. `deploy.sh` stays for development.
- **Docker (B3), Linux `--network host` first** (05 §04 #5):
  - **No Claude CLI and no `agy` in the image.** A public GHCR image with them would redistribute closed binaries (spec 01:
    "We don't bundle it; keep it that way"). The user installs them at first run into `$HOME` on the data volume with
    `docker exec`, then `claude login`.
  - Non-root uid, `POCKETROCKET_COMPUTERS=0`, data volume, `HEALTHCHECK` on `127.0.0.1:7788/api/health`, amd64 + arm64,
    attested.
  - Docker Desktop's opt-in host networking (4.34+) is unverified for a container's `127.0.0.1` bind; do not document it.
- **Nix / Umbrel:** no-go now.

### d. Mobile

- Keep the PWA (decision Q9).
- Two cheap improvements belong to pr-design-system: the install prompt and an offline shell. No native apps.

### e. Multiplayer (later): how it builds on `auth-identity.md`

Phase 3 of `auth-identity.md` already describes this work. Concretely:

- **Users:**
  - The `users.role` CHECK already allows `admin` and `member` (`migrations.ts:387`).
  - Add `user_invites` (hash of a one-time code, role, expiry, created_by).
  - `user_credentials` is already keyed by `user_id` (`migrations.ts:404-405`), so per-user passwords need no schema change.
  - `Repos.owner()` (`repos.ts:21-31`) stays; add `getUser(id)` and `listUsers()`.
- **Principal:** `Principal.kind:'hub'` already carries `userId?` (`guard.ts:283`).
  - Make it mandatory for cookie sessions.
  - Add a role-aware guard. The hub token stays "owner" for the desktop app and scripts.
- **Authorship:**
  - `RoomRouter.ts:158` hardcodes `authorId: this.repos.owner().id`. Pass the session's user id instead.
  - `RoomRouter.ts:60` and `botTools.ts:455,1348` call `ownerTag()` (`SettingsStore.ts:189`) for every human. Change to a per-author tag (`<name> (owner)` / `<name> (member)`) derived from `users` by id.
  - The prompt sentence "its only human" at `PromptBuilder.ts:156,160` becomes a members list with ids and roles. Keep the rule that only hub-added tags count.
- **Approvals:**
  - `decided_by` is `'owner'` at `PermissionBroker.ts:304,662` and `repos.ts:532`. Change it to a user id.
  - Training reads `decided_by='owner'` (`trainingRepo.ts:124`) and needs updating at the same time.
  - Policy per role (owner and admin answer cards; members cannot change permission levels or settings) is **principle 2 territory**, so the default must be that members cannot approve.
- **Rooms:** add human membership per room (a new `room_members` table for users). Today rooms have only bot members, capped at `MAX_ROOM_BOTS = 20` (`packages/shared/src/models.ts:2`).
- **Blocker (gap 1):** bots run on the hub's single Claude login.
  - Anthropic's limits "assume ordinary, individual usage" (https://code.claude.com/docs/en/legal-and-compliance).
  - Several humans driving one Pro/Max login is likely outside that.
  - Multiplayer should therefore require the API key or a Claude Team/Enterprise login on the hub, or be limited to "the owner plus helpers on the owner's own usage". **Decided (05 §04 #3): deferred until gap 1 settles credentials, then only on an API key or Team/Enterprise login.**

### f. Hosted servers, seats and plans (later)

- **Anthropic** (https://code.claude.com/docs/en/legal-and-compliance and https://code.claude.com/docs/en/agent-sdk/overview, read 2026-11-17):
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."
  - "developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
  - "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf."
  - The Agent SDK page says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products".
  - There is a carve-out: an end user may sign in to the *unmodified Claude Code binary* with their own subscription where a platform hosts Claude Code. The Agent SDK note is stricter.
  - **Conclusion for hosted-by-us:** bring-your-own **API key** only, under Anthropic's Commercial Terms, unless Anthropic approves something else in writing.
  - **Flag for gap 1:** the same text bears on PocketRocket's *local* use of the user's own `claude.exe` login through the Agent SDK. Gap 1 owns that analysis.
- **OpenAI:** "Sign in with ChatGPT" now has its own terms for third-party apps (https://openai.com/policies/sign-in-with-chatgpt-terms/, dated 2026-09-29 per search). Commercial access is reportedly partner-gated; this was not verified first-hand. Flag for gap 1.
- **Isolation:** decision Q3 puts all bots under one uid, and `auth-identity.md` phase 4 says no two customers on one server until computers are truly isolated. Multi-tenant hosting is therefore no-go. "**Managed self-host**" fits the principles: one VPS per customer, ideally in the customer's own cloud account, with their key and their data.
- **Plans:**
  - `profiles.plan` allows only `'free','pro'` (`profiles.sql:8`). The hub reads it with `.catch('free')` (`AccountService.ts:41`), so new plan names would not break old builds.
  - Seats would need an `organizations` and `memberships` table in Supabase (phase 4), and **nothing user-generated goes to the cloud** (principle 1): only account, plan and seat counts.
- **Payments from the Philippines:** Stripe does not onboard PH merchants. A merchant-of-record (Paddle, Lemon Squeezy) or PayPal would be needed. This was not researched in depth and is a later decision.
- **Privacy law:**
  - **PH Data Privacy Act (RA 10173):** the NPC registration duty (Circular 2022-04) applies at 250+ employees or processing of personal data for 1,000+ individuals. Sources differ on whether that means sensitive data only; verify. https://privacy.gov.ph/wp-content/uploads/2023/05/Circular-2022-04.pdf
  - **GDPR** applies to EU users of any hosted service: a DPA with customers, sub-processor list, deletion and export. `auth-identity.md` phase 4 already lists export and deletion.
  - Self-hosted MIT software has essentially no controller duty for the author. **Hosting changes that.**

## Tasks. Revised after review 2026-11-17

All tasks fit $0. Sizes: S < 1 day, M 1-3 days, L > 3 days for one agent.

### Phase A: updates and trust (now; pr-infra lane, parallel to steering and providers)

| # | Owner | Files | Change | Acceptance criteria | Verify | Size |
| --- | --- | --- | --- | --- | --- | --- |
| A0 | **owner** + pr-infra | GitHub settings, password manager, `docs/RELEASING.md` | Generate the updater key offline with a password; store key + password in the password manager and one offline copy; create the `release` environment (owner as required reviewer, `v*` tags and manual dispatch only) holding the two secrets; document restore and planned rotation | Environment exists with the reviewer rule; RELEASING has restore/rotation steps | Inspect repo settings | S |
| A1 | pr-infra | `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `src/lib.rs`, `.github/dependabot.yml`, `.github/workflows/ci.yml:76,118`, `docs/DEVELOPMENT.md` | `tauri-plugin-updater = "=2.12.0"`, Dependabot ignore (2.13+) or a tauri group, pubkey, endpoint, `installMode: "passive"`, Rust-only registration. **No `createUpdaterArtifacts` in the config file.** Endpoint override env var limited to the repo's release URLs. **`cargo test` step added to both CI desktop jobs** | `cargo check` passes; a local `cargo tauri build` works with no key; tauri stays 2.11.6; `grep -r updater capabilities/` is empty; tests assert the endpoint is https on the github.com release path and the override rejects any other URL; CI runs `cargo test` | `cargo check`, `cargo test`, CI run | S |
| A2 | pr-infra | `.github/workflows/release.yml`, new `scripts/updater-json.mjs` (+ test), `docs/RELEASING.md` | Draft release → finalize job: `environment: release` on tag runs only (**not on manual-dispatch dry-run steps**; environments cannot filter by event), `createUpdaterArtifacts` passed with `--config` in tag builds only, step-level signing key, `releaseDraft: true`, `releaseId` to the Unix matrix, no job writes `latest.json`; finalize assembles and checks `latest.json` (explicit platform → asset map), writes `SHA256SUMS.txt`, attests both, publishes as prerelease; installers attested in their build jobs (attest action pinned to v4.2.2 SHA, permissions only on attesting jobs); macOS `app,dmg` if needed. Folds in the draft's A6 | A tag yields one complete `latest.json` with the three platform keys; a missing `.sig` fails finalize; nothing is public until finalize succeeds | Tag a prerelease in the main repo; `jq` the keys; `gh attestation verify` each asset | M |
| A3 | pr-backend | `packages/hub/src/api/rest.ts`, `api/guard.ts`, `rooms/RoomRouter.ts:307`, `agent/BotRunner.ts:120`, `permissions/PermissionBroker.ts:123`, `hub.ts:770`, tests | `GET /api/busy` → `{ blocking, pendingLanes, parkedCards, waitingRuns }`, where **`blocking` = running turns + live unparked cards** and the rest is display-only. Count getters for the private `BotRunner.activeTurns` and `PermissionBroker.pending`, wired in `hub.ts`. `POST /api/maintenance/hold {minutes}` (capped) and `POST /api/maintenance/release`: router starts no new turns, items stay journaled; **hold re-checked after `acquire()`**. `POST /api/maintenance/stop` reuses `hub.shutdown()`. Auth: hub token or owner session; devices refused | A pending lane or parked card does not raise `blocking`; a running turn or live card does. 401 without token or session; a device token gets 403. A routine due during a hold waits and runs after release or expiry. A lane already waiting on the semaphore does not start during a hold. An over-cap `minutes` is clamped. `stop` exits the hub cleanly | vitest | S/M |
| A4 | pr-infra | `src/lib.rs` (`:6`, `:62-63`, `:140`, `:550`, `:1394`, `:1475`, `:1531-1538`), `src/proc.rs:94-100`, `config.json` handling, `RELEASING.md` | Check at launch and every 24 h **in all modes**; notification + "Install update X…" and "What's new in X" menu/tray items; native dialog (`OkCancelCustom`) on demand with the two-button copy; on install in **local mode**: hold → poll `/api/busy` until `blocking` is 0 → `POST /api/maintenance/stop`, wait ≤ 5 s, else hard kill → install. **Remote mode: never hold a VPS hub. Attach mode or a 404: just ask.** Skipped version remembered; offline silent | No install starts while a local turn runs or a live card is open; a remote-mode install never calls the server's maintenance routes; a tray-only user sees an update within 24 h; a hung hub is still killed | Manual on a clean VM: v0.3.0 → v0.3.1-rc.1 via the endpoint override, with and without a running turn; SAC-on run once; one remote-mode update | M |
| A5 | pr-design-system | `packages/web/src/components/settings/AboutSection.tsx:15`, `packages/desktop/ui/index.html:9-38` | Desktop-aware About copy; splash line for restart-after-update; **separate PR**: splash and site token parity (`desktop/ui/index.html` and `site/styles.css` still use the old cool palette `#f7f7f8` / `#4f7df3`) or record why not | AA; keyboard; no new motion | Visual check in both themes | S + S |
| A7 | pr-infra | `README.md`, `packages/site` FAQ, `docs/RELEASING.md`, `docs/PRODUCTION-CHECKLIST.md` | "Verify your download" (attestation first, checksum second); SmartScreen + Smart App Control FAQ; macOS 15 "Open Anyway"; AppImage on Ubuntu 23.10+; deb users update by hand; fix checklist line 130 (repo is public); add `github.com`, `objects.githubusercontent.com` and `api.telegram.org` to the outbound list | Steps work on a clean machine | Manual follow-through | S |
| A8 | pr-infra | `docs/PRODUCTION-CHECKLIST.md` row 169, `release.yml` matrix | Real installs: AppImage and deb on Ubuntu 22.04 + 24.04, dmg on macOS 15; add an `ubuntu-22.04-arm` AppImage | Hub starts and onboarding reaches "Connect Claude" on each | Row 169 flips to ☑ with notes | M |
| A9 | pr-infra + **owner** | `scripts/fetch-node.mjs`, `packages/site` (policy page), SignPath application | Pin the Node sidecar version and SHA-256; publish the policy page with SignPath's exact wording; owner enables MFA, applies and asks in writing about the bundled SDK | Written answer recorded in `docs/RELEASING.md` | — | S + calendar time |
| A10 | pr-infra + pr-backend (split) | `scripts/build-hub.mjs:91-128`, `packages/hub/src/providers/claude.ts`, onboarding | **Only if SignPath requires it and the owner agrees:** stop bundling the SDK; fetch the pinned tarball at first run into the data dir, checked against the lockfile `sha512`; offline-retry onboarding UX | Installer contains no proprietary package; fresh install works, and retries offline | Unzip and list `node_modules`; fresh install test | L |

### Phase B: server distribution (after A2; pr-infra)

| # | Owner | Files | Change | Acceptance criteria | Verify | Size |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | pr-infra | `release.yml`, `scripts/` | Release builds `pocketrocket-server-X.Y.Z.tar.gz` and `install.sh` (version baked in), both in sums and attestation; assert no `*.node` files | Tarball on a prerelease; sum and attestation verify | Download, `sha256sum -c`, `gh attestation verify` | S |
| B2 | pr-infra | new `deploy/install.sh`, `deploy/setup-vps.sh`, `deploy/pocketrocket.service`, `docs/SERVER.md` | Node 24 install (checked), `releases/<ver>` + `current` symlink, data dir unchanged, `ExecStart node current/hub.mjs`, migration from the source layout, playwright without pnpm, rollback, attestation-or-checksum check | Fresh Ubuntu 24.04 VPS up with one command; re-run upgrades; rollback works; `ss -ltn` shows only 127.0.0.1; an existing desktop still finds `data/hub-token` | Manual on a throwaway VPS; `deployScripts.test.ts` shellcheck case | L |
| B3 | pr-infra | new `deploy/Dockerfile`, `.github/workflows/docker.yml`, `docs/SERVER.md` | Headless image without Claude CLI or `agy`; non-root; `HEALTHCHECK`; GHCR amd64 + arm64, attested; docs: `--network host` on Linux, CLI install and login via `docker exec` into the volume | `curl 127.0.0.1:7788/api/health` answers on a Linux host; the image contains no `claude` or `agy` binary | Manual + CI build | M |

B4 (container-only bind override) is dropped: 05 §04 #5 chose Linux `--network host` first.

### Phase C: multiplayer (deferred by 05 §04 #3; recorded for later)

Starts only after gap 1 settles credentials, and then only on an API key or a Claude Team/Enterprise login on the hub.
Migration block **290-299** (`user_invites`, `room_members`). Before any member can post, **the strictness rule must change**:
`requiresApprovals` is `authorType !== 'user'` (`RoomRouter.ts:493`), so a member's message would run under the owner's
bypass; it must become "authored by the owner". Member steering: only into turns of threads the same person started, or
never (decide with C3).

| # | Owner | Files | Change | Size |
| --- | --- | --- | --- | --- |
| C0 | pr-backend | `rooms/RoomRouter.ts:493` | Strictness keyed on the owner, not on `authorType` | S |
| C1 | pr-backend | `db/migrations.ts` (block 290), `repos.ts`, `api/auth.ts` | `user_invites`; invite create/accept; per-user password and sessions; `listUsers` | M |
| C2 | pr-backend | `api/guard.ts:281-286`, `hub.ts` | `userId` mandatory on sessions; role guard; member route allow-list | M |
| C3 | pr-backend | `RoomRouter.ts:60,158`, `SettingsStore.ts:189`, `botTools.ts:455,1348`, `PromptBuilder.ts:156,160` | Real author ids and per-author tags; members list in the prompt | M |
| C4 | pr-backend | `PermissionBroker.ts:304,662`, `repos.ts:532`, `trainingRepo.ts:124` | `decided_by` = user id; members cannot answer cards by default | M |
| C5 | pr-design-system | `packages/web` sidebar/chat/settings | Members screen, invite dialog, author names, role badges | M |
| C6 | pr-backend | `room_members` (block 290) | Human membership per room; DM rules per human | M |

### Phase D: licence and money

| # | Owner | Files | Change | Acceptance | Size |
| --- | --- | --- | --- | --- | --- |
| D1 | pr-infra + **owner** | cla-assistant.io, a gist with the CLA text, `CONTRIBUTING.md`, branch protection on `main` | **MIT + CLA** (05 §04 #2) via **cla-assistant.io** (SAP's hosted app, free, maintained; v2.13.2 on 2026-10-13). Not `contributor-assistant/github-action` (archived). A DCO does not grant relicensing. Allowlist `dependabot[bot]`; check how `Co-Authored-By: Claude` trailers are treated; make the check required on `main` | A test PR from a non-owner account is blocked until signed; dependabot PRs pass | S |
| D2 | — | — | Selling: none now. If ever, **managed self-host** first (customer's own cloud and key, setup/support fee); no multi-tenant hosting, no seats (05 cross-cutting) | — | — |

## Order and dependencies. Revised after review 2026-11-17

1. **A0 → A1 → A2** (the most valuable $0 work; pr-infra only). **A3** (pr-backend, S/M) any time before **A4**; A4 after A2
   and A3. **A5** alongside A4. A1-A4 ship as **v0.3.0** with everything already on `main` (05 Round 3 #1); cut
   **v0.3.1-rc.1** right after so the owner can run the first real update test.
2. **A7, A8** in parallel with step 1. **A9** now (calendar time). **A10** only after SignPath answers and the owner agrees.
3. **B1 → B2**, then **B3**.
4. **D1** before the first outside PR is merged.
5. **Phase C** not scheduled.

## Risks. Revised after review 2026-11-17

- **Updater key loss or leak.** Loss strands every install; a leak plus release access enables malicious updates. Offline
  backup, `release` environment with a required reviewer, step-level secrets.
- **Partial `latest.json`.** One bad platform entry breaks updates for everyone; the finalize job's checks and the
  prerelease stage contain it.
- **Update kills a running turn.** Hold + busy gate + clean stop; the crash-loss bug for pending approvals should still be
  fixed separately.
- **SignPath likely refuses** because of the bundled SDK; A10 then adds a first-run download and a failure mode.
- **SmartScreen and Smart App Control.** Unsigned first installs warn; SAC blocks outright. Only signing fixes SAC.
- **Version skew** between an updated desktop and an older server hub; keep the splash calls backward compatible.
- **Dependabot** will propose updater 2.14 and break the build without the ignore/group rule.
- **Anthropic terms** may tighten further; hosted plans and multiplayer depend on gap 1's reading.
- **Stale docs:** checklist line 130 says private; the repo is public (A7).

## Owner decisions (answered 2026-11-17, `05-owner-decisions.md`)
1. Signing: **unsigned + checksums + attestations now; apply to SignPath in parallel**; decide on unbundling the SDK after
   SignPath answers.
2. Licence: **MIT + CLA**.
3. Multiplayer: **deferred** until gap 1 settles credentials, then only on an API key or Team/Enterprise login.
4. Selling: free now; **managed self-host** first if ever.
5. Docker: **Linux `--network host`** first.
6. Updates: **daily check at launch, ask before installing**, never during a turn or open approval.
