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

The hub does not print its token, because its output ends up in logs. Read it from `<data>/hub-token`
and paste it into the prompt the UI shows, with `pnpm start` and on the Vite dev server alike, or open
`http://127.0.0.1:7788/#token=<token>`. Debug a subprocess with `POCKETROCKET_DEBUG=1`.

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

## Content Security Policy

Two surfaces, two policies. The Tauri `csp` in `tauri.conf.json` covers only pages Tauri serves itself: the splash
(`ui/index.html`) and the Server terminal (`ui/terminal.html`). The main window navigates to the hub on
`http://127.0.0.1:<port>` after the splash, and Tauri does not inject a CSP into a remote page, so the hub's web UI
needs its own header (not implemented yet, see the checklist).

Bundled pages (`tauri.conf.json`, same string for dev because there is no dev server):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self';
connect-src ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'
```

- `default-src 'self'`: the fallback. Both pages load only from the app's own origin (xterm lives in `ui/vendor/`).
- `script-src 'self'`: no `unsafe-inline`, no `unsafe-eval`. The page scripts were moved out of the HTML into `ui/splash.js` and `ui/terminal.js` for this; keep new code in files, and use no inline `onclick=`.
- `style-src 'self' 'unsafe-inline'`: both pages have an inline `<style>`, and xterm's DOM renderer adds `<style>` elements from script. Style-only, so the risk is small; tightening it needs the styles moved to files plus a nonce for xterm.
- `img-src 'self'`, `font-src 'self'`: the splash logo is inline SVG and nothing loads a web font or image.
- `connect-src ipc: http://ipc.localhost`: only Tauri's own command channel (`invoke`). The pages make no `fetch`, WebSocket or XHR; the splash talks to Rust, and Rust talks to the hub.
- `object-src 'none'`, `frame-src 'none'`: no plugins, no frames.
- `base-uri 'none'`, `form-action 'none'`: no `<base>` tricks, no form posts.

Hub web UI (what to send as a header from the hub; derived from `packages/web` sources and a production build, which
loads no third-party script, font, image or stylesheet; Supabase is called by the hub, not by the page):

```
default-src 'self'; script-src 'self' 'sha256-<hash of the inline theme snippet in web/index.html>';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self';
connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:; object-src blob:;
worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- `script-src`: the only inline script is the theme/font snippet in `web/index.html`. Either hash it or move it to `/theme-init.js`; never `unsafe-inline`. `unsafe-eval` is not needed.
- `style-src 'unsafe-inline'`: React `style={}` attributes and Radix inject styles.
- `img-src data: blob:`: SVG previews are `data:` URLs in an `<img>`, chat and file images are `blob:` URLs.
- `media-src blob:`: Files preview plays audio and video from a `blob:` URL.
- `connect-src 'self'`: `/api/*` and the `/ws` WebSocket on the same origin (the loopback hub, an SSH tunnel to it, or the phone's HTTPS origin). `ipc:` and `http://ipc.localhost` are for the notification call in the desktop app.
- `frame-src 'self' blob:`: the Screen tab frames `/screen/` on the same origin, and the Files preview frames a PDF from a `blob:` URL.
- `object-src blob:`: Chromium's PDF viewer embeds the blob; `'none'` may blank the PDF preview. Verify before tightening.
- `worker-src 'self'`: `/sw.js` for Web Push.
- `frame-ancestors 'none'`: nothing may frame the app. Send the header (a meta tag cannot carry this directive).

Neither policy has been run against a live window yet (see the checklist rows).
