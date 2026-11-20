# Developing Toki

Running from source, building the desktop app, and the layout of the repo. Contribution rules
are in [CONTRIBUTING.md](../CONTRIBUTING.md). macOS and Linux have no installer yet, so this is
also how to run Toki there.

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

### Updater

The shell registers `tauri-plugin-updater` (pinned `=2.12.0`, the last version that accepts the tauri 2.11 this
repo locks; Dependabot ignores it, so bump it by hand together with tauri). Its settings live in
`tauri.conf.json > plugins.updater`: the endpoint
`https://github.com/AlexGaledo/Toki/releases/latest/download/latest.json`, `installMode: "passive"` on
Windows, and `pubkey`.

- **Only Rust can use it.** No capability grants `updater:*` and no `#[tauri::command]` wraps it, so the hub page
  can neither check for nor install an update. Keep it that way.
- **`pubkey` is the real updater public key** (minisign key id `79078A19B0FB7872`, generated 2026-11-18). The
  private key and its password live only on the owner's PC (`~/.tauri/`, backed up) and in the `release`
  environment's secrets, never in the repo. Rotating it means every installed app must be reinstalled by hand,
  so don't.
- **Local builds need no key.** The committed config does not set `bundle.createUpdaterArtifacts`, so
  `pnpm desktop:build` and `cargo tauri build` work without `TAURI_SIGNING_PRIVATE_KEY`; only tag builds turn
  it on (with `--config`). If you turn it on yourself, override it back with
  `cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
- **Tag-build gate:** `src-tauri/src/updater_config.rs` checks the endpoint and the key. With
  `POCKETROCKET_RELEASE_TAG` set, its test fails while the placeholder is still there:
  `POCKETROCKET_RELEASE_TAG=vX.Y.Z cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml updater_config`.
  It is not in `release.yml` yet: the draft/finalize release pipeline adds that call. Until then, run it by hand
  before tagging.

## UI primitives

Shared building blocks live in `packages/web/src/components/ui.tsx`. Use them before writing a local
one. Colours and radii come from the tokens in `index.css`; nothing here adds a new colour or animation.

### Banner

An inline notice that stays in the layout (a toast is for transient events).

```tsx
<Banner tone="warn" title="Hub is slow" action={<Button size="sm" onClick={retry}>Retry</Button>} onDismiss={hide}>
  Replies may be delayed.
</Banner>
```

Props: `tone` (`info` | `warn` | `error`, default `info`), `title`, `children`, `action` (buttons, right side),
`onDismiss` (shows an X button; label via `dismissLabel`), `role` (override), `className`.
A11y: `error` is `role="alert"` (assertive), `info` and `warn` are `role="status"` (polite). Text is always
`--fg`, so AA contrast does not depend on the tone; the tone is in the icon and ring. Mount it
when the condition starts: a live region that is already on screen is not announced.

### Popover

Anchored panel for small forms or detail. Menus are for commands, dialogs for tasks.

```tsx
<Popover>
  <PopoverTrigger asChild><Button size="icon" aria-label="Filters"><Filter size={14} /></Button></PopoverTrigger>
  <PopoverContent align="end">...controls...  <PopoverClose asChild><Button size="sm">Done</Button></PopoverClose></PopoverContent>
</Popover>
```

Exports: `Popover` (supports `open`/`onOpenChange`), `PopoverTrigger`, `PopoverAnchor`, `PopoverContent`, `PopoverClose`.
Radix props pass through (`side`, `align`). A11y: Escape or an outside click closes; focus moves in on open and
returns to the trigger; the trigger gets `aria-expanded`/`aria-controls`. Portaled at `z-[65]` (above dialogs 50,
onboarding 60), so it does not affect layout. Non-modal, unlike `MenuContent`.

### Tooltip

```tsx
<Tooltip content="Search (Ctrl K)"><Button size="icon" aria-label="Search"><Search size={14} /></Button></Tooltip>
```

Props: `content` (plain text; empty renders the child untouched), `children` (one element that takes a ref),
`side` (default `top`), `delay` (ms, default 400). Wrap a region in `TooltipProvider` to share the open delay
between neighbours (optional). A11y: opens on hover and on keyboard focus, never on touch; closes on Escape,
blur or leaving; the trigger gets `aria-describedby`. It describes, it does not name: icon-only controls still
need `aria-label`. Never put interactive content in it (use a Popover). No enter/exit animation, so
reduced motion needs no special case; it is portaled (`z-[70]`), so it cannot shift layout.

### Kbd

```tsx
<Kbd>Esc</Kbd>   <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
```

Props: `children`, `className`. Renders a `<kbd>` (mono, `--card2` fill, `--line` ring), so assistive tech reads the text.
Write modifiers as words (`Ctrl`), not glyphs.

### EmptyState

```tsx
<EmptyState icon={<Inbox size={18} />} title="No routines yet" action={<Button variant="primary" onClick={add}>New routine</Button>}>
  Routines run a bot on a schedule.
</EmptyState>
```

Props: `icon` (decorative, `aria-hidden`), `title`, `children` (body, max 40ch), `action`, `as`
(`div` default, or `h2`..`h4` to put it in the heading outline), `className`. Centred; give the parent the height.

### Skeleton

```tsx
<SkeletonGroup label="Loading bots…">
  <Skeleton className="h-8 w-8" /> <Skeleton className="mt-2 h-3 w-24" />
</SkeletonGroup>
```

`Skeleton` is one block (`--card2`, full radius by default; set size and radius via `className`) that pulses
only under `motion-safe`. It is `aria-hidden`. `SkeletonGroup` is the accessible shell: `role="status"` with an
sr-only `label` (default "Loading…") and the shapes hidden. The local skeletons in `ChatPane.tsx`
(`TranscriptSkeleton`), `Sidebar.tsx` (`SkeletonRows`) and `files/FilesPanel.tsx` (`Skeleton`) can adopt these.

## Content Security Policy

Two surfaces, two policies. The Tauri `csp` in `tauri.conf.json` covers only pages Tauri serves itself: the splash
(`ui/index.html`) and the Server terminal (`ui/terminal.html`). The main window navigates to the hub on
`http://127.0.0.1:<port>` after the splash, and Tauri does not inject a CSP into a remote page, so the hub's web UI
gets its own header from the hub (`packages/hub/src/api/csp.ts`, set on the SPA shell and static assets only).

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

Hub web UI (sent by the hub as the header below; derived from `packages/web` sources and a production build, which
loads no third-party script, font, image or stylesheet; Supabase is called by the hub, not by the page):

```
default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self';
connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:; object-src blob:;
worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- `script-src`: the theme/font snippet moved out of `web/index.html` into `packages/web/public/theme-init.js` (served as `/theme-init.js`, revalidated like the shell). Keep new code in files; never `unsafe-inline`. `unsafe-eval` is not needed.
- `style-src 'unsafe-inline'`: React `style={}` attributes and Radix inject styles.
- `img-src data: blob:`: SVG previews are `data:` URLs in an `<img>`, chat and file images are `blob:` URLs.
- `media-src blob:`: Files preview plays audio and video from a `blob:` URL.
- `connect-src 'self'`: `/api/*` and the `/ws` WebSocket on the same origin (the loopback hub, an SSH tunnel to it, or the phone's HTTPS origin). `ipc:` and `http://ipc.localhost` are for the notification call in the desktop app.
- `frame-src 'self' blob:`: the Screen tab frames `/screen/` on the same origin, and the Files preview frames a PDF from a `blob:` URL.
- `object-src blob:`: Chromium's PDF viewer embeds the blob; `'none'` may blank the PDF preview. Not verified in a browser, so it stays until someone checks.
- `worker-src 'self'`: `/sw.js` for Web Push.
- `frame-ancestors 'none'`: nothing may frame the app. Send the header (a meta tag cannot carry this directive).

Mode: `POCKETROCKET_CSP=enforce|report-only|off`, default `report-only` until a browser run of the production build is clean (flip the default in `csp.ts` then). `report-only` sends the same policy as
`Content-Security-Policy-Report-Only` (the browser console lists violations, nothing is blocked); `off` sends no CSP.
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` go on the same responses in every mode. File, media,
auth-callback and `/screen/*` responses keep their own headers and are not touched.

Known effect: a `blob:` HTML preview inherits this policy, so inline `<script>` in a previewed HTML file does not run
(static HTML and CSS still render). `FilePreview.tsx` frames that blob without `sandbox`; adding one is a web change.

Neither policy has been run against a live window yet: the hub policy is covered by unit tests on the headers
(`api/csp.test.ts`) but a browser run of the production build (violations, Screen tab, PDF preview) has not been done.
If you see a blank page or a broken preview, read the console for `Content-Security-Policy-Report-Only` violations; `POCKETROCKET_CSP=enforce` turns blocking on.
