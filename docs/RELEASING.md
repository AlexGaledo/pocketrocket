# Releasing PocketRocket

PocketRocket ships as a Windows NSIS installer, built and attached to a GitHub Release by
`.github/workflows/release.yml`. The desktop app updates itself from the release's signed `latest.json`
(`tauri-plugin-updater`, checked at launch and every 24 h; the install is always the user's choice and, in
local mode, waits until `GET /api/busy` reports nothing blocking). A build whose `plugins.updater.pubkey` is still
the placeholder never checks and its tray item reads "Updates not configured".

**Testing an update before it goes out:** publish the release as a prerelease (which `releases/latest` ignores),
then start an older installed build with
`POCKETROCKET_UPDATE_ENDPOINT=https://github.com/AlexGaledo/pocketrocket/releases/download/vX.Y.Z-rc.N/latest.json`.
Any value outside `https://github.com/AlexGaledo/pocketrocket/releases/` is ignored (and logged); the download is
still verified against the pubkey.

## Checklist

1. **Close the running app.** `PocketRocket.exe` (and any `node.exe` sidecar it spawned) must not
   be running before a local build — Windows can't overwrite a binary that's in use, and the
   installer will silently fail or leave a half-written `target/` dir.

2. **Bump the version.**

   ```
   node scripts/version.mjs x.y.z
   ```

   This writes `x.y.z` to root `package.json` (the authoritative source), every
   `packages/{hub,web,shared,desktop,site}/package.json`, `packages/desktop/src-tauri/tauri.conf.json`,
   and the `[package] version` line in `packages/desktop/src-tauri/Cargo.toml`. Run with no
   argument (or `--check`) any time to verify everything still agrees — it exits non-zero on drift.

3. **Refresh `Cargo.lock`.** The version script deliberately does not touch it — Cargo owns that
   file. Run:

   ```
   cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
   ```

   and commit the resulting `Cargo.lock` change alongside the version bump.

4. **Update `CHANGELOG.md`.** Rename the `## [Unreleased]` section to `## [x.y.z]` (add a fresh
   empty `## [Unreleased]` above it for the next round). The release workflow copies the text of
   the top `## [...]` section verbatim into the GitHub Release body, so keep it release-note
   quality — no internal shorthand.

5. **Commit and tag.**

   ```
   git add -A
   git commit -m "Release vx.y.z"
   git tag vx.y.z
   git push && git push --tags
   ```

   The tag push (`v*`) triggers `release.yml`. Tag and `package.json` version must match — the
   workflow asserts this (`GITHUB_REF_NAME` minus the leading `v` vs. `package.json`'s `version`)
   and fails fast if they've drifted.

6. **Watch the workflow.** `gh run watch` or the Actions tab. It runs `pnpm test`, builds the hub
   bundle + web UI + fetches the Node sidecar (`pnpm desktop:prepare`), then
   `tauri-apps/tauri-action` builds the NSIS installer and attaches `PocketRocket_x.y.z_x64-setup.exe`
   to the Release at tag `vx.y.z`.

7. **Verify the installer.** Download it from the freshly created Release, run it on a clean (or
   at least PocketRocket-free) Windows account, and confirm:
   - SmartScreen shows the "unknown publisher" prompt (expected — see below), and after
     "More info → Run anyway" the app launches.
   - The onboarding wizard runs, a bot answers a DM, and Settings shows the correct version.

8. **SmartScreen note.** The installer and app binary are **unsigned** (no code-signing
   certificate in v1). Every fresh install trips Windows SmartScreen / Defender SmartScreen with
   an "unrecognized app" warning. This is expected, not a build failure — SmartScreen's reputation
   score climbs with download volume over time, it can't be pre-cleared. Mention this in the
   Release notes / site copy so users aren't surprised, and don't waste time trying to "fix" it
   short of paying for a signing certificate.

## Yanking a release

There's no unpublish-and-notify flow. Installed apps that already saw the bad version keep offering it until
they next check; deleting the release makes `latest/download/latest.json` point at the previous one. To pull a bad
release:

1. `gh release delete vx.y.z --cleanup-tag` (or via the GitHub UI: Release → Delete, and delete the
   tag) to stop new downloads.
2. If the bug is already out in the wild, cut a new patch release (steps above) rather than trying
   to edit history — anyone who already installed the bad build needs a new installer to fix it
   anyway, and there's no forced-upgrade path.
3. Leave the `CHANGELOG.md` entry in place with a note that the release was pulled, so the history
   stays honest.

## Building locally (without CI)

```
pnpm desktop:build
```

This runs `pnpm desktop:prepare` (hub bundle + web build + Node sidecar fetch) followed by
`cargo tauri build`. The installer lands at
`packages/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`. As in step 1 above, make sure
`PocketRocket.exe` isn't running first.

`node scripts/version.mjs --check` and `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml`
are both worth running before a local build too — they catch version drift and a stale
`Cargo.lock` before you spend the time on a full Tauri build.
