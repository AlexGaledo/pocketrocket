# OpenBot gaps: design-system review (pr-design-system, 2026-11-17)

Reviewed specs 00-05 against `packages/web` at `origin/main` 694db1a (worktree `pocketrocket-openbot-gaps`).
`05-owner-decisions.md` wins wherever it disagrees with a spec. Only the UI parts are reviewed here; hub claims are
left to pr-backend.

**Ground rules this review applies**
- **Clean room.** OpenBot's UI was not opened for this review, and nothing below comes from it. Everything uses our
  own tokens, primitives and wording. Generic words such as "trigger", "step" and "approval" are fine. Do not copy
  OpenBot's labels, layouts or screenshots, and do not use React Flow's demo styling.
- **Review against the code, not old notes.** The design system has moved since the agent brief was written:
  - Warm palette: `--bg #f8f8f6`, `--accent #1f5ac6`, dark `#86b2ff`.
  - Fonts: Google Sans or Figtree, with Geist Mono.
  - Radii: `--r-md 10`, `--r-lg 14`, `--r-xl 18`, composer 24.
  - Pills only for avatars, badges and toggles.
  - Seven text sizes, from `text-hint` to `text-display`.
  - Radix Dialog, Tabs, DropdownMenu, Popover and Tooltip.

  The sketches below use these values.
- **Primitives that already exist and must be reused:**
  - `Banner`, `ConfirmDialog` and `confirmAction()`. These already replace `confirm()`, so backlog item 3 is done.
  - `Popover`, `Tooltip`, `Kbd`, `EmptyState`, `Skeleton`, `RadioCard`, `Switch`, `Badge`, `Menu`.
  - `QrCode`, and the pairing-code pattern in `DevicesSection.tsx:140-197`.
  - `Private` and `maskEmail` (`settings/parts.tsx`).

---

## 02: Steering, queue, workflows

### Confirmed
- The composer is at `ChatPane.tsx:862-896`. Enter sends at `:820`, and the IME guard is at `:813`.
- Stop is at `:893-895` and calls `store.interrupt` (`store.ts:654`).
- The busy placeholder already says "<bot> reads this when it finishes" (`:827-831`), so today's copy assumes the queue.
- `AutomationsPage` is at `FleetPages.tsx:35-42` (Routines plus Triggers).
- `confirmAction` exists (`ui.tsx:192`), so task 2.4's "in-app confirm" needs no new work.
- The pause state already has UI: a header badge "@x paused" (`ChatPane.tsx:97`), `botStatus` `'paused'`, and the
  sidebar label.

### Wrong or stale claims
- **No queue display exists today.** The only thing the UI shows is the client outbox (`PendingSends`,
  `ChatPane.tsx:315`: Sending… / Sent / Not sent). Once the hub echoes a message, nothing shows that it is waiting in a
  lane. The "Waiting for @bot (n)" strip is new work, not an extension.
- Phase 3, task 3.5 (step-list editor) and task 3.6 (an optional diagram) are replaced by owner decision 3: a React Flow
  canvas plus a list view of the same data. The task table needs rewriting (see "Required changes").

### Steering UX: risks
1. **Alt+Enter cannot be found on a phone or with a pointer.** Phones have no Alt key, and the tooltip is the only hint.
   This needs a visible way to pick the mode (sketch A).
2. **Group rooms: the composer cannot know which bot the message reaches.** Routing is done by the coordinator or by
   `@mention`. The placeholder can only say something general before sending. The per-message result must come from
   the hub (`payload.steered`, or a queued state with a reason).
3. **What can steer depends on the provider.** Only Claude steers, and only when the setting is "Join". The composer
   needs a `canSteer` flag per bot. Without it the placeholder will promise something it cannot do on Gemini.
4. **The transcript splits around a steered message.** `groupMessages` breaks a bot group when the user's bubble
   arrives in the middle of a turn. The turn's WorkLine then appears twice: work before the message, and work after it.
   This is chronologically honest, so keep it, but the second WorkLine must not look like a new turn. Use the same
   `turnId`, and add a "continued" label instead of a new timestamp.
5. **Stop and Send are icon-only buttons named through `title`** (`:894`, `:896`). The brief requires labelled icon
   buttons. Add `aria-label` plus `Tooltip`, and do it in this change because both buttons' meaning shifts.

### How the folded-in message appears (recommendation)
- The **user's bubble stays where it was sent, in time order**. Do not move it into the bot's reply.
- A status line sits **under the bubble**, in the slot the outbox already uses for "Sent". It is `text-hint`, uses words
  rather than colour alone, and has no new motion:
  - `Joined Ada's turn`, shown as soon as `message.update` arrives with `payload.steered`.
  - `Queued: Ada reads this next`, when the setting is "queue" or Alt+Enter was used.
  - `Queued: Gemini can't take messages mid-task`, when the provider cannot steer. The reason comes from the hub.
- Do **not** use `SystemLine` for this, which the spec implies ("reuses the existing system-note style"). That is a
  centred `bg-card2` block, too heavy for every steer, and it would break the run of bubbles.

### Queue chip (Phase 2): risks and recommendation
- **Put controls in one place.** The chip sits above the composer. It shows a summary and the bot-level actions. It
  opens a `Popover` that lists the queued items, each with Edit and Cancel. Queued bubbles in the transcript show only
  the words "Queued", with no buttons of their own. Showing the same buttons in two places confuses people and doubles
  the keyboard tab stops.
- A group room can have several lanes. The chip row shows one chip per busy bot: `@ada 2 · @dev 1`.
- **Edit happens in the popover** (a `Textarea` plus Save and Cancel), not in the transcript bubble. Edit is refused
  once the bot has read the message, so the hub must send `editable:false`. The popover then explains why, rather than
  greying the button out with no reason.
- **"Send now" and Stop are different actions.** Stop throws the queue away. Send now keeps the queue and interrupts
  the turn. Label them in words. "Send now" also asks first through `confirmAction`, because partial work may be lost
  (owner decision 5, option b).
- **Pause** reuses the existing badge and status, with a distinct label: `Queue paused` (the queue) versus `Paused`
  (the screen). Resume lives on the chip and in the header badge's menu.
- 360 px: the chip row scrolls sideways inside its own box, and the popover is `max-w-[calc(100vw-1rem)]`, which the
  primitive already applies.

### Workflow canvas: does React Flow (`@xyflow/react` 12, MIT) fit?
**Yes, under the constraints below.** The hard part is not the library. It is keeping a canvas calm, accessible and
honest on a phone. Rules:

1. **Data.** `steps_json` is an ordered list of steps, each with a stable `id`. In v1, edges are **derived from that
   order**, not drawn by the user. Node positions are **not stored** in v1: a linear chain is laid out automatically
   (left to right on wide screens, top to bottom on narrow ones), so no dagre or elk is needed. If free placement ever
   ships, store it in a separate `layout` map keyed by step `id` that the engine never reads. This keeps owner
   decision 3 ("plain step graph, list view can render it") true by construction.
2. **One renderer for each step's look.** A `StepCard` component draws a step. The React Flow custom node and the list
   row both use it, so the two views cannot drift apart visually.
3. **Editing without wires.** Users do not drag connections, because React Flow has no keyboard way to connect two
   nodes. Instead:
   - Each edge has a focusable "+" button (a custom edge using `EdgeLabelRenderer`) that inserts a step.
   - Each node has a menu with Move up/down, Duplicate and Delete. Delete goes through `confirmAction`.
   - Handles are hidden (`isConnectable={false}`).
4. **Theming.**
   - Import `@xyflow/react/dist/base.css` only (not `style.css`), inside the lazy chunk.
   - Map React Flow's `--xy-*` variables to our tokens in one scoped block, for example
     `.wf-canvas { --xy-edge-stroke: var(--line2); --xy-background-pattern-color: var(--line); --xy-node-background-color: var(--card); ... }`.
     Because our tokens already switch under `.dark`, both themes follow automatically.
   - Do not pass `colorMode`, so there is only one source of truth.
   - Background: a dot pattern in `--line` on `--bg`. Selected node: `ring-2 ring-accent`.
5. **Motion.**
   - No `animated` edges.
   - `fitView` runs with no duration.
   - A running step uses the existing `.chip-running` shimmer, which is already turned off under reduced motion. That
     keeps the motion budget at three effects.
   - `zoomOnScroll={false}` and `panOnScroll`, so a wheel over the canvas inside the scrolling page does not get
     captured.
6. **Accessibility.**
   - React Flow makes nodes focusable and moves them with the arrow keys. In our layout that movement means nothing,
     so set `nodesDraggable={false}` in v1 and give each node a real `aria-label`, such as "Step 2 of 4: Ada, agent".
   - Graph semantics are still weak for screen readers. So the **list view is the accessible version and is always
     available**, not only on phones. A `Tabs` control in the page header switches between Canvas and Steps, and the
     choice is remembered per viewer in `localStorage`.
7. **Phone.** Below a 640 px container, show Steps by default and make the Canvas tab read-only (pan and pinch only).
   The editing controls live in the list.
8. **Where it lives.** Not in a 720 px `Dialog`, and not in the 800 px `PageBody` column, because a canvas needs the
   whole pane. Add a new `Page` kind, `{kind:'workflow', id}`, which covers the chat like the other fleet pages. It has
   a `FleetHeader` (name, Enabled switch, Run now), the canvas, and an **inspector** for the selected step:
   - On wide screens (`lg` and up), the inspector is a 320 px column.
   - Below `lg`, it opens as a `Dialog` (wide).

   The Automations page then gets a third section, "Workflows": rows that link to that page.
9. **Bundle.**
   - `React.lazy(() => import('./workflows/WorkflowCanvas'))` behind `Suspense`, with a `Skeleton` fallback. This is
     the app's first `lazy()`.
   - The list view and `StepCard` stay in the main bundle (small).
   - Measure the chunk with `vite build` when it lands. The ~57 KB gzip in the spec is a third-party figure.
   - React Flow brings its own zustand 4 (we use 5). It is a tiny duplicate, so accept it.
10. **Attribution.** React Flow shows a small "React Flow" link by default, and its authors ask non-Pro users to keep
    it. Keep it, restyled to `text-hint text-dim`. Hiding it is an owner call, not a design one.

### How steps look (StepCard)

| Kind | Icon (lucide) | At rest | During a run |
|---|---|---|---|
| Trigger: schedule | `Clock`, accent (as in SystemLine) | "Every Monday 09:00" (`describeCron`) | fired at 09:00 |
| Trigger: event | `Zap`, accent (as in TriggerLine) | "New GitHub issue" | event summary; its text is untrusted, shown plain |
| Agent | the bot's `Avatar` (24) | @handle, first line of the prompt, `{{previous}}` as a mono chip | running uses `.chip-running`; done shows a cost in mono |
| Approval | `ShieldCheck`, **neutral `--muted`** | "You approve before it continues" | waiting: `ring-warn/40` plus Badge warn "Waiting for you" (same language as `ApprovalCard`, `ChatPane.tsx:554`) |
| Output | `MessageSquare` / `FileText` | "Post to #team" / "Save to room files" | done shows a link |

- Status is always shown as a `Badge` with **words** (Waiting, Running, Done, Failed, Skipped), not colour alone.
- Warn and amber appear **only** while a step needs the person. An approval step at rest is neutral.
- The approval card that appears in chat and in Needs-you reuses the `ApprovalCard` shell. It has Approve (primary),
  Reject (danger) and "Send back with a note", which opens a `Textarea` inline. It is a person-only card, so it does not
  render `CtaButtons`.

### Required changes to spec 02
1. **Task 1.4.** The composer gets a send-mode menu next to Send (sketch A). Alt+Enter stays as the shortcut. The status
   line goes under the bubble, not in a `SystemLine`. The placeholder copy depends on `canSteer`. Stop and Send get
   `aria-label`. The size grows from **S to M**.
2. **Hub contract (pr-backend):**
   - `ProviderInfo` gains `steer: boolean`.
   - `message.update` carries `payload.steered` **or** `payload.queued = {reason: 'setting'|'shortcut'|'provider'|'between-runs'}`.
   - Steering continues the same `turnId`, so the UI can label the second WorkLine "continued".
3. **Task 2.4.**
   - The chip opens a popover holding Edit and Cancel. Bubbles show only "Queued".
   - "Send now" asks first.
   - Distinct label `Queue paused`.
   - `queue.changed` payload per lane: `{botId, roomId, paused, items: [{journalId, messageId, text, editable}]}`.
   - Store slice: `queues: Record<laneKey, LaneQueue>`.
4. **Phase 3 UI, rewritten:**
   - **3.5a** Workflow page, StepCard, list view and inspector (M).
   - **3.5b** Lazy React Flow canvas with token mapping, insert-on-edge and read-only on phone (M).
   - **3.5c** Run view on the same canvas or list, with per-step status and cost, run history, and the approval-step
     card in chat and Needs-you (M).
   - Delete task 3.6.
5. **Task 3.1.** Steps carry a stable `id`. Any layout data stays out of `steps_json`.

### New primitives
- `StepCard`, in `components/workflows/`: the shared node and row look. It is not in `ui.tsx` because only workflows
  use it.
- **`ActionCard` in `ui.tsx`:** the `rounded-lg ring-1` card shell with a header icon, a pending ring and an action row.
  ApprovalCard, TakeoverCard and FormCard each re-implement it today, and two more cards are coming (the workflow
  approval and the limit card from spec 01). Extract it before adding them.
- Nothing else. The chip and the send menu are built from `Popover`, `Menu`, `Badge` and `Kbd`.

### Size re-estimate (UI only)
- Steering 1.4: **M**. Queue 2.4: **M**.
- Workflows UI: **3 × M**, which is L overall (was M plus an optional S/M).
- ActionCard extraction: **S**.

---

## 01: Providers and failover

### Confirmed
- The `ClaudeSection.tsx:3` comment says one provider means no picker. The radio cards appear only when `multiple`.
- `BotDialog.tsx:91` is the model `Select`. The model list comes from the **active** provider (`:30-35`; the spec says
  `:26-32`, a few lines off).
- `ProviderCard.tsx` and the Onboarding provider step are skipped when there is one provider (`Onboarding.tsx:72`).

### Wrong claims
- **P0-5 and P1-9 point to "RightPanel (Usage tab)". The right panel is now screen-only**
  (`RightPanel.tsx:1`). Usage is `UsageSection` in `FleetPages.tsx:248`, on the Usage page. Retarget both tasks.
- **P4-2 "Right panel: context meter" has the same problem.** Put the context meter on the Bot page header
  (`BotPage.tsx`) and as a hint-size line in the chat header for a DM.
- **The table in section 4.1 says `ChatPane.tsx:1002-1003` gates the composer picker to Claude.** The gate is actually
  `ChatPane.tsx:673` (`s.settings.provider === 'claude'`, a **global** check). Once providers are per bot, the check
  must become "every member of this room runs on Claude".
- **The owner overrode the failover design.** Decision 2 is "ask with a card", but P3-1 and P3-3 still describe an
  automatic chain with a note. The UI has to be redone (below).

### Risks
- **ProviderCard has an accessibility defect.** The Re-check `Button` sits inside a `role="radio"` element. Interactive
  content inside a radio breaks screen-reader output and keyboard roving. Fix it when the section becomes "Providers":
  the radio covers the title row only, and the actions sit beside it.
- **A Gemini bot on a Google login silently refuses routines.** The person setting up a schedule or trigger for that
  bot must see a warning in **three** places:
  - `BotDialog`, when Gemini is picked and the bot has automations.
  - The routine and trigger form, when that bot is chosen.
  - The note in the transcript when a run is refused.
- **Usage meter colour.** One accent is the signal. The fill uses `--accent` below 80%, `--warn` from 80%, and `--bad`
  when the limit is hit. The meter always shows a percentage and the reset time as text, so colour is never the only
  cue. Fill against the `--card2` track passes 3:1 in both themes for all three colours. Re-check `--warn` in dark mode
  (`#f0a95c` on `#302f2d`) with the axe pass.

### The "Claude limit hit" card (replaces P3-3)
- A new chat card built on `ActionCard`, also listed in Needs-you, with the same rules as approvals for a paired phone.
- The pending ring is `ring-warn/40`. Its icon is `Gauge`.
- Copy: **"Ada hit Claude's 5-hour limit. It resets at 14:00."**
- Actions:
  - `Continue on Gemini` (primary).
  - `Wait until 14:00` (outline).

  When no backup is set, there is no primary action. The card instead says "Set a backup in Ada's settings" and links
  to the bot dialog.
- **Unanswered or unattended:** the turn has already ended with the reset time (owner rule). The card turns into a
  quiet note: "Not continued. Resets 14:00." It never switches on its own.
- **Open question for pr-backend:** when a routine started the turn, does pressing "Continue on Gemini" count as a
  person-started turn for the Google-login rule (decision 1)? The card must not offer a button that the hub would then
  refuse.
- Backup setting in BotDialog: **one** backup (provider plus model) in a "If Claude hits its limit" select, owner only.
  The card offers one choice. The spec's limit of 2 adds UI for no benefit.
- While a bot runs on the backup: a muted `Badge` "On Gemini until 14:00" in the chat header and on the Bot page. The
  sidebar row's status text also says it.

### Required changes to spec 01
1. Retarget P0-5, P1-9 and P4-2 away from RightPanel (see above).
2. Replace P3-3 with: the limit card, one backup select, the "On backup" badge, and a limited `Banner` (tone warn) above
   the composer while the room's bot is held.
3. P1-8: also fix ProviderCard's nested button. Rename the Settings section to **"Providers"** and move the
   "not ready" dot (`SettingsDialog.tsx:105`) to it. When only one provider is enabled, BotDialog shows **no** provider
   select (which is what most users will see until Gemini is verified).
4. P1-8: the composer model picker is gated per room on its members' providers, not on `settings.provider`.

### New primitives
- **`Meter` in `ui.tsx`:** `role="meter"` with `aria-valuenow/min/max` and `aria-valuetext` (for example "Claude 5-hour
  limit 82%, resets 14:00"), a label row and a 6 px bar. Used for plan usage now and the context meter later.
- `ActionCard` (from spec 02).

### Size re-estimate
- P0-5 meter: **S** plus the Meter primitive (S).
- P1-8: **M**.
- P1-9: **S**.
- Limit card plus backup select plus badge (new P3-3): **M**.
- P4-2: **S**.

---

## 03: Telegram notifications (owner scope: notifications only)

### Confirmed
- `IntegrationsSection.tsx:4` and `:188` send WhatsApp to the bot's browser.
- `NotificationsSection` is desktop-only (`SettingsDialog.tsx:100`, `canNotify()`).
- Web Push lives in Devices (`DevicesSection.tsx:250`).

### Placement: change task A4
A4 puts Telegram under **Connections** (`IntegrationsSection`). That section is about tools that bots use, with a grant
per bot. Telegram notify is not a bot tool, and the owner scoped it to notifications. Put it under **Notifications**
instead:
- Show the Notifications section on every **non-device** client, not only on desktop.
- The desktop card keeps its `canNotify()` gate.
- Add a line pointing to "Phone: Devices › Notifications on this device".
- Add a new **Telegram** card.

Telegram chat mode, when it comes later, can move to Connections.

### Telegram card flow (reuse the Devices pairing pattern)
1. **Bot token.** Use `ApiKeyField`. The token is pasted once and then masked. After a check it shows `@yourbot`.
   A bad token shows `InlineError` with Telegram's own words.
2. **Link your account.**
   - Show the one-time code with the same layout as pairing: mono, tracked, read character by character through
     `aria-label`, "Valid 10 minutes".
   - Add an **"Open in Telegram"** link (`https://t.me/<bot>?start=<code>`, new tab) and a `QrCode` of the same link,
     to scan from a phone.
   - After linking, show "Linked to <name>", masked with `Private`, because people screen-share.
3. **Notify me here.** A `Switch`, disabled until linked. The cloud warning is **visible before the switch**, as plain
   text: "Telegram is not end-to-end encrypted. PocketRocket only sends 'A bot needs your approval' or 'A routine
   finished', with no names or message text."
4. Add a `Send a test` button (the same as push test), "Unlink", and a link to BotFather's `/revoke`.
5. Add a note: "One hub per bot token. Using the same token on your VPS hub stops this one."

### Required changes, primitives and size
- **Change:** move A4 to `NotificationsSection.tsx`, which is shown on desktop and in the browser.
- **pr-backend:** expose link status (linked, plus a display name to mask), the code's `expiresAt`, and a test-send
  route.
- **New primitives:** none.
- **Size:** **S to M** (was S), because of the deep link, QR, expiry state and test send.

---

## 04: Updater (desktop)

### Confirmed
- `lib.rs:550` holds `RELEASES_URL`. `:1394` is the menu item. `:1475` opens the browser.
- `tauri-plugin-dialog = "2"` is already a dependency.
- About links "Check for updates" to the releases page (`AboutSection.tsx:15`).

### Risks
- **A modal at launch interrupts.** The daily automatic check should **not** open a native dialog over the person's
  work. Instead:
  - When an update is found, show a system notification ("PocketRocket 0.4.1 is ready").
  - Change the app menu and tray item to "Install update 0.4.1…".
  - Open the native dialog only when the person picks that item or "Check for updates". That still counts as asking
    before installing (owner decision 6).
- **Native dialogs allow only a few buttons and no links.**
  - Keep to two buttons: `Install and restart` / `Later`.
  - When `/api/busy` is not zero, the two buttons are `Install when bots are idle` / `Later`.
  - Release notes: add a third menu item, "What's new in 0.4.1", which opens the release page. Do not try to put a link
    inside the dialog.
  - pr-infra should check whether the pinned dialog plugin supports custom labels on two buttons. If it does not, fall
    back to Yes/No with the question worded to fit.
- **Copy (calm, no alarm words):** "PocketRocket 0.4.1 is ready. Installing restarts the app; bots pause for about a
  minute and pick up where they left off." Do not promise that last part until the known crash-loss bug is fixed.
  Until then, say "running replies will stop".
- **About inside the desktop app:** show the version and "Updates are checked daily by the desktop app. Use the
  PocketRocket menu › Check for updates." Keep the releases link for the browser and for server mode. The webview gets
  **no** updater permission, which is correct (spec A1). If an "update ready" line is ever wanted in About, Rust must
  push a read-only event. The webview never triggers an install.
- **The splash page is behind on tokens.** `desktop/ui/index.html:9-38` and `site/styles.css` still use the old cool
  palette (`--bg #f7f7f8`, accent `#4f7df3` / `#3f66c9`). The web app moved to warm (`#f8f8f6` / `#1f5ac6`). If the
  updater shows "Updating…" on the splash, bring the splash tokens in line first, or record why not.

### Required changes, primitives and size
- **Change A4 (pr-infra):** notification first, dialog on demand, the two-button copy above.
- **Change A5:** desktop-aware About copy. Add a line to the splash for restart-after-update. Fix the token drift on the
  splash and the site, or record why it stays.
- **New primitives:** none.
- **Size:** A5 **S**. Splash and site token parity **S** (separate PR).

---

## Sketches

### A. Steering composer (bot busy, wide)
```
  ┌ transcript ───────────────────────────────────────────────────────────┐
  │                                         ┌──────────────────────────┐  │
  │                                         │ fix the header, not the  │  │
  │                                         │ footer                   │◯ │
  │                                         └──────────────────────────┘  │
  │                                              Joined Ada's turn · 14:02 │  ← text-hint, words
  │  ◐ Ada  ▸ Worked 2m · 4 steps (continued)                             │  ← same turnId
  │  ┌───────────────────────────────┐                                     │
  │  │ Switching to header.tsx… ▍    │  ← live stream, caret               │
  │  └───────────────────────────────┘                                     │
  ├──────────────────────────────────────────────────────────────────────┤
  │  [@ada 2 queued ▾]  [Queue paused · Resume]                            │  ← queue chips (Phase 2)
  │ ╭────────────────────────────────────────────────────────────────────╮ │
  │ │ Ada is working. Your message joins in.                             │ │  ← placeholder when canSteer
  │ │ 📎                          Approval ▾  Sonnet ▾   ■ Stop   [➤][▾] │ │
  │ ╰────────────────────────────────────────────────────────────────────╯ │
  └──────────────────────────────────────────────────────────────────────┘
                                   send menu (only while a target is busy):
                                   ┌─────────────────────────────────────┐
                                   │ ✓ Join the running turn     Enter   │
                                   │   Queue for after       Alt  Enter  │
                                   │ ─────────────────────────────────── │
                                   │   Default: Settings › Bots          │
                                   └─────────────────────────────────────┘
```
- Provider cannot steer: the placeholder reads "Ada reads this when it finishes" (as today), the menu is not shown, and
  the status line reads `Queued: Gemini can't take messages mid-task`.
- On a phone, `[▾]` is a 40 px target. Long-press is not used.

Queue popover (from the chip):
```
  ┌ Waiting for @ada ─────────────────────────┐
  │ "also bump the version"        Edit  ✕    │
  │ "and update CHANGELOG"         Edit  ✕    │
  │   (read by Ada: can't edit)               │
  │ ───────────────────────────────────────── │
  │ [Pause queue]            [Send now…]      │  ← Send now asks first
  └───────────────────────────────────────────┘
```

### B. Workflow page: canvas (wide, lazy chunk)
```
 ┌ ← Weekly issue summary          [● Enabled]  [▶ Run now]   ( Canvas | Steps ) ┐
 │ · · · · · · · · · · · · · · · · · · · · · · · · · · · ┌ Step 2 · Agent ─────┐ │
 │ ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │ Bot   [@research ▾] │ │
 │ │ ◷ Schedule   │─(+)│ ◐ @research  │─(+)│ ◐ @writer │ │ Prompt              │ │
 │ │ Mon 09:00    │    │ Collect last │    │ Draft a   │ │ ┌─────────────────┐ │ │
 │ └──────────────┘    │ week's issues│    │ summary of│ │ │ Collect …       │ │ │
 │                     └──────────────┘    │{{previous}}│ │ └─────────────────┘ │ │
 │                                         └─────┬─────┘ │ Uses: last step's   │ │
 │        ┌──────────────┐    ┌──────────────┐   (+)    │ output as data      │ │
 │        │ 💬 Post to   │(+)─│ ⛉ Approval   │────┘     │ [Move up] [Delete…] │ │
 │        │ #team        │    │ You approve  │          └─────────────────────┘ │
 │        └──────────────┘    └──────────────┘                     React Flow ▪ │
 └────────────────────────────────────────────────────────────────────────────────┘
   (+) = focusable "insert step" button on an edge · no handles · no animated edges
   Inspector = 320 px column at lg+, Dialog below lg · selected node = ring-2 ring-accent
```

### C. Same workflow: Steps view (phone default, always available)
```
 ┌ ← Weekly issue summary            ( Canvas | Steps ) ┐
 │ Budget $1.00 per run                    [▶ Run now] │
 │ ┌─────────────────────────────────────────────────┐ │
 │ │ 1 ◷ Schedule · Every Monday 09:00            ⋯ │ │
 │ └─────────────────────────────────────────────────┘ │
 │                    [+ Add step]                     │
 │ ┌─────────────────────────────────────────────────┐ │
 │ │ 2 ◐ @research · Collect last week's issues   ⋯ │ │
 │ └─────────────────────────────────────────────────┘ │
 │ ┌─────────────────────────────────────────────────┐ │
 │ │ 3 ◐ @writer · Draft a summary of {previous}  ⋯ │ │
 │ └─────────────────────────────────────────────────┘ │
 │ ┌─────────────────────────────────────────────────┐ │
 │ │ 4 ⛉ Approval · You approve before posting    ⋯ │ │
 │ └─────────────────────────────────────────────────┘ │
 │ ┌─────────────────────────────────────────────────┐ │
 │ │ 5 💬 Output · Post to #team                  ⋯ │ │
 │ └─────────────────────────────────────────────────┘ │
 │ Last run · Mon 09:00 · $0.42                        │
 │  1 Done · 2 Done · 3 Done · 4 [Waiting for you] · 5 │  ← Badges with words
 └─────────────────────────────────────────────────────┘
   ⋯ = Menu: Edit, Move up, Move down, Duplicate, Delete…  (Edit opens the inspector Dialog)
   An ordered list (<ol>), so screen readers get "Step 3 of 5"
```

---

## Summary

### Top 5 required changes
1. **Steering composer (02, task 1.4).**
   - Add a visible send-mode menu next to Send, with Alt+Enter as the shortcut.
   - Show the result as a status line under the user's bubble, not a SystemLine.
   - pr-backend adds `ProviderInfo.steer` and the `payload.steered`/`queued` reason, so the copy never over-promises.
2. **Workflows (02, Phase 3).**
   - Rewrite 3.5 and 3.6 for the owner's canvas: one ordered `steps` list with stable ids, derived edges, no stored
     positions.
   - A shared `StepCard`. The Steps view is always available as the accessible and phone view.
   - A lazy React Flow chunk themed through `--xy-*` mapped to our tokens.
   - The editor is a full-pane `workflow` page with an inspector.
3. **Failover (01, P3-3).** Replace the automatic chain UI with the owner's **limit card** on a new `ActionCard`
   primitive. One backup per bot. The card never switches on its own.
4. **Fix wrong file targets in 01.** Usage and the context meter are not in RightPanel (now screen-only). The composer
   picker gate is `ChatPane.tsx:673`, not `:1002`. Fix ProviderCard's button nested inside a radio.
5. **Telegram notify (03, A4).** Move it from Connections to Notifications, shown on desktop and in the browser. Reuse
   the Devices pairing pattern (code, QR, `t.me` deep link). Show the content-free warning before the switch.

### Recommended UI build order
1. `ActionCard` and `Meter` primitives (S each). They unblock items 3, 5 and 6.
2. Steering composer, 02 task 1.4 (M). Ships with backend 1.3.
3. Queue chip and popover, 02 task 2.4 (M). After 2.1.
4. Workflow UI: 3.5a page, StepCard and list (M); then 3.5b canvas (M); then 3.5c run view and approval card (M).
5. Claude plan meter, 01 P0-5 (S). It can run in parallel with step 2 whenever P0-2 lands.
6. Telegram notify card, 03 A4 (S-M). It can run in parallel with steps 2-4.
7. Desktop update copy and About, 04 A5 (S), plus splash and site token parity (S).
8. Providers: P1-8 and P1-9 (M + S), then the limit card, backup select and badge (M), then the context meter (S).
