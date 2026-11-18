# Releasing PocketRocket

PocketRocket ships a Windows NSIS installer, a Linux AppImage and deb, and an unsigned macOS dmg.
`.github/workflows/release.yml` builds them on a `v*` tag in three stages:

1. **Windows job** (`release`): every gate (version sync, tag == `package.json`, `pnpm test`,
   CHANGELOG section), then builds the installer and creates a **draft** release holding it and its
   updater `.sig`. It outputs the draft's `releaseId`.
2. **Linux + macOS jobs** (`release-unix`): build natively and upload into that same draft by id.
3. **Finalize job** (`finalize`): downloads every asset of the draft, builds `latest.json` once with
   `scripts/updater-json.mjs`, writes `SHA256SUMS.txt`, attests the installers, `latest.json` and
   `SHA256SUMS.txt` (`actions/attest-build-provenance`), uploads the two files and publishes the
   draft as a **prerelease**.

Nothing is public until finalize succeeds. If any build or finalize fails, the release stays an
unpublished draft; fix the cause and re-run the failed jobs (finalize skips any `latest.json` or
`SHA256SUMS.txt` left from an earlier attempt and replaces them).

Why no build job writes `latest.json`: tauri-action merges it with read-modify-upload and no lock, so
parallel jobs drop each other's entries (tauri-action #1270), and Tauri rejects the whole file if one
platform entry is bad. `scripts/updater-json.mjs` maps exactly `windows-x86_64` → `*_x64-setup.exe`,
`linux-x86_64` → `*.AppImage` (never the `.deb`) and `darwin-aarch64` → `*.app.tar.gz`, and refuses to
write anything when a platform is missing, a `.sig` is missing or malformed, or a signature does not
verify against the `plugins.updater.pubkey` in `tauri.conf.json`. Finalize also fails while that
pubkey is still the placeholder `OWNER_STEP_PASTE_UPDATER_PUBKEY`.

A prerelease is ignored by `releases/latest`, so installed apps (whose updater endpoint is
`.../releases/latest/download/latest.json`) do not see a new version until the owner flips it to
latest after the clean-VM check (step 8 below).

## One-time owner setup

### Updater signing key (A0)

Tauri refuses an update whose signature doesn't match the pubkey compiled into the installed app.

1. On a trusted machine, offline, generate the key **with a password**:

   ```
   cargo tauri signer generate -w pocketrocket-updater.key
   ```

2. Store the private key file **and** its password in the password manager, plus one offline copy
   (encrypted USB stick or paper). Never commit the private key.
3. Paste the contents of `pocketrocket-updater.key.pub` into `plugins.updater.pubkey` in
   `packages/desktop/src-tauri/tauri.conf.json` (replacing `OWNER_STEP_PASTE_UPDATER_PUBKEY`) and
   merge that through a normal PR.

**Restore** (new machine, lost CI secret): take the key and password from the password manager and
put them back into the `release` environment secrets below. Nothing else changes.

**Planned rotation** (no reinstall needed): generate a new key, ship one more release **signed with
the old key** whose `tauri.conf.json` carries the **new** pubkey, wait until most installs have taken
it, then swap the environment secrets to the new key for the following release. Only a **lost** key
strands installs: they then need one manual reinstall from the release page.

### The `release` environment

Settings → Environments → New environment `release`:

- **Required reviewers:** the owner. Every tag build waits for approval, three times per release:
  the Windows job, then the Linux and macOS jobs together, then finalize. The finalize approval is
  the "publish this release" gate.
- **Deployment branches and tags:** selected tags only, pattern `v*`. Manual-dispatch dry runs do not
  use the environment at all (`environment` is empty for non-tag runs), because environment rules
  can't filter by event; dry runs therefore never see the key and build without updater artifacts.
- **Environment secrets:** `TAURI_SIGNING_PRIVATE_KEY` (the private key file's contents) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Do not add them as repository secrets. The workflow passes
  them only in the `env` of the tauri-action build step, so `pnpm install`, tests and postinstall
  scripts never see them.

The desktop app updates itself from the release's signed `latest.json`
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
   that section verbatim into the GitHub Release body and the `latest.json` notes (the run fails if
   the section is missing or empty), so keep it release-note quality — no internal shorthand.

5. **Commit and tag.**

   ```
   git add -A
   git commit -m "Release vx.y.z"
   git tag vx.y.z
   git push && git push --tags
   ```

   The tag push (`v*`) triggers `release.yml`. Tag and `package.json` version must match — the
   workflow asserts this and fails fast if they've drifted.

6. **Approve and watch the workflow.** `gh run watch` or the Actions tab. Approve the `release`
   environment for the Windows job, then for Linux + macOS, then for finalize. When it is green the
   release `vx.y.z` exists as a **prerelease** with the installers, their `.sig` files,
   `latest.json` and `SHA256SUMS.txt`.

7. **Check the published assets.**

   ```
   gh release download vx.y.z -p latest.json -O - | jq '.version, (.platforms | keys)'
   gh release download vx.y.z -D check && cd check
   gh attestation verify PocketRocket_x.y.z_x64-setup.exe -R AlexGaledo/pocketrocket
   sha256sum -c SHA256SUMS.txt
   ```

   Expect `"x.y.z"` and `["darwin-aarch64", "linux-x86_64", "windows-x86_64"]`, and a passing
   attestation for each installer.

8. **Clean-VM update test (before anyone gets the update).** On a clean Windows VM:
   - Install the **previous** release from its release page. SmartScreen shows the "unknown
     publisher" prompt (expected — see below); "More info → Run anyway" launches the app.
   - Point a test build at the tag-specific manifest
     `https://github.com/AlexGaledo/pocketrocket/releases/download/vx.y.z/latest.json`
     (installed apps only see `releases/latest`, which still serves the previous version) and
     confirm it offers x.y.z, installs it and restarts.
   - Confirm the onboarding wizard runs on a fresh profile, a bot answers a DM, and Settings shows
     x.y.z.
   - The first time, also run it with Smart App Control on and with a bot turn running.

9. **Flip to latest.** Only after step 8 passes:

   ```
   gh release edit vx.y.z --prerelease=false --latest
   ```

   From this moment `releases/latest/download/latest.json` serves x.y.z and installed apps update.
   Then check the site's download button points at the new installer.

10. **SmartScreen note.** The installer and app binary are **unsigned** (no code-signing
    certificate yet). Every fresh browser download trips SmartScreen with an "unrecognized app"
    warning. This is expected, not a build failure. The trust anchor for users is
    `gh attestation verify <file> -R AlexGaledo/pocketrocket`; `SHA256SUMS.txt` from the same
    release only catches a corrupted download.

## Yanking a release

- **Still a prerelease** (step 8 failed): nobody's app has seen it. `gh release delete vx.y.z
  --cleanup-tag`, fix, and cut a new patch version.
- **Already latest:** first make the previous good release latest again so no more apps update to
  the bad one (`gh release edit vPREV --latest`), then delete or edit the bad release. Apps that
  already updated stay on it, so cut a fixed patch release (steps above) promptly; it reaches them
  through the updater.
- Leave the `CHANGELOG.md` entry in place with a note that the release was pulled, so the history
  stays honest.

## Dry run (manual dispatch)

Actions → Release → Run workflow builds every platform without creating a release, without the
`release` environment and without the signing key, and uploads the bundles as workflow artifacts.
Use it to check a build before tagging.

## Building locally (without CI)

```
pnpm desktop:build
```

This runs `pnpm desktop:prepare` (hub bundle + web build + Node sidecar fetch) followed by
`cargo tauri build`. The installer lands at
`packages/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`. As in step 1 above, make sure
`PocketRocket.exe` isn't running first. Updater artifacts need the signing key, so local builds don't
make them; see `docs/DEVELOPMENT.md` for the override if your build asks for the key.

`node scripts/version.mjs --check` and `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml`
are both worth running before a local build too — they catch version drift and a stale
`Cargo.lock` before you spend the time on a full Tauri build.
