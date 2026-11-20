# Toki canvas UI across the app

Status: draft spec, 2026-11-20. Design source: `ui-concepts-2026-11-19/concept-h5Canvas.html` ("Harbor · Canvas", approved as "canvas looks good"), with ROUND3/4/5.md, CHAT.md and BRIEF.md from the same folder. Nothing in this spec copies the concept's sample data or the real-data mirror (`build_real.py`/`toki-live.html`); those were read only to see which hub fields each element needs.

## Problem / user story

The owner switches projects all day and forgets where each one stands, so he keeps asking bots for "status". He also has too many rooms and bots in view. Today's sidebar is built around bots and group chats (`packages/web/src/components/Sidebar.tsx:262-310`). Projects exist on the hub (`GET /api/projects`, `packages/hub/src/api/projects.ts:22-33`), but the web app only shows them in Settings › Projects (`components/settings/ProjectsSection.tsx:22`).

> As the owner, I open the app and see what needs me, which project I was in, and where each project stands (stage, next step, map), without leaving the sidebar → chat → right panel flow I already know.

The owner's words: "fully implemented in all pages whilst maintaining the vibe / ux relevance of the existing app so I won't be shocked."

## Scope

**In**
- Every screen in `packages/web/src`, restyled with today's tokens and primitives (the inventory is below).
- A project-first sidebar with "Needs you" pinned on top.
- A project header with stage pips and Chat | Map tabs.
- A right-panel overview: Needs you, Bots, and Next, Rooms and Done as icons, with a 56px icon rail.
- A project map canvas: a system map for software projects and a roadmap for everything else.
- A "New layout" toggle while the work is in progress.
- Minimal hub additions: a map file and schema, a project overview parsed from `current.md`, and a `projects.changed` event.

**Out (deliberately)**
- **The rename to "Toki".** The concept's copy says Toki, but this spec keeps "PocketRocket" (an open question).
- **The concept's seven colour themes** (`themes.js`). The app keeps its light, dark and system themes (`packages/shared/src/providers.ts:225`).
- **Editing the map by hand** (the add-node and link tools). In v1 the owner changes the map by asking a bot.
- **Ticking off "Decision" items** that come from `current.md`. That would mean the UI writing the owner's project file.
- **A new chat transcript look.** The transcript keeps its bubbles, column width (`--page-max: 800px`, `index.css:83`) and cards.
- **Approve buttons outside the chat card** (see Security).

## Design

### Principles applied
- **Same shell.** `App.tsx:165-240` keeps its three panes, its resize separators (`PaneSeparator`), its phone drawers and Ctrl+B (`App.tsx:103-117`). Only what is inside the panes changes.
- **Same names in the same places.**
  - "Needs you" stays the name of the waiting pin and page. The concept calls it "Waiting"; the owner decides (Q1).
  - The Tasks and PC sessions rows stay under it.
  - Search and New stay top right of the sidebar. The profile menu and Pair a phone stay at the bottom.
  - Files and Screen stay as header buttons that open the right panel.
- **One accent, one attention colour.**
  - `--accent` takes the concept's `--pr-a` role: active item, current stage, map nodes and the focus ring.
  - The existing `--warn` takes the `--pr-alert` role, and only for things that need the owner (counts, cards that need the owner, unread dots on Needs you).
  - The concept's `--pr-b` (edges, done stages) maps to the neutrals `--faint` and `--line2`, so there is still one accent.
- **Three motion effects** (`index.css:197-223`). The map adds no keyframes:
  - Active edges are dashed and accent-coloured, but static.
  - The focus sphere is a static SVG wireframe.
  - The `.chip-running` shimmer stands for "a bot is generating the map".
  - Transitions (opacity, transform) are allowed under `motion-safe:`.

### UX flow
1. **Launch.** The app opens the last active room, as it does today. If that room is a project's room (`ProjectInfo.roomId`, `lib/api.ts:67`), the centre shows the project header and the right panel shows that project's overview.
2. **Sidebar** (top to bottom):
   - The brand row (same buttons).
   - The **Needs you** pin, with its warn count.
   - Tasks and PC sessions.
   - The provider chip.
   - **Projects**: each row has a dot, the name, then either a warn count of open items or a mono `done/total` hint. The active project expands to show its room (`# name`) and that room's bots, with the existing collapse toggle.
   - **Rooms**: group rooms with no project, laid out as today.
   - **Bots**: the podium and solo bots, as today.
   - "Show paused (n)", then the profile and Pair a phone.
   - Paused bots and rooms with no live member are hidden until "Show paused" is pressed.
3. **Project header.**
   - Left: the project name at `text-title` 20px, then the stage pips with the stage name and `done/total`, or "No plan yet".
   - Right: **Chat | Map** tabs (the `TabsList`/`TabsTrigger` primitives, `ui.tsx:306-325`).
   - A slim second row keeps today's room line: `# room`, the member faces, a small "map" chip, then the group details, Files and Screen buttons in today's order.
4. **Map tab** (a page over the chat, so the draft and scroll position wait underneath, as with every page today, `App.tsx:186-191`):
   - A pan and zoom canvas with a dot grid, node cards and curved edges.
   - A floating toolbar pill: select, fit, zoom %, regenerate.
   - A prompt bar: "Ask @lead to change the map…". Nodes you click become removable chips in it.
   - Clicking a node focuses it: an accent ring, a faint sphere behind it, and action bubbles for "Ask about it" (adds a chip and focuses the prompt) and "Details" (label, tech and group).
   - A Map | List switch gives a keyboard and screen-reader view, the same pattern as WorkflowPage's Canvas | Steps.
   - Below 640px the map is read-only: pan and pinch only, as `WorkflowCanvas.tsx:9` does today.
5. **No map yet.** An empty canvas says "No map yet" with a **Generate map** button.
   - The button opens a popover:
     - which bot to ask (the room's coordinator, else its first member that isn't paused);
     - which kind: System map, or Roadmap (System map is the default when `GET /api/projects/:slug/repos` lists a repo);
     - the note "Uses one turn of @x in # room".
   - Confirming sends an ordinary message to the project room. While that bot is working in that room (real status from `useBotStatus`), the canvas shows "@x is reading the project…" with the `.chip-running` shimmer.
   - On that bot's `turn.end` in the room (`shared/src/protocol.ts:46`), the web refetches the map.
   - If there is still no valid map, the canvas says "No map was made" with the hub's validation error and an "Open chat" link.
   - Nothing is faked.
6. **Right panel overview.** It is a new `panelKind: 'overview'`, open by default at 1280px and wider in the new layout. Its sections, in order:
   - **Needs you** (this project's or this room's items, as cards);
   - **Bots** (this project's members, with "Show paused");
   - an icon row for **Next**, **Rooms** and **Done** that opens small panes.
   - A collapse button turns the panel into a 56px rail of icons with counts.
   - Files and Screen open in the panel as they do today. Closing them goes back to the overview instead of an empty slot.
   - The screen's glance thumbnail logic (`lib/screenView.ts`) does not change.
7. **No project** (a DM, or a room with no project). The overview shows that room's Needs you items and its bots. The Next, Rooms and Done icons are hidden.
8. **Phone (<768px).**
   - The sidebar stays the drawer (`App.tsx:249-279`) and the panel stays a full-window cover (`App.tsx:197-218`).
   - The project header wraps: the tabs go full-width under the title.
   - A "Needs you n" chip in the header opens the overview as the cover.
   - The concept's stacked single-column layout is **not** used. Keeping today's drawers is what makes the new layout feel familiar.

### Data and protocol (what exists, what is missing)

| Needed by | Exists today | Missing |
|---|---|---|
| Sidebar projects tree | `GET /api/projects` → `ProjectInfo {slug,name,dir,memberIds,roomId,templateVersion,createdAt}` (`lib/api.ts:67,161-168`) | A web store slice, and a WS event when projects change (none exists; create emits only `bots.changed`/`rooms.changed`, `api/projects.ts:54-55`) → **B1** |
| Stage pips, Next, Done, decisions | `current.md` in each project folder (`services/ProjectService.ts:126`), read by bots | A parsed overview → **B3**. Until it lands, the UI shows "No plan yet" and hides Next and Done |
| Needs you cards | `useInbox()` (`lib/useInbox.ts:7`): approvals, takeovers, skills, forms, workflow and limit cards, each with a `roomId` (`lib/inbox.ts:13-45`) | Nothing for project or room items. Filter by `roomId === project.roomId` |
| Bot status | `useBotStatus()` (`lib/botStatus.ts:12`: needs_you, paused, working, …) | Nothing |
| Map | The project folder can already be written by bots in the project room without a card (`docs/project-folders.md`, "Access"). The workflow canvas already ships React Flow as a lazy chunk (`workflows/WorkflowCanvas.tsx:1-9`), and CI guards that it stays lazy (`scripts/bundle-budget.mjs:1-15`) | A map file schema and a read endpoint → **B2**. A skill that tells a bot how to write the map → **B4** |
| Map refresh | `turn.end {roomId, botId}` | Nothing. `files.changed` fires only for writes made through the API (`api/files.ts:168`), not for bot tool writes, so refetch on `turn.end` in the project room instead |
| Paired phone | `/api/projects` is not in `DEVICE_ALLOW` (`api/guard.ts:323`) | Nothing. On a paired device the sidebar falls back to today's grouping (Q7) |

**Map file:** `data/projects/<slug>/map.json`. It is local, visible and editable in Files, and needs no database. The schema, `ProjectMapSchema` in `packages/shared/src/projectMap.ts`, is defined in task B2:

```ts
{ version: 1, kind: 'architecture' | 'roadmap', generatedBy: string /* handle */, generatedAt: string /* YYYY-MM-DD */,
  nodes: { id: string /* ≤40 */, label: string /* ≤40 */, tech?: string /* ≤60 */, group?: string /* ≤20, e.g. client|core|data|ai|infra */,
           state?: 'done' | 'now' | 'next' /* roadmap */ }[] /* ≤60 */,
  edges: [from: string, to: string, state?: 'active' | 'off'][] /* ≤120 */ }
```

The bot never writes coordinates. The web lays nodes out the same way every time (`lib/mapLayout.ts`, ported from the concept's `build()`):
- Architecture: one column per group, ordered client → core → data → ai → infra, with the most-connected nodes in the middle.
- Roadmap: a left-to-right zigzag.

**Overview** (`GET /api/projects/:slug/overview`), parsed from `current.md` with no AI turn (task B3):

```ts
{ updated: string | null,             // front-matter `updated:`
  plan: { done: number; total: number; stage: string | null } | null,  // `- [x]`/`- [ ]` boxes; stage = nearest ## heading above the first unticked box
  next: string | null,                // first bullet under a heading matching /^next/i
  done: string[],                     // last 3 bullets under /^done|shipped/i
  waiting: string[] }                 // bullets under /^waiting on (me|owner|you)/i
```

### Security against the principles
- **Local-first.** The map and overview are files on the owner's hub, read over the existing authenticated REST. Nothing goes to Supabase or any cloud.
- **Safe by default.**
  - Overview cards offer **Review** (opens the room and scrolls to the full card) and **Deny** only where `rowMayDeny` allows it (`lib/inbox.ts:53-58`), exactly like `InboxPage.tsx:103-104` today.
  - Allow and Always stay on the chat's `ApprovalCard` (`ChatPane.tsx:597`). The concept's inline **Approve** is not built (Q4).
  - Generate map and the prompt bar send ordinary messages, so approvals, hop and cause caps, and per-turn budgets all apply.
  - No bot tool is added. The new endpoints are read-only.
- **Bot-written content.** `map.json` and `current.md` text is rendered as plain text, never as Markdown, HTML or links. It is validated with zod and capped (64 KB for the file, 60 nodes, 120 edges). An invalid file shows the error instead of a partial map.
- **Cost-aware.** Generate and Regenerate say "Uses one turn of @x" before sending. Nothing runs automatically: no auto-generation and no polling turns.

## Page inventory

"Now" is today's code. "Becomes" is the new layout. "Stays" is what must not change.

| # | Surface (files) | Now | Becomes | Stays | Phase |
|---|---|---|---|---|---|
| 1 | App shell (`App.tsx:165-240`, `lib/panes.ts`) | Sidebar, chat and an optional screen/files panel; pages lie over the chat | Same three panes. The panel slot defaults to the overview at ≥1280px. `PANES.overview` (def 300, min 260, max 420) is added | Separators, Ctrl+B, auto-close at breakpoints, focus handling, popout | 2 |
| 2 | Sidebar (`Sidebar.tsx`, `Podium.tsx`) | Needs you, Tasks and PC sessions rows, the needs-you bot list, podium, solo bots, groups with their bots | Needs you pin (bordered, warn count) → Tasks, PC sessions → **Projects** tree (project → `# room` → bots) → Rooms → Bots (podium and solo) → "Show paused (n)" | Search, New menu, BotRow (avatar ring, status line, unread dot, settings and popout on hover), collapse state per device (`COLLAPSED_KEY`), the needs-you bot list, the drawer on phone | 1 |
| 3 | Profile menu (`ProfileMenu.tsx`) | Bottom of the sidebar: Automations, Usage, Settings, theme | Same, plus optional thin usage meters above it (`Meter`, `ui.tsx:422`, from `useLimits`) when limits exist | All menu items and their order | 1 |
| 4 | Chat header (`ChatPane.tsx:104-155`) | Room avatar, name, badges, member line, faces, buttons | Project room: the new `ProjectHeader` (title, pips, Chat \| Map tabs) above a slim room line. Other rooms: same header, title restyle only | Badges (coordinator, held, queue paused, on backup), context meter in DMs, Files and Screen toggles and their order | 2 |
| 5 | Transcript (`ChatPane.tsx:189-720`, `WorkLine.tsx`, `Cards.tsx`, `QueueChips.tsx`) | Grouped messages, user bubble, tool lines, approval, handoff and form cards | Small touches only: an "ask" (form) card gets the warn left edge like overview cards, and system lines are quieter | Bubble colours (`--user`), 800px column, Markdown, cards' own buttons | 6 |
| 6 | Composer (`ChatPane.tsx:730-1240`) | Textarea, send modes, model and permission pickers | The group placeholder becomes "Message @bot or the room…", the mention popup is restyled, and a docked composer is reused on the Needs you page | Enter / Shift+Enter / Ctrl+Enter (`lib/delivery.ts:59`), pickers, radius `--r-composer`, the other branch's attachments and slash commands | 6 (after the composer branch) |
| 7 | Chat empty states (`ChatPane.tsx:53-86`) | "Pick a bot to start", "Your team is empty" | With projects and no room open: "Pick a project or a bot". Otherwise the same copy, using `EmptyState` (`ui.tsx:569`) | RocketMark, Create a bot / New group chat buttons | 5 |
| 8 | Screen panel (`RightPanel.tsx`, `ComputerControl.tsx`, `TeachControls.tsx`) | The screen only: glance, watch, focus | Unchanged inside. Its close button returns to the overview | Everything (iframe stays mounted, `App.tsx:195-218`) | 2 |
| 9 | Files panel (`files/FilesPanel.tsx`, `FilePreview.tsx`) | Room folder browser in the panel | Unchanged inside. Its close button returns to the overview. `map.json` gets a "Show on map" link in the preview | Everything | 2 |
| 10 | **Project overview panel** (new `components/overview/OverviewPanel.tsx`) | — | Needs you cards → Bots → Next / Rooms / Done icons, with a 56px rail mode | — | 2 |
| 11 | **Project map** (new `components/map/*`, page `{kind:'map', slug}`) | — | Canvas, toolbar, prompt bar, chips, focus sphere, Map \| List, "No map yet" / generating / error states | — | 3 |
| 12 | Needs you page (`InboxPage.tsx`) | A flat list of rows | Grouped by project ("Other rooms" last) with project headers "Open project →", plus a docked composer (phase 6) | Row actions (Review/Open, Deny only where allowed), workflow and limit cards answered on the row (`InboxPage.tsx:40-46`), empty-state copy | 4 |
| 13 | Tasks (`TasksPage.tsx`) | One room's four-column board | `PageHeader` restyle. In a project room, the board shows under the project header | Columns, select-based status, `task.changed` refresh | 4 |
| 14 | PC sessions (`PcSessionsPage.tsx`, `PcSessionViews.tsx`, `PcMovePanel.tsx`, `PcSyncPanel.tsx`, `PcRunForm.tsx`) | List by repo → transcript | `PageHeader` restyle. Repo groups use the sidebar's section label style | Read-only behaviour, Move/Sync/Run flows | 4 |
| 15 | Bot page (`BotPage.tsx`, `TrainingSection.tsx`, `SkillVersions.tsx`, `SkillGitImport.tsx`, `VoicePanel.tsx`, `TriggersSection.tsx`) | Takes over the main pane: Memory, Skills, Automations, Computer tabs | `PageHeader` with the bot's avatar and status. Tabs use `TabsList` | Tabs, their order, the back arrow | 4 |
| 16 | Automations and Usage (`FleetPages.tsx:17-60`) | `FleetHeader` + `PageBody` | `FleetHeader` becomes `PageHeader` (same title position, 20px title, muted subline) | Content and sections | 4 |
| 17 | Workflow page (`workflows/*`) | React Flow canvas \| Steps, inspector, run panel | Shares the map's canvas tokens (`.wf-canvas` → `.pr-canvas` variables) so both canvases match | Editing model, lazy chunk | 4 |
| 18 | Settings (`dialogs/SettingsDialog.tsx`, `settings/*`) | A wide dialog with a section list (`SettingsDialog.tsx:46-67`) | The section list gets the sidebar's row style. Appearance gains **New layout** (phases 1-6). Projects gets "Open project" and "Map" links | Sections, their order, the remembered last section, device-only sections | 1 (toggle), 5 (restyle) |
| 19 | Dialogs (`BotDialog`, `RoomDialog`, `SearchDialog`, `PodiumDialog`, `ProfileDialog`, `BotFileDialogs`, `ConfirmDialog` in `ui.tsx:170`) | `Dialog`/`DialogShell` | Token-only restyle (radius `--r-xl`, `--shadow-lg`). Search hits show a project label | Fields, validation, Escape handling (`App.tsx:111-113`) | 5 |
| 20 | Onboarding, sign-in, token (`Onboarding.tsx`, `AccountSignIn.tsx`, `SignInToApprove.tsx`, `TokenPrompt.tsx`) | A full-screen overlay with steps | Token-only restyle. The last step mentions projects and the map | Steps, sounds, copy order | 5 |
| 21 | Hub status and toasts (`App.tsx:285-368`) | Pill or card at the top, toasts bottom right | Unchanged. Toast offset clears the prompt bar on the map | Behaviour | 3 |
| 22 | Popout window (`PopoutShell.tsx`) | One bot's chat in its own window | Unchanged. The new layout is never used in a popout | Everything | — |
| 23 | Phone (<768px) | Sidebar drawer, panel covers the window | Same, plus a "Needs you n" header chip that opens the overview as the cover, and the project header wraps | Drawers, 44px touch targets (`index.css:243-252`), 16px inputs | 1-3 |
| 24 | Workflow and limit cards in chat (`WorkflowCard.tsx`, `FailoverCard.tsx`) | `ActionCard` | Reused as-is inside the overview's Needs you list | Answered only on their own buttons | 2 |

## Design tokens and primitives (reuse first)

**Tokens** (`packages/web/src/index.css`). They are added once, with a `.dark` value for each, and are the same in both layouts.

| Token | Value | Why |
|---|---|---|
| `--needs` | `var(--warn)` alias, exposed as Tailwind `needs` | Names the "owner needed" role so a reviewer can check it with grep (`text-needs`, `bg-needs`, `ring-needs`). New code uses `needs`, never `warn`, for owner items |
| `--canvas` | light `var(--bg)`, dark `#181817` | Map and workflow canvas surface; light stays "paper", never a dark box |
| `--canvas-dot` | `var(--line)` | React Flow `Background` dots (already used in `WorkflowCanvas.css:6-9`) |
| `--node` | `color-mix(in oklab, var(--card) 92%, transparent)` | Map node card |
| `--node-line` | `color-mix(in oklab, var(--accent) 40%, var(--line))` | Node border, port dots |
| `--edge` | `var(--faint)` | Edges (3:1 shape contrast, never text) |
| `--glow` | `0 0 22px -8px color-mix(in oklab, var(--accent) 55%, transparent)` | Node and focus glow. Static, so not a motion effect |

There are no new fonts or type sizes: the existing seven-step scale (`index.css:143-152`) already matches ROUND5's list. Map labels use `font-mono text-label lowercase`.

**Primitives** (`ui.tsx` unless noted):

| Primitive | Status | Use |
|---|---|---|
| `Badge tone="warn"` (`ui.tsx:398`) | Reuse, add `tone="needs"` (same look) | Needs you counts |
| `ActionCard` (`ui.tsx:499`) | Reuse, add `edge` prop (3px left border in `--needs`, `--line` once done) | Overview and Needs-you cards, ask cards |
| `TabsList` / `TabsTrigger` (`ui.tsx:306-325`) | Reuse, add `variant="underline"` (2px accent underline, as in the concept) | Chat \| Map, Bot page tabs |
| `Meter` (`ui.tsx:422`) | Reuse, add `size="thin"` (3px) | Sidebar usage meters |
| `EmptyState` (`ui.tsx:569`) | Reuse | No map yet, no project, all clear |
| `Tooltip`, `Popover`, `Menu`, `Button`, `Avatar`, `Kbd` | Reuse as-is | Rail icons, Generate popover, node details |
| `Chip` | **New**: 28px pill, `bg-card2`, optional leading avatar or dot, optional remove ×, `aria-label` on the remove button | Map node chips, room chip on the dock composer, "map" chip in the room line |
| `StagePips` | **New**: 14×4px bars; done `--line2`, current `--accent`, next `--line`; text after it; "No plan yet" when null | Project header, sidebar tooltip, Needs-you group header |
| `SectionLabel` | **New**: `text-label text-dim` heading row with an optional count | Sidebar, overview, Settings list |
| `IconRailButton` | **New**: 40px square, `aria-pressed`, corner count badge | Overview rail and the Next / Rooms / Done row |
| `PageHeader` (`components/PageHeader.tsx`) | **New**: replaces `FleetHeader` (`FleetPages.tsx:25`) with the same props plus optional `leading` and `tabs` | Every page over the chat |

## The project map

### Rendering (web)
- `components/map/ProjectMap.tsx` is loaded with `React.lazy`, in the same chunk family as `WorkflowCanvas`. React Flow (`@xyflow/react` 12.12.1, already a dependency):
  - `Background variant=Dots` coloured with `--canvas-dot`;
  - `fitView`, the wheel and pinch zoom, and dragging empty space to pan (all built in);
  - nodes not draggable and not connectable.
- **Node** (`MapNode.tsx`):
  - a 156px rounded card (`--r-lg`) with a lowercase mono label and a mono `text-hint` tech line;
  - four port dots, shown on hover and focus only;
  - roadmap states: `done` in `--line2`, `now` with an accent border, `next` dashed and muted.
- **Edge**: React Flow's `getBezierPath` in `--edge` at 1.2px. `active` edges are accent and dashed (no animation); `off` edges are dotted and muted.
- **Focus.** A clicked node, or Enter on a focused node, sets the focus:
  - a static SVG wireframe sphere (three ellipses and a circle, `--accent` at 25%) behind the node, in its own node layer;
  - two action bubbles on the node, "Ask about it" and "Details" (a Popover);
  - Escape clears the focus.
- **Toolbar** (`MapToolbar.tsx`): a floating pill at the top centre with Select, Fit (`fitView`), zoom % and Regenerate. Each button has an `aria-label` and a Tooltip.
- **Prompt bar** (`MapPrompt.tsx`): a single-line input with chips above it, sending with Enter.
  - The text is sent to the project room as `@<lead> <text>`, followed by `(map: <chip labels>)` when there are chips.
  - The owner stays on the map, and a toast "Sent to # room. Open chat" confirms it.
- **List view** (`MapList.tsx`): groups (or milestones), then nodes and their edges as text. This is the accessible view and the default under 640px.
- **States**: loading (Skeleton), no map yet, generating (the shimmer, keyed on the chosen bot's working status in the room), invalid (the error text from B2), and ready.

### Hub work for the backend owner (minimal, listed separately)
- **B1.** Emit `{ type: 'projects.changed', projects: ProjectInfo[] }` after create, members, room and delete in `api/projects.ts`, and add it to the `ServerEvent` union in `shared/src/protocol.ts`.
- **B2.** `shared/src/projectMap.ts`: `ProjectMapSchema` (above), exported from `shared/src/index.ts`. `GET /api/projects/:slug/map` → `{ map: ProjectMap | null, error: string | null, mtime: number | null }`, which reads `<dir>/map.json`:
  - over 64 KB → error "map.json is too large";
  - invalid → error naming the first issue;
  - edges that point at missing nodes are dropped, and the reply says how many.
- **B3.** `GET /api/projects/:slug/overview` (shape above), a pure parser in `services/projectOverview.ts` with unit tests over sample `current.md` texts.
- **B4.** A pool skill `project-map` (SKILL.md: when asked for the map, read the repo or `current.md`, write `map.json` in this chat's folder per the schema, keep it to 30 nodes or fewer, no secrets or paths). Seed it the way the existing pool skill `safe-shipping` reaches clones, and add it to the template list next to it (`services/devTeamTemplate.ts:21`). It loads on demand, so it adds no per-turn prompt cost. Today no skill ships with the hub (`safe-shipping` is referenced by id only, `permissions/shipGuard.ts:6`), so the backend owner picks the seeding mechanism and says which in the PR.

The hub needs no new bot tool, database table or WS event beyond B1.

## Tasks

| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| B1 | pr-backend | `hub/src/api/projects.ts`, `shared/src/protocol.ts` | `projects.changed` event after every project write | Create, members, room and delete each emit once with the full list | Vitest in `api/projects.test.ts` |
| B2 | pr-backend | `shared/src/projectMap.ts`, `shared/src/index.ts`, `hub/src/api/projects.ts`, `hub/src/services/ProjectService.ts` | Map schema and `GET …/map` | Missing → `{map:null,error:null}`; >64 KB, bad JSON and schema errors → `error`; dangling edges dropped; 404 for an unknown slug; device token refused | Vitest: schema cases plus endpoint cases |
| B3 | pr-backend | `hub/src/services/projectOverview.ts` (new), `hub/src/api/projects.ts` | `GET …/overview` parser | Checklist counts; stage = heading above the first unticked box; `next`, `done` (last 3), `waiting`; `plan:null` with no checkboxes; no file → all null or empty | Vitest with 6 or more `current.md` fixtures |
| B4 | pr-backend | skill seeding (backend owner picks the place), `hub/src/services/devTeamTemplate.ts` | `project-map` skill on template clones | A new team-template project's lead has the skill; a test turn writes `map.json` that passes B2 | Vitest for the template; one manual turn |
| W1 | pr-design-system | `web/src/index.css`, `web/src/components/ui.tsx` | Tokens (`--needs`, canvas set); `Badge needs`, `ActionCard edge`, `TabsList underline`, `Meter thin`, new `Chip`, `StagePips`, `SectionLabel`, `IconRailButton` | No visual change to existing screens; AA contrast for every new text pair in both themes | `pnpm -r test`, tsc; contrast check of the new pairs |
| W2 | pr-design-system | `web/src/lib/layout.ts` (new), `web/src/main.tsx`, `settings/AppearanceSection.tsx` | `useLayout()`: `'classic' \| 'toki'` stored in `pocketrocket.layout` via `lib/persist.ts`; sets `<html data-layout>` before first paint; Appearance "New layout" Switch | The toggle survives a reload; off = pixel-identical to main | Vitest for `lib/layout.ts`; screenshots off vs main |
| W3 | pr-design-system | `web/src/store.ts`, `web/src/lib/projects.ts` (new) | `projects` slice: load after hello, refresh on B1 (falls back to refetch on `rooms.changed` until B1 lands), `projectOfRoom(roomId)` | Projects available everywhere; a paired device or 403 → `projects: []` with no error toast | Vitest for `lib/projects.ts` |
| W4 | pr-design-system | `web/src/lib/projectTree.ts` (new), `components/Sidebar.tsx` | Project-first sidebar (inventory row 2) when `toki`; classic tree untouched otherwise | Every project, room and bot reachable; paused and empty hidden behind "Show paused (n)"; keyboard order matches the visual order; drawer closes on pick | Vitest for `projectTree.ts`; manual Tab walk; 4 screenshots |
| W5 | pr-design-system | `components/ProjectHeader.tsx` (new), `components/ChatPane.tsx` (lines 104-155 only) | Project header plus the room line; Map tab placeholder ("No map yet", Generate disabled until W8) | Non-project rooms unchanged; badges and buttons in their old order; header wraps on phone | Screenshots; Vitest render test for the header |
| W6 | pr-design-system | `lib/panes.ts`, `store.ts` (`panelKind: 'overview'`, `overviewRail`), `App.tsx`, `components/overview/*` (new) | Overview panel and rail; Screen/Files close returns to the overview | Default open at ≥1280px in `toki`; the screen iframe never remounts (no new ticket in the network log); Review opens the room and scrolls to the card; Deny only where `rowMayDeny` | Vitest for `paneLayout` with overview; manual screen test; screenshots |
| W7 | pr-design-system | `lib/mapLayout.ts` (new), `components/map/*` (new, lazy) | Map canvas, nodes, edges, focus sphere, toolbar, List view | Same input → same positions; entry chunk free of xyflow; reduced motion → no animation at all; Tab reaches every node | Vitest for `mapLayout`; `node scripts/bundle-budget.mjs`; screenshots |
| W8 | pr-design-system | `components/map/GenerateMap.tsx`, `components/map/MapPrompt.tsx`, `lib/api.ts` | Generate popover, prompt bar and chips, refetch on `turn.end` for the project room, all states | Sends one ordinary message; shows "generating" only while the real bot status is working; invalid map → error state; no fake data anywhere | Manual against a real hub with B2 and B4; Vitest for the message builder |
| W9 | pr-design-system | `components/PageHeader.tsx` (new), `FleetPages.tsx`, `InboxPage.tsx`, `TasksPage.tsx`, `PcSessionsPage.tsx`, `BotPage.tsx`, `workflows/WorkflowPage.tsx`, `workflows/WorkflowCanvas.css` | PageHeader everywhere; Needs you grouped by project; shared canvas variables | Every page keeps its title, actions and back arrow in place; inbox actions unchanged | Existing tests pass; screenshots of each page |
| W10 | pr-design-system | `dialogs/*`, `settings/*`, `Onboarding.tsx`, `AccountSignIn.tsx`, `SignInToApprove.tsx`, `TokenPrompt.tsx`, `ChatPane.tsx` (empty states 53-86 only) | Token-level restyle, Settings list rows, empty states | No change to fields, steps or copy except where listed; Escape and focus return still work | `pnpm -r test`; manual keyboard pass; screenshots |
| W11 | pr-design-system | `ChatPane.tsx` (Composer and mention popup, transcript ask card), `InboxPage.tsx` | Composer touches and the Needs you dock composer, **rebased on the composer branch** | Attachments and slash commands from that branch still work; Enter, Shift+Enter and Ctrl+Enter unchanged | Existing ChatPane tests; manual send of each kind |
| W12 | pr-design-system | `lib/layout.ts`, `AppearanceSection.tsx`, then classic branches in `Sidebar.tsx`, `App.tsx`, `ChatPane.tsx` | Default `toki`; both layouts stay (owner decision 2026-11-20): a New / Classic picker in Settings › Appearance and a one-click item in the profile menu | Switching works from both places and persists per user | Full test run |
| D1 | pr-planner | `docs/GUIDE.md`, `CHANGELOG.md` `[Unreleased]`, `docs/screenshots/*` | Guide section "Projects, the map and Needs you"; changelog entries per phase; fresh screenshots | Matches the shipped UI | Reviewer read |

## Phases (each one PR, each leaves the app shippable)

The **toggle**: `New layout` in Settings › Appearance. It is stored per browser (`pocketrocket.layout`) and is off by default.
- Phases 1-2: the switch is shown only when `?layout=preview` was opened once, so the owner never meets a half-built shell.
- Phase 3: the switch is visible to everyone, and the owner is invited to try it.
- Phase 7: the default flips to on; the switch stays for one release as "Classic layout", then goes.
- Pages restyled in phases 4-6 are drawn only when the layout is on, so the classic layout stays exactly today's app until phase 7.

Every phase must also pass these checks:
- `pnpm -r test`, tsc, and `node scripts/bundle-budget.mjs`.
- Four screenshots of each changed screen, attached to the PR: 1440×900 dark, 1440×900 light, 390×844 dark, 390×844 light.
- One more screenshot with the toggle off, showing no change from main.
- A keyboard-only pass of the changed screens, and a pass with `prefers-reduced-motion: reduce`.

| Phase | Ships | Tasks | Behind toggle | Extra acceptance | Design reviewer looks at |
|---|---|---|---|---|---|
| 1. Foundations and sidebar | Tokens, primitives, the toggle, projects in the store, the project-first sidebar | W1, W2, W3, W4 (B1 in parallel) | Yes (hidden switch) | Toggle off is identical to main; on a paired phone the sidebar falls back to classic grouping | Does the sidebar read as the same sidebar (same rows, avatars, hover buttons)? Is the warn colour used only on the Needs you count and needs-you rows? |
| 2. Project header and overview panel | Project header (Map tab shows "No map yet"), right-panel overview and rail | W5, W6 (B3 in parallel; pips show "No plan yet" until B3 lands) | Yes (hidden switch) | Screen and Files work exactly as before; panel widths survive a reload; the 1280 and 980px breakpoints behave | Does the overview feel like part of the right panel rather than a new app? Do cards match the chat's ApprovalCard? Do rail icons have tooltips? |
| 3. Project map | Map tab: canvas, generate, prompt bar, list view | W7, W8 (needs B2 and B4) | Yes, switch now visible | A real generated map renders in both themes; light theme shows a paper grid and no dark box | Node and label legibility at 1440 and phone; sphere subtlety; one accent; nothing animates under reduced motion |
| 4. Pages | PageHeader on every page; Needs you grouped by project; Tasks, PC sessions, Bot page, Automations, Usage, Workflow | W9 | Yes | Every page title and action sits where it sits today | Same titles, same action positions, quiet section labels, no new colours |
| 5. Settings, dialogs, onboarding, empty states | Token-level restyle | W10 | Yes | Onboarding completes end to end; every dialog closes with Escape and returns focus | Copy unchanged; radius and shadow consistent with the dialogs |
| 6. Chat and composer | Composer touches, ask card edge, Needs you dock composer | W11 | Yes | **Starts only after the composer branch merges** (see Conflicts) | The transcript still feels identical; the composer height and radius are unchanged |
| 7. Default on, then cleanup | Default `toki`; the classic layout stays as a permanent option (owner decision 2026-11-20); docs and screenshots | W12, D1 | Default on (escape hatch for one release) | The owner has used phases 1-6 for at least one week and said yes (Q6) | Full-app pass with the vibe guardrails |

## Order and dependencies

```
B1 ─┐            B3 ─┐                 B2 + B4 ─┐
W1 → W2 → W3 → W4 (P1) → W5 → W6 (P2) → W7 → W8 (P3) → W9 (P4) → W10 (P5) → [composer branch merged] → W11 (P6) → W12 + D1 (P7)
```

- The backend tasks run in parallel with the web phases. Each web phase degrades gracefully if its B-task is late: no event means refetch, no overview means "No plan yet", no map endpoint means "No map yet" with Generate disabled.
- W9 and W10 do not depend on each other and can swap order.

## Conflicts

- **The composer branch** (attachments, video, slash commands) is changing `ChatPane.tsx`'s `Composer` (`ChatPane.tsx:730-1240`). Until it merges:
  - Phases 1-5 must not touch `ChatPane.tsx` below line 158.
  - W5 edits only the header block (lines 104-155) and moves it into `ProjectHeader.tsx`/`ChatHeader.tsx`.
  - W10 edits only the empty states (lines 53-86).
  - If the composer branch merges first, W5 and W10 rebase. The hunks don't overlap, so the rebase is mechanical.
- **All composer and mention work is W11 (phase 6).** It starts from main after the composer branch merges, and reuses that branch's attachment chips as the dock composer's chips.
- **`App.tsx` and `store.ts`** are touched by W2, W3 and W6. Merge those phases in order; don't run them in parallel worktrees.

## Vibe guardrails (the design reviewer applies these to every phase)

1. **Typography.**
   - The font is still Google Sans or Figtree as set. Mono (Geist Mono) appears only in code, commands, map labels and counts.
   - Sizes come only from the seven-step scale (`index.css:143-152`).
2. **Colour.**
   - Only existing tokens and the canvas set above; no hex values in components.
   - One accent.
   - `needs`/`warn` appears only on things waiting for the owner. Grep the diff for `warn`/`needs` and justify each use.
3. **Themes.** It looks right in light, dark and system. A light theme never shows a dark box (map included).
4. **Places.**
   - Needs you, Tasks, PC sessions, Search, New, Profile, Pair a phone, Files and Screen are where they were, with the same names.
   - Ctrl+B and Escape behave as before.
5. **Primitives.** Everything is built from `ui.tsx`: no new one-off buttons, cards or dialogs. A new primitive goes into `ui.tsx` first.
6. **Motion.**
   - No new keyframes; the three existing effects only.
   - Transitions sit under `motion-safe:`.
   - With reduced motion nothing moves.
7. **Calm.**
   - No more text than today on any row.
   - Paused and empty items stay hidden until asked for.
   - Counts are numbers, not sentences.
8. **Accessibility.**
   - Every new control has an accessible name and visible focus.
   - Tab order follows the visual order.
   - AA contrast for text, 3:1 for shapes.
   - 44px targets on touch.
9. **Safety.**
   - No Allow outside the chat's approval card.
   - Nothing sends a message or spends a turn without the owner pressing a button that says so.
10. **Classic untouched.** With the toggle off, the screenshots match main.

## Risks / open questions (for the user)

1. **Name of the waiting pin.** Keep "Needs you" (today's name, recommended) or switch to the concept's "Waiting"?
2. **Product name.** The concept uses "Toki". This spec keeps "PocketRocket" everywhere. Is the rename wanted, and when? It touches the site, desktop and installer, so it would be a separate plan.
3. **Colour themes.** Keep light, dark and system only (recommended for "won't be shocked"), or add the concept's seven palettes later as an Appearance option?
4. **Inline Approve.** The concept has Approve on side-panel cards. Today Allow is only on the chat card, by design (`lib/inbox.ts:35-38`). Recommendation: Review + Deny only. Do you want inline Approve for low-risk items anyway?
5. **Motion.** The concept's sphere and edge flow move; the app allows three motion effects. Recommendation: static sphere, static dashed active edges. Do you want a slow sphere rotation (motion-safe only) as a fourth effect?
6. **Toggle storage and timing.** Per browser (recommended, no hub change) or a hub setting that follows you to every device? And how long do you want to use it before the default flips?
7. **Paired phones.** `/api/projects` is closed to paired devices today (`api/guard.ts:323`). Open read-only `GET /api/projects`, `/overview` and `/map` to them, or keep phones on classic grouping?
8. **Map editing.** v1 changes the map only by asking a bot. Do you want the concept's add-node and link tools (the UI writing `map.json`) in a later round?
9. **Decisions from `current.md`.** Show them read-only (recommended), or let "Done" edit `current.md`?
10. **Which bot generates the map.** The default is the room's coordinator, then the first live member. The `project-map` skill reaches new template clones automatically; existing project leads need it attached once. Do you approve attaching it to your current leads?
11. **Panel default.** Overview open by default at ≥1280px. Is 300px right for your usual window, or should it start as the rail?
12. **Risk: the React Flow chunk.** It is shared with workflows and stays lazy, guarded by `scripts/bundle-budget.mjs`. Map pages load about one extra chunk on first open.
13. **Risk: bot-written `map.json`.** It may be wrong or stale. The credit line "Generated by @x · date" and Regenerate make that visible, and the map is never presented as fact.
