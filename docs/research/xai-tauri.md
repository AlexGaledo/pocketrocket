# Research: xAI Grok, Tauri 2 bundling, Node sidecar, esbuild, CI (2026-09-08)

Sub-agent research report, condensed. Verify flagged items before relying on them.

## xAI Grok

- **Official CLI exists: "Grok Build"** (`grok` command). Install: `irm https://x.ai/cli/install.ps1 | iex` (Windows), `curl -fsSL https://x.ai/cli/install.sh | bash`. Interactive TUI + headless `-p` mode, skills/plugins, Agent Client Protocol. Auth: browser login or `XAI_API_KEY`. Docs: https://docs.x.ai/build/overview. → PocketRocket's Grok adapter should drive this CLI (same shape as Codex/OpenCode); verify its headless output format and MCP config before building.
- Subscriptions (SuperGrok, X Premium) do NOT include API access. API keys (`xai-...`) from https://console.x.ai, pay-as-you-go. OpenCode can also use SuperGrok OAuth for Grok models.
- `@ai-sdk/xai` 4.0.x (`createXai({apiKey})`, zod 4 OK); `ai` is at v7 (`ToolLoopAgent`, `isStepCount`, `stopWhen`; `stepCountIs` still works). Only needed if the CLI path fails.
- Models (verify pricing in console): `grok-4.6` ($2/$6 per 1M, 500K ctx), `grok-4-fast` (~$0.20/$0.50, 2M ctx), `grok-code-fast-1` ($1/$2, $0.20 cached, 256K) = sensible default for coding.
- Server-side tools (web_search, x_search, code_execution) via Responses API only.

## Tauri 2 Windows bundling

- Sidecar: `bundle.externalBin: ["binaries/node"]`; file `src-tauri/binaries/node-x86_64-pc-windows-msvc.exe` (triple from `rustc --print host-tuple`). At install the binary sits next to the app exe as `node.exe`. Spawning via `tauri-plugin-shell` (`app.shell().sidecar("node")`, capability `shell:allow-execute`/`allow-spawn` with `sidecar: true`) is the documented path; plain `std::process::Command` on the resolved path also works without the plugin (we already spawn node that way). https://v2.tauri.app/develop/sidecar/
- Resources: `bundle.resources: {"../../hub/dist/": "hub/"}` (object form avoids `_up_` path mangling). Runtime: `app.path().resolve("hub/hub.mjs", BaseDirectory::Resource)` or `resource_dir()`. NSIS keeps the tree under `$INSTDIR\resources\`. https://v2.tauri.app/develop/resources/
- NSIS options: `installMode currentUser|perMachine|both`, `languages`, `installerIcon`, `license`, `displayLanguageSelector`. `productName` used verbatim for the exe name. https://v2.tauri.app/distribute/windows-installer/
- CI: `tauri-apps/tauri-action` on `windows-latest` with `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2` (workspaces `packages/desktop/src-tauri -> target`), `pnpm/action-setup`, `actions/setup-node`. `GITHUB_TOKEN` with `contents: write` uploads to the Release. https://v2.tauri.app/distribute/pipelines/github/

## Node runtime

- Zip: `https://nodejs.org/dist/v<ver>/node-v<ver>-win-x64.zip`; `node.exe` is standalone; MIT (ship LICENSE). As of 2026-09: Node 26 = Current (LTS in Oct 2026), Node 24 = active LTS, Node 22 = LTS. **Ship Node 24 LTS**; detect system Node ≥ 22.13.
- `node:sqlite`: unflagged since 22.13 / 23.4, "release candidate" stability since 25.7. Fine on 24 (verify hub runs under 24 in P1B).
- SEA (single executable) is possible but less proven with Tauri; not for v1.

## esbuild for the hub

- Recommended: `esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/hub.mjs` and ship a production `node_modules` next to it (`pnpm --filter @pocketrocket/hub deploy --prod <dir>`). Reasons: `ws` optional native deps (`bufferutil`, `utf-8-validate`) and `http-proxy` dynamic requires break full bundling; `@anthropic-ai/claude-agent-sdk` resolves platform optional deps at runtime (we pass `pathToClaudeCodeExecutable` to the system CLI, but keep the SDK external anyway).
- If a `require()` shim is needed in ESM output: `--banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"`. Derive `__dirname` from `import.meta.url` in our own code (already done in `config.ts`).
