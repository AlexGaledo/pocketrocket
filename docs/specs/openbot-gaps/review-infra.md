# OpenBot gaps: infra review (pr-infra, 2026-11-17)

Reviewer: pr-infra. Scope: spec 04 in full, plus the infra parts of 01, 02 and 03. `05-owner-decisions.md` wins
over every spec where they differ. Checked against `origin/main` at `694db1a`: `packages/desktop/src-tauri/**`,
`.github/workflows/{ci,release}.yml`, `.github/dependabot.yml`, `scripts/{build-hub,fetch-node,deploy}.*` and
`deploy/**`. No product code was changed.

How things were checked:
- **Code:** read directly.
- **Crate compatibility:** resolved with `cargo metadata` in a scratch copy of `src-tauri`, with
  `tauri-plugin-updater` added.
- **SDK contents and licence:** read from the installed package in the main checkout. Licences came from
  `pnpm licenses list --prod --filter @pocketrocket/hub`.
- **Web sources:** Tauri updater docs, the `tauri-action` source (`upload-version-json.ts`) and
  https://signpath.org/terms, all read 2026-11-17.
- **Action status:** taken from the GitHub API.

---

## Spec 04: Distribution and money

### Confirmed
- **Bundled code:** the installer bundles `@anthropic-ai/claude-agent-sdk` itself.
  - It is in `REQUIRED` at `scripts/build-hub.mjs:91-103` and shipped as `hub/node_modules`.
  - Only the vendored platform CLI (`claude-agent-sdk-{win32,linux,darwin}-*`, about 220 MB) is pruned (`:110-129`).
  - The shipped package is about 5 MB (`sdk.mjs`, `bridge.mjs`, `browser-sdk.js`, manifests). Its `LICENSE.md` reads
    "© Anthropic PBC. All rights reserved", and `package.json` says "SEE LICENSE IN README.md".
  - Every other prod dependency is OSI-licensed: MIT 103, Apache-2.0 3 (playwright, playwright-core, @playwright/mcp),
    ISC 7, BSD-2/3 4, 0BSD 1, Unlicense 1.
  - The **SDK is the only non-OSS component** in the installer.
- **Updater JSON:** `uploadUpdaterJson: false` is set at `release.yml:111` and `:210`. The tray item "Check for
  updates" opens `RELEASES_URL` (`lib.rs:550`, `:1394`, `:1475`).
- **Builds:** Linux builds AppImage and deb on `ubuntu-22.04`, and macOS builds an ad-hoc dmg on `macos-15` (arm64).
  Both are built and uploaded into the release the Windows job creates (`release.yml:138-211`).
- **NSIS:** `installMode: currentUser`, and the pre-install and pre-uninstall hooks stop only
  `$INSTDIR\node.exe`, with the path handed over in an environment variable (`nsis/hooks.nsh`).
- **arm64 sidecar:** `fetch-node.mjs` **already supports `aarch64-unknown-linux-gnu`** (`:32`), so the spec's
  "if the sidecar fetch supports it" is already true.
- **Hub bind:** loopback is hardcoded (`config.ts` `HOST = '127.0.0.1'`).
- **Repo:** public, confirmed (`gh repo view`: PUBLIC). Checklist line 130 is stale.
- **Signing key:** Tauri updater signing cannot be disabled.
- **`latest.json` validation:** Tauri validates the whole static file before it reads the version, so one bad
  platform entry breaks the update for everyone. This is confirmed in the docs.

### Wrong or incomplete claims
1. **Updater plugin version (A1).**
   - The spec only says "pin a line that accepts tauri 2.11". Concretely, `tauri-plugin-updater` 2.13.x and 2.14.x
     require `tauri ^2.12`. **`=2.12.0` is the last version that accepts the locked tauri 2.11.6.**
   - I resolved it in a scratch copy:
     - tauri stays at 2.11.6, webview2-com at 0.38.2, notification at 2.4.0 and reqwest at 0.13.4.
     - It adds about 30 crates (rustls, ring, minisign-verify, zip, tar).
   - Dependabot's cargo ecosystem will propose 2.14 and break the build. It needs an `ignore` rule, or a
     group that moves tauri, notification and updater together.
2. **`latest.json` across separate jobs (A2): the spec's "verify it merges" is not enough.**
   - `tauri-action` does download an existing `latest.json` and merge in its platforms.
   - But it does a read, modify, delete and upload with no lock.
   - The Linux and macOS matrix jobs run in parallel, so the last one to upload can drop the other one's entry.
   - Today the Windows job publishes the release **non-draft** (`releaseDraft: false`) before Linux and macOS
     have built. `releases/latest/download/latest.json` would therefore serve a partial file, or a 404, while
     those jobs run, and forever if one of them fails.
   - Fix:
     - Build into a **draft**, and pass `releaseId` from the Windows job to the Unix jobs.
     - No build job writes `latest.json`.
     - A final job assembles `latest.json` from the `.sig` files, checks that every platform is complete, then
       publishes. See the task list below.
3. **Testing on a "test fork" (A2, A4) does not work as written.**
   - Both release jobs are gated `if: github.repository == 'AlexGaledo/pocketrocket'`, with `owner` and `repo`
     hardcoded.
   - Testing in the main repo is cheaper. Publish first as a **prerelease**, which `releases/latest` ignores, and
     update a test build whose endpoint is the tag-specific URL (`.../releases/download/vX.Y.Z/latest.json`).
     Then flip it to latest.
4. **Platform keys.**
   - `tauri-action` writes `os-arch` plus `os-arch-bundle` keys. By default it prefers `.msi` over NSIS for the
     bare key ("for legacy reasons"). We build NSIS only, so that is harmless today, but the assembler must
     choose explicitly:
     - `windows-x86_64` → `-setup.exe`
     - `linux-x86_64` → `.AppImage`, **never the `.deb`**
     - `darwin-aarch64` → `.app.tar.gz`
   - The macOS job builds `--bundles dmg`. Verify that the `.app.tar.gz` and its `.sig` appear; if not, use
     `--bundles app,dmg`.
5. **Key rotation (Risks).** "Rotating the key needs one manual reinstall per user" is wrong for a planned
   rotation. A release signed with the **old** key can carry the **new** pubkey. Only a **lost** key strands
   installs.
6. **Dry-run builds.** With `createUpdaterArtifacts: true`, `cargo tauri build` **fails** without
   `TAURI_SIGNING_PRIVATE_KEY`. That covers the dispatch dry run and every developer's local release build.
   - `DEVELOPMENT.md` needs the override:
     `cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
   - `ci.yml` only runs `cargo check`, so it is unaffected.
7. **SignPath (A9): the spec understates the problem.**
   - The terms say: "The project may not contain any proprietary, non open-source component". The only exception
     is GPL-v3-style "System Libraries", and an npm package we bundle is not one.
   - Under the plain text, the bundled SDK **disqualifies the current installer**.
   - Asking is still worth doing, but plan for "no", which means A10 is required before any SignPath signing.
   - Other terms the spec omits:
     - The policy page must use the exact phrase "Free code signing provided by SignPath.io, certificate by
       SignPath Foundation".
     - Product name and version metadata must be consistent.
     - Builds must be "verifiable". `fetch-node.mjs` resolves "the newest v24 LTS" at build time, so the sidecar
       is not reproducible. Pin the exact Node version and hash in the repo before applying.
8. **SignPath and the updater: order matters (not in the spec).**
   - Authenticode signing changes the installer's bytes, so the minisign `.sig` that `tauri-action` makes at
     build time stops matching.
   - Signing then has to go: SignPath signs the setup.exe (manual approval, asynchronous), then
     `tauri signer sign` runs on the **signed** file, then `latest.json` is built.
   - The same finalize job handles this, which is another reason to build it now.
   - SignPath cannot deep-sign inside an NSIS installer. Only the outer setup.exe gets signed;
     `PocketRocket.exe` inside stays unsigned (no Mark-of-the-Web, so acceptable).
9. **A10 size and shape.** SDK 0.3.269 has **no runtime dependencies**, so a first-run fetch is a single
   tarball, about 5 MB, checked against the `sha512` integrity value in `pnpm-lock.yaml`. Keep **L** for
   now: it spans pr-infra and pr-backend, the dev path and the server path behave differently, and onboarding
   needs offline-retry UX.
10. **Docker (B3): the image must not contain the Claude CLI.**
    - The spec says "Claude CLI installed per `deploy/claude-update.sh`" at image build. A public GHCR image would
      then **redistribute** the closed Claude Code binary, which conflicts with spec 01 ("We don't bundle it; keep
      it that way").
    - Instead, install it at first run into `$HOME` on the data volume. The user runs the official installer
      with `docker exec`, then `claude login`.
    - The same applies to `agy`.
    - Also: run as a non-root uid, and add a `HEALTHCHECK` on `127.0.0.1:7788/api/health`.
11. **One-line installer (B2): it misses three things.**
    1. **Node.** Node is not installed by any script today. `SERVER.md:25` says "install Node 22.13+, pnpm, and
       the Claude CLI" by hand. `install.sh` must install Node 24, preferably the official tarball checked
       against `SHASUMS256.txt` (the same logic as `fetch-node.mjs`).
    2. **pnpm.** `setup-vps.sh:69-70` runs `pnpm dlx playwright@…` from `packages/hub`, and `deploy.sh` runs
       `pnpm install && pnpm build`. A release tarball has no pnpm and no `packages/hub` source. Use
       `node <tarball>/node_modules/playwright/cli.js install chromium`; `playwright` is already a prod
       dependency.
    3. **Layout.** `/opt/pocketrocket/<ver>` would break shipped desktops.
       - `lib.rs:236` reads the token only from `/home/pocketrocket/pocketrocket/data/hub-token`.
       - `pocketrocket.service`, `backup.sh` and `keys.sh` all assume that root.
       - Keep `/home/pocketrocket/pocketrocket/data` as the data dir. Put code in
         `/home/pocketrocket/pocketrocket/releases/<ver>` with a `current` symlink, and change `ExecStart` from
         `tsx src/index.ts` to `node current/hub.mjs`.
       - The scan still classifies the server through `unit_pocketrocket=1`, even without `packages/hub`
         (`scan.rs:590`).
    - Re-estimate B2 as **L**: Node install, moving existing VPSes from the source layout to the release layout,
      the unit change, playwright without pnpm, and rollback.
12. **Checksums vs attestation (A6/B2).** A `SHA256SUMS.txt` downloaded from the same release only catches
    corruption, not tampering. The trust anchor is `gh attestation verify <file> -R AlexGaledo/pocketrocket`.
    Docs and `install.sh` should say so. `install.sh` should run the attestation check when `gh` is present and
    fall back to the checksum with a printed warning.
13. **Docker host networking.** "Linux only" holds as the supported path. Docker Desktop has an opt-in host
    networking mode (4.34+), but whether a container's `127.0.0.1` bind is reachable from the host is
    **unverified**, so do not document it.
14. **Tray (not in the spec).**
    - P9 made close-to-tray the default in local mode (`lib.rs:62-63`), so the app can run for weeks.
    - The owner chose "daily check at launch". Also check every 24 h while the app is running, or a tray user
      never sees updates.
15. **Remote mode (not in the spec).** In VPS mode a desktop update does not touch the server hub. A4's busy
    gate applies only in **local** mode. The server is updated separately through B2.
16. **Smart App Control (not in the spec).**
    - On Windows 11 machines with Smart App Control on, unsigned apps with no reputation are **blocked** with no
      per-app override. This is expected behaviour: verify it on a clean VM with SAC on.
    - The updater's no-Mark-of-the-Web path does not help there; only signing does. Document it in the FAQ
      ("turn off Smart App Control or wait for signed builds").

### Is the NSIS hook safe during an auto-update? Yes, for files and processes. The risk is data, not the hook.
- **Order:** on Windows the updater **exits the app** when the install step runs (Tauri docs). The Job Object with
  KILL_ON_JOB_CLOSE (`proc.rs`) then kills node, `claude.exe` and ssh before the installer's pre-install hook runs.
- **The hook is a backstop:** it catches orphaned pre-0.3 `node.exe` processes.
- **System Node:** when the hub runs on the user's system Node (launch order 2), the hook does not match it,
  because it compares `$INSTDIR\node.exe` only. The job kill already covers that case.
- **No file locks:** no native `.node` addons are bundled (the bundle check below enforces this). `hub.mjs` and
  `node_modules` are read and then closed, so nothing locks `$INSTDIR\hub\`.
- **Passive install:** in passive mode, Tauri's `CheckIfAppIsRunning` kills without a prompt. That is fine,
  because the app has already exited.
- **The real risk is an abrupt stop:**
  - The running turn is aborted.
  - Open approvals are lost (a known bug).
  - Any non-SQLite file write in progress can be torn.
  - Mitigation:
    1. A4 gates the install on the hub being idle (local mode).
    2. The updater's Windows `on_before_exit` hook asks the hub to stop cleanly and waits up to about 5 s
       before the job kill.
    3. On macOS and Linux the app calls `restart()` itself after the same clean stop.
- **Verify on a clean VM:**
  - The installer relaunches the app after a passive update.
  - The hub comes back with the same token and data.

### Risks to add
- **Signing-key exposure in CI.**
  - Put `TAURI_SIGNING_PRIVATE_KEY` only in **step-level** `env` on the build steps, never in the job env, so
    `pnpm install`, `pnpm test` and postinstall scripts never see it.
  - Scope the secrets to a GitHub **environment** `release` with the owner as required reviewer and a `v*`
    tag rule. That is free on a public repo.
  - Rust build scripts in the same step can still read the key. The full fix is signing in a separate job
    (later, when SignPath forces that job to exist anyway).
- **Version skew between desktop and server.** An updated desktop may tunnel to an older server hub. The UI is
  served by the hub, so this is mostly harmless, but the splash page's calls (`/api/health`,
  `/api/providers/claude/check`) must stay backward compatible.
- **Updater outbound host.** Add `github.com` / `objects.githubusercontent.com` (release downloads) to the
  outbound list in `PRODUCTION-CHECKLIST.md`.

### Required changes to spec 04
- A1: pin `tauri-plugin-updater = "=2.12.0"`, and add a Dependabot ignore or group for it. The update check is
  a Rust-internal call, **not** a `#[tauri::command]`, so there is no IPC surface. No capability file,
  including `hub-notify.json`, gains `updater:*`.
- A2: replace "set `uploadUpdaterJson: true`" with: draft release, then a finalize job that assembles
  `latest.json`, checks it, attests it and publishes it, staged as prerelease first and then latest.
- A4: also check every 24 h while running; apply the busy gate in local mode only; stop the hub cleanly in
  `on_before_exit`; remember a skipped version in `config.json`.
- A6: merge into A2's finalize job. Attest the installers in their build jobs and `latest.json` and
  `SHA256SUMS.txt` in the finalize job. Pin `actions/attest-build-provenance` to v4.2.2
  (`4d101475d8b20a2381f78447822ac1eab6504dd8`). Grant `id-token: write` and `attestations: write` only on the
  jobs that attest.
- A8: use `ubuntu-22.04-arm`, not `24.04-arm`, for the arm64 AppImage, so its glibc floor matches x64 (2.35).
- A9: before applying, pin the Node sidecar version and hash, and publish the policy page with SignPath's exact
  wording. Expect "no" because of the SDK.
- B2: add Node install, the layout rules from item 11 and the move from the source layout. Size **L**.
- B3: no Claude CLI or `agy` in the image; non-root; healthcheck.
- CLA (Phase D):
  - Use **cla-assistant.io** (SAP's hosted GitHub app, free, still maintained: v2.13.2 on 2026-10-13).
  - **Do not use** `contributor-assistant/github-action` (CLA Assistant Lite). Its repo is **archived**.
  - A DCO does not grant relicensing.
  - Allow `dependabot[bot]`. Check whether `Co-Authored-By: Claude` trailers count as unsigned contributors.
  - Make the check required on `main`.

### Size re-estimate (pr-infra items)
| # | Spec | Review | Why |
|---|---|---|---|
| A1 | (S implied) | **S** | Resolves cleanly at `=2.12.0` |
| A2 | (S implied) | **M** | Draft, finalize-job assembler and staged publish |
| A4 | (M implied) | **M** | Dialog, 24 h timer, busy gate, clean stop |
| A6 | S | **S** | Folded into A2 |
| A7 | S | S | — |
| A8 | M | M | Manual installs on 3 OSes, plus the arm64 runner |
| A9 | S | S + calendar time | Plus pinning the Node sidecar (S) |
| A10 | L | **L** (could shrink to M) | One dependency-free tarball, but split across teams with onboarding UX |
| B1 | (S implied) | S | Plus a "no `.node` files" assertion |
| B2 | M | **L** | Node, layout move, unit, playwright without pnpm |
| B3 | M | M | Runtime CLI install, non-root |
| CLA | S | S | — |

---

## Spec 01: Providers and failover (infra parts)

### Confirmed
- No managed download of closed CLIs: detect the CLI, show the official install command, and warn outside a
  tested version range. This matches principle 1 and Google's no-redistribution stance.
- Provider children get an environment allowlist (`providers/env.ts`); the hub token is never on it.
- On Windows, Node refuses to spawn `.cmd` files without a shell. `codex.ts:70-79` already resolves shims
  without `shell: true`.

### Wrong or incomplete
1. **Stale PATH on Windows (not in the spec).**
   - The hub inherits the Tauri process's environment (`lib.rs:470-495`), and with close-to-tray the app runs
     for days.
   - If a user installs `agy` while the app is running, "Restart hub" still passes the **old** PATH, and Gemini
     says "not found" until the app is quit from the tray.
   - Claude avoids this only because `CLAUDE_EXE` is a fixed path (`config.ts`).
   - Fix, either or both:
     - (a) `AGY_EXE` override, then the known default install directory **once confirmed by a live install**
       (do not guess it), then a PATH scan.
     - (b) The shell re-reads the user and machine `Path` from the registry (`HKCU\Environment`,
       `HKLM\…\Session Manager\Environment`, expanding `REG_EXPAND_SZ`) each time it spawns the hub. Size S,
       pr-infra.
2. **Shims.** If `agy` installs as a `.cmd` or `.ps1` shim, use the codex resolver pattern and **never**
   `shell: true`. `opencode/server.ts:181` does use `shell: true` with hand quoting; don't copy that.
3. **Environment allowlist.**
   - P2-2 says "env allowlist for `agy`" but names nothing.
   - The API-key path (05 #1) needs the Gemini key variable(s) on the gemini list only. Confirm the exact names
     from Google's docs at build time.
   - On Linux, if `agy` keeps OAuth tokens in a desktop keyring, it needs `DBUS_SESSION_BUS_ADDRESS`, which is not
     on the base list. A headless VPS has no keyring at all.
   - **Live-test** where `agy` stores its login on Windows and on the server before choosing names.
4. **Linux server.**
   - The `pocketrocket` user installs `agy` into `~/.local/bin`. That directory is already first on the unit's
     `PATH` and inside `ReadWritePaths=/home/pocketrocket`, so no unit change is needed.
   - Login is headless. It goes through the in-app Server terminal (ConPTY over SSH), and **only works if `agy`
     has a device-code or paste-code flow** (unverified).
   - Google staff replies about using it on a remote server are narrower ([G6] in spec 01). Recommend the
     **API key** path on a VPS and the Google login on the PC.
5. **Updates.**
   - Do **not** add an hourly cron for `agy` like `claude-update.sh`. The tested-version-range warning only means
     something if the version moves when the owner chooses.
   - Show "newer than tested" as a warning, not a refusal.
   - Parse `agy --version` leniently: unparsable means "unknown version (untested)", not an error.
   - Use the same 12 s cold-start timeout as Claude.
6. **I-1 is almost free.** `ci.yml` already runs `pnpm test`, which includes every vitest file, so fake-ACP-agent
   tests run with no workflow change. Remove I-1, or make it "add nothing".
7. **SSH scan (optional, S).** `scan.rs` could add a read-only `command -v agy` line to report Gemini on servers.
   Low priority; it must stay one line with no single quotes (`scan.rs:436`).

### Size
pr-infra work in gap 1 is about **S** in total: the PATH refresh (S) and optionally the scan line (S).
Everything else is pr-backend.

---

## Spec 02: Steering and workflows (infra parts)

Owner decision 05 #3 makes the **React Flow canvas** the editor, lazy-loaded. The spec's line "No pr-infra work in
this gap" (`02:316`) is now slightly wrong.

### Confirmed
- **Bundle impact:** about 57 KB gzip (a third-party figure) plus CSS, in a lazy chunk.
  - The web build ships inside the installer as `hub/web`, so the installer grows by well under 1 MB on top of
    about 30 MB. Negligible.
  - The same holds for the server tarball and the Docker image.
- **Hub CSP:** `api/csp.ts` already allows `style-src 'self' 'unsafe-inline'`, and React sets styles through
  the CSSOM anyway.
- **Desktop CSP and navigation:** the CSP in `tauri.conf.json` covers only the splash page, and the canvas
  stays on `127.0.0.1`. **No desktop change.**

### Risks / required changes
1. **Stale chunk after an update.**
   - `sw.js` serves navigations network-first but caches `/assets/*` on first use.
   - The web app has **no lazy chunks today**, so this is new.
   - Scenario: a tab opened before a hub update (a VPS redeploy, or B2's upgrade) dynamically imports a chunk
     hash that no longer exists, and the import fails.
   - Fix: catch the chunk-load error and reload once (pr-design-system, S).
2. **Bundle budget in CI (pr-infra, S).** After `pnpm -r build`, a small script asserts:
   - `@xyflow` code is not in the entry chunk;
   - the entry chunk stays under a set budget.
   - This keeps "lazy-loaded" from rotting.
3. **Licence:** React Flow is MIT. Add it to any third-party notices file if one is introduced. No SignPath
   impact.

---

## Spec 03: Chat channels (infra parts)

Owner decision 05 #6 limits scope to **Telegram notifications only** (Phase A). Phase A sends outbound with
`sendMessage`, plus one short `getUpdates` poll while linking (A2). There is **no** long-running long-poll until
Phase B, which is deferred.

### Confirmed
- **No inbound port, no relay, no webhook.** Loopback rules are untouched.
- **VPS unit:** `pocketrocket.service` allows `AF_INET`/`AF_INET6` and there is no egress firewall, so
  `api.telegram.org` works with **no unit change**.
- **Restarts:** `Restart=always` and `RestartSec=3` restart the hub after a crash. Phase B's persisted offset
  covers redeploys.

### Risks / required changes
1. **Token in the URL path.** The Bot API puts the token in the path (`/bot<token>/sendMessage`). Today
   `integrations/http.ts` logs only the host (good). However:
   - `providers/redact.ts` has **no pattern** for Telegram tokens (`\d{8,10}:[A-Za-z0-9_-]{35}`). Add one
     (pr-backend, S), so a URL in an error, `hub.log` or journald is redacted.
   - Never log full request URLs in the Telegram client.
2. **Kill switch.** `deploy/keys.sh` lists a revoke page per provider (`:85-93`). Add Telegram (BotFather
   `/revoke`) when the provider lands (pr-infra, S).
3. **Outbound list.** Add `api.telegram.org` to `PRODUCTION-CHECKLIST.md:32`, together with the updater hosts
   from spec 04.
4. **One consumer per token.**
   - Two hubs (PC and VPS) can both `sendMessage` without conflict.
   - Only the A2 link poll, and later Phase B, hit 409.
   - Phase A needs only the "already linked on another hub" message during linking.
5. **Phase B, later.**
   - On a VPS, a 50 s long-poll needs no change. Node's fetch timeouts are longer than 50 s.
   - Pass an `AbortSignal` so a systemd stop does not wait out the 90 s stop timeout.
   - On a sleeping PC, nothing is received until it wakes. Telegram holds updates for 24 h.
   - Corporate HTTP proxies: Node's `fetch` ignores `HTTPS_PROXY` unless it is opted in. Check before
     promising proxy support.

---

## The $0 release pipeline, in order

Every step is free on a public repo. Steps 1-6 come before any other distribution work.

1. **Key and custody (owner and pr-infra, S).**
   - Run `cargo tauri signer generate` offline, with a password.
   - Keep the private key and password in the password manager plus one offline copy. Write the restore and
     planned-rotation steps (old key signs the release that carries the new pubkey) into `RELEASING.md`.
   - Create the GitHub environment `release`: owner as required reviewer, deployments only from `v*` tags and
     manual dispatch.
   - Put `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in that environment only.
2. **Updater wiring (A1, S).**
   - `tauri-plugin-updater = "=2.12.0"`.
   - Dependabot ignore for the updater 2.13+ (or a tauri group).
   - `bundle.createUpdaterArtifacts: true`, `plugins.updater.pubkey`, and the endpoint
     `https://github.com/AlexGaledo/pocketrocket/releases/latest/download/latest.json`.
   - `windows.installMode: "passive"`.
   - Plugin registered in Rust only, with no capability or command.
   - The `DEVELOPMENT.md` override for local builds without the key.
   - Verify: `cargo check`; `grep -r updater capabilities/` is empty.
3. **Draft-then-publish release (A2 + A6, M).**
   - **Windows job:** keeps every gate. Adds `environment: release` and `releaseDraft: true`. Keeps
     `uploadUpdaterJson: false` and outputs `releaseId`. The signing key goes in step-level env on the build
     step only. It attests `*-setup.exe` with `actions/attest-build-provenance@4d101475…` (v4.2.2) and gets
     `id-token: write` and `attestations: write`.
   - **Unix matrix:** `releaseId: ${{ needs.release.outputs.releaseId }}`, `uploadUpdaterJson: false`, the same
     environment and step-level key. macOS `--bundles app,dmg` if the `.app.tar.gz` is missing. Attests its own
     bundles.
   - **New `finalize` job** (`needs: [release, release-unix]`, ubuntu, `environment: release`):
     1. `gh release download` the draft's assets.
     2. Run a new `scripts/updater-json.mjs`. It builds `latest.json` with exactly `windows-x86_64` (setup.exe),
        `linux-x86_64` (AppImage) and `darwin-aarch64` (`.app.tar.gz`), plus the CHANGELOG notes and `pub_date`,
        and **fails** if any entry lacks a URL or signature.
     3. Write `SHA256SUMS.txt` over every asset.
     4. Attest both files.
     5. Upload them and publish as a **prerelease**.
   - Unit-test the assembler in `pnpm test` with fixture `.sig` files.
4. **Staged rollout check (owner, S each release).**
   - A test build pointed at `.../releases/download/vX.Y.Z/latest.json` updates from the previous version on a
     clean Windows VM.
   - Then `gh release edit vX.Y.Z --prerelease=false --latest`.
   - Add this to `RELEASING.md`. The first time, also run it with SAC on and with a turn running (after step 5).
5. **Update UX in the shell (A3 pr-backend S, then A4 pr-infra M).**
   - `GET /api/busy`.
   - Check at launch and every 24 h. "Check for updates" in the tray uses the plugin instead of the browser.
   - Native dialog with Install and restart / Later / Skip this version.
   - Install only when idle (local mode).
   - `on_before_exit` stops the hub cleanly.
   - Offline means silent on the automatic check.
6. **Docs (A7, S).**
   - "Verify your download": `gh attestation verify` first, the checksum second.
   - SmartScreen and Smart App Control FAQ.
   - macOS 15 "Open Anyway".
   - AppImage on Ubuntu 23.10+ (AppArmor).
   - deb users update by hand.
   - Fix checklist line 130 and add the outbound hosts.
7. **Linux and macOS verification (A8, M).** Real installs on Ubuntu 22.04 and 24.04 and on macOS 15. Add an
   `ubuntu-22.04-arm` AppImage. Close checklist row 169.
8. **SignPath groundwork (A9, S plus waiting).**
   - Pin the Node sidecar's exact version and SHA-256 in the repo instead of "newest LTS".
   - Publish the code-signing policy page with SignPath's required wording.
   - Turn on MFA for all maintainers.
   - Apply, and ask about the SDK in writing.
   - If they refuse, A10 (L) comes before signing.
   - If they accept, extend `finalize`: SignPath signs `-setup.exe` (manual approval), then
     `tauri signer sign` runs on the signed file, then `latest.json` is built.
9. **Server release (B1 S, then B2 L).**
   - The release also builds `pocketrocket-server-X.Y.Z.tar.gz` (architecture-independent: assert there are no
     `*.node` files) and `install.sh` with its version baked in. Both go into the sums and the attestation.
   - `install.sh`:
     - installs Node 24 from the official tarball, checked against `SHASUMS256.txt`;
     - installs into `~pocketrocket/pocketrocket/releases/<ver>` with a `current` symlink, and keeps
       `~pocketrocket/pocketrocket/data`;
     - changes the unit's `ExecStart` to `node current/hub.mjs`;
     - runs `setup-vps.sh` with playwright through `node …/playwright/cli.js`;
     - can roll back to the previous symlink;
     - never opens a port.
   - Document it as download, read, then run.
   - Keep `deploy.sh` for development.
10. **Docker (B3, M).**
    - Headless image on GHCR (amd64 and arm64, attested), non-root, `POCKETROCKET_COMPUTERS=0`, data volume,
      `HEALTHCHECK`.
    - Claude CLI and `agy` installed by the user at runtime into the volume.
    - Docs use `--network host` on Linux only.
11. **CLA (S, before the first outside PR).**
    - cla-assistant.io with the CLA text in a gist.
    - `dependabot[bot]` allowlisted; check how Claude co-author trailers are treated.
    - The check required on `main`, and a line in `CONTRIBUTING.md`.

Small extras from specs 01-03, any time:
- PATH refresh when spawning the hub (S).
- CI bundle budget for the React Flow chunk (S).
- Telegram line in `keys.sh` (S).
- Outbound hosts in the checklist (S).
