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
