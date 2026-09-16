# Developing PocketRocket

Running from source, building the desktop app, and the layout of the repo. Contribution rules
are in [CONTRIBUTING.md](../CONTRIBUTING.md). macOS and Linux have no installer yet, so this is
also how to run PocketRocket there.

## Layout

```text
packages/shared    models + WS/REST schemas (zod)
packages/hub        Node hub:
                       db/                 SQLite schema + migrations
                       agent/              BotRunner, PromptBuilder, botTools
                       providers/          claude.ts, registry.ts (Codex/OpenCode/Grok exist behind
                                            a dev-only flag; see CONTRIBUTING.md)
                       rooms/              RoomRouter, mentions
                       permissions/        PermissionBroker, pathRules, bashRules
                       services/           Memory, Skill, Routine, Usage
                       api/                REST + WS
packages/web         Vite + React + Tailwind + Zustand UI
packages/desktop     Tauri shell (Rust + WebView2)
packages/site        static landing page (deployed separately)
scripts/             smoke.mjs (DM), group-smoke.mjs (3-bot room) — run against a live hub:
                       cd packages/hub && node ../../scripts/smoke.mjs "your message"
```

## Run from source

Requirements: Node ≥ 22.13 (uses built-in `node:sqlite`), pnpm, and Claude Code signed in.

```bash
pnpm install
pnpm dev             # hub (tsx watch) + Vite UI at http://127.0.0.1:5173
pnpm build            # typecheck + build every package
pnpm start            # hub serves the built UI at http://127.0.0.1:7788
pnpm test             # vitest, run before every PR
```

With `pnpm start`, either copy the token URL the hub prints or read the token straight from
`<data>/hub-token`. Debug a subprocess with `POCKETROCKET_DEBUG=1`.

## Desktop app

Building it additionally requires Rust (MSVC toolchain), Visual Studio Build Tools, WebView2
(bundled with Windows 11), and `cargo tauri`.

```bash
pnpm desktop:build      # -> packages/desktop/src-tauri/target/release/PocketRocket.exe
                        #    + bundle/nsis/PocketRocket_<version>_x64-setup.exe
pnpm desktop:dev
```

Node runtime: the desktop app looks for a system Node ≥ 22.13 on `PATH` first; if none is found,
it falls back to a Node 24 LTS binary bundled with the installer. Releasing is described in
[RELEASING.md](RELEASING.md).
