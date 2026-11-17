# Gap 2: Steering, queue controls, workflows, media steps

Planned 2026-11-17 against `origin/main` @ 694db1a, in the worktree `pocketrocket-openbot-gaps`. Ground rules are in
`00-openbot-recon.md`: clean room, free MIT tool for now, may be paid later.

**Owner input (interview, 2026-11-17).** This is the owner's top priority, so it ships first. Phase 1 must be
small, concrete and ship soon, with steering first. The owner can test live on **Claude Max**, and on **Google
Gemini** soon. There is **no paid budget** for services beyond the user's own keys.

**Revised after review 2026-11-17.** Owner answers in `05-owner-decisions.md` are applied, and the required changes from
`review-backend.md`, `review-design.md` and `review-infra.md` are folded in. Revised sections say so in their heading.
Where this spec and 05 differ, 05 wins.

## Verdicts

| Sub-feature | Verdict | One line |
|---|---|---|
| (a1) Steering: a message to a busy bot joins its running turn | **GO** (Claude) / **go-with-limits** (others) | The Claude Agent SDK already does this in streaming-input mode, and our adapter already uses that mode (`providers/claude.ts:318-321`). Other providers fall back to the queue. |
| (a2) Queue controls (pause, resume, cancel, edit, send now; crash-safe) | **GO** without reorder (05 §02 #6) | The lanes are already crash-safe (`lane_journal`) and pause already exists. Add cancel, edit and "send now". **Drop reorder**, because a lane runs everything queued as one batched turn (`RoomRouter.ts:319`). |
| (b) Workflows | **GO** (revised): React Flow canvas, lazy-loaded, plus a Steps list over the same `{nodes, edges}` graph; v1 linear only | Owner decision 05 §02 #3. It reuses routines, triggers, approvals and lanes, with four lane changes (solo steps, park-safe owner ref, one resume owner, hop reset per step). |
| (c) Image and video generation steps | **Deferred** (05 §02 #4); GUIDE note only. Later: own API key only | No subscription covers image or video APIs (Claude, ChatGPT, Google AI Pro, Higgsfield). Images first, behind an approval card that shows the cost. Video comes later. |

---

## (a) Steering and queue

### Problem / user story
"My bot is ten minutes into a task and I notice it is fixing the wrong file. Today I can either hit Stop, which
throws the turn away, or type a correction that waits until it is done." With steering, the correction reaches
the bot at its next step and it changes course without losing what it has done.

### How it works today (verified)
- **Send path.** `ws.ts:73-80` takes `message.send` and calls `RoomRouter.onUserMessage` (`RoomRouter.ts:148`),
  then `dispatchUser`, then `enqueue` (`:279`). Each `botId:roomId` lane runs one turn at a time (`:291`).
  While it runs, new items wait in `lane.pending`. The next turn takes **all** pending items at once
  (`lane.pending.splice(0)`, `:319`) and shows the bot every unread message since `lastSeenSeq` (`:333`).
  So a correction already reaches the bot, but only after the current turn ends.
- **Cursor.** When a turn ends, `lastSeenSeq` is saved as `startSeq`, which is `maxSeq` at the start of the
  turn (`:324`, `:370`). A message that arrives mid-turn therefore stays "unread" for the next turn.
- **Stop.** The composer's Stop button (`ChatPane.tsx:893-895`) sends `turn.interrupt` (`store.ts:654`,
  `protocol.ts:108`). That goes through `ws.ts:105` to `RoomRouter.interrupt` and then `BotRunner.interrupt`
  (`BotRunner.ts:163-168`), which calls `provider.interrupt` and aborts the controller. A stopped turn posts a
  failure note (`BotRunner.ts:750`, which has an `aborted` branch).
- **Claude adapter.** It already uses streaming input. `prompt()` yields one `SDKUserMessage`, then waits on
  `done` (`claude.ts:314-321`). `done` resolves on the first `result`, and the loop then `break`s
  (`claude.ts:635-636`). The adapter keeps the `Query` per turn (`this.active`, `:560`) and `interrupt()`
  calls `q.interrupt()` (`:253-258`).
- **Crash safety.** Every lane item is written to `lane_journal` (`migrations.ts:126-132`, `RoomRouter.ts:283-286`).
  After a restart, `FollowUp` re-queues it once (`FollowUp.ts:10`, `MAX_RESUMES = 1`), and shutdown keeps
  the journal (`RoomRouter.ts:366`, `hub.ts:796-798`).
- **Pause.** A paused bot's lane waits (`RoomRouter.ts:300-305`, `LaneControl` `:598-602`). Today only computer
  takeover sets this (ComputerControl).
- **Other providers.** Codex is `codex exec --json`, one process per turn (`codex.ts:11-12`), so it has no live
  channel into a running turn. OpenCode uses its server with `session.promptAsync` and `abort`
  (`opencode.ts:139-154`, `:236`). Grok spawns the CLI per turn (`grok.ts:1`, `:162-170`).

### Research: steering APIs (read 2026-11-17)

| Runtime | Inject into running turn | Interrupt | Source |
|---|---|---|---|
| **Claude Agent SDK** (TS, `^0.3.278`; 0.3.269 installed in the dev clone) | **Yes.** In streaming-input mode, a message yielded while tools run "reaches Claude after those tool calls finish. Claude then answers it and your earlier message in one response. If the turn ends first, Claude starts a new turn for it." `SDKUserMessage` has `uuid` and `priority?: 'now' \| 'next' \| 'later'` (sdk.d.ts:5712; the docs mention it but do not define the three values). `SDKResultSuccess.user_message_uuids` tells which inputs a result answered. `Query.streamInput()` also exists. | `Query.interrupt()` ends the response with `error_during_execution`. With CLI ≥ 2.1.205 it returns a receipt with `still_queued` uuids. `cancel_queued` exists on the raw control protocol only (CLI ≥ 2.1.219), and `interrupt()` never sends it. | [Send messages to a running agent](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Agent loop: turns and budget](https://code.claude.com/docs/en/agent-sdk/agent-loop), [TS reference: Query](https://code.claude.com/docs/en/agent-sdk/typescript), local `sdk.d.ts` (0.3.269) lines 2942, 4273-4287, 5331-5333, 5712 |
| **Codex app-server** | **Yes.** `turn/steer {threadId, input, expectedTurnId}` returns `{turnId}`. It fails with no active turn, emits no new `turn/started`, and takes no `model`/`cwd` overrides. | `turn/interrupt {threadId, turnId}`, after which the turn ends `status: "interrupted"` | [Codex App Server docs](https://developers.openai.com/codex/app-server) (now served at learn.chatgpt.com/docs/app-server), PR #10821 "feat(app-server): turn/steer API" |
| **OpenCode server** | **Unclear.** `POST /session/{id}/prompt_async` exists, but it is undocumented whether a prompt sent to a busy session is queued or injected. One open PR says async prompts to an idle session can fail to wake it. | `POST /session/{id}/abort` | [opencode issue #36804](https://github.com/anomalyco/opencode/issues/36804), [PR #39189](https://github.com/anomalyco/opencode/pull/39189) (community, unverified) |
| **ACP** (Gemini `--acp`, Cursor, Cline, ...) | **No steering in the spec.** The v2 RFD lets a client send `session/prompt` while work runs, and leaves "explicit queueing or steering" to a later RFD. | `session/cancel` notification, after which the prompt returns `StopReason::Cancelled` | [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn), [ACP v2 prompt RFD](https://agentclientprotocol.com/rfds/v2/prompt), [cancellation](https://agentclientprotocol.com/protocol/v1/cancellation) |
| **Gemini CLI** | **Interactive only, experimental.** `experimental.modelSteering` treats typed text as a hint "at the beginning of its next turn". Nothing says it works headless or over ACP. The page also announces the move from Gemini CLI to Antigravity CLI (2026-06-18). | ACP `session/cancel` | [Gemini CLI model steering](https://geminicli.com/docs/cli/model-steering/) (last updated 2026-04-10), [ACP mode](https://geminicli.com/docs/cli/acp-mode/) |

**What OpenBot does (behaviour only; read `packages/contracts/src/ipc-queue.ts` and
`team-protocol/model-steering-v1.ts` at github.com/nightly-labs/openbot HEAD on 2026-11-17, nothing copied).**
A "busy message mode" can be queue or steer, with steer as the default. It is set per app and can be
overridden per agent. A provider that cannot steer queues the message and records why (unsupported, or the
steer failed). For those providers the client offers "send now" instead. Queued messages can be edited, and
each delivery has a status (queued, running, completed, interrupted, cancelled).

### Design: steering (Phase 1). Revised after review 2026-11-17

Owner decisions applied (05 §02 and Round 3): #1 a message to a busy bot **joins the running turn**, **Ctrl+Enter**
queues (Alt+Enter is taken by the desktop full-screen toggle, `packages/desktop/src-tauri/src/lib.rs:1134-1166`), bot-to-bot
hand-offs always queue; #2 automation turns (routine, trigger, workflow) can be steered and keep strict approvals and
their budget; #5 providers that cannot steer queue with a note saying why.

**UX (pr-design-system, from review-design).**
- When a target is busy, a **send-mode menu** sits next to Send (a `Menu` on a 40 px `[▾]` target): "Join the running
  turn · Enter" and "Queue for after · Ctrl+Enter", with a footer link to the default in Settings › Bots. Ctrl+Enter is
  the shortcut (05 Round 3 #2; no other Ctrl+Enter binding exists in `packages/web`), but phones and pointer users need the
  visible menu. The menu is hidden when no target can steer.
- The placeholder depends on a per-bot `canSteer` flag from the hub: "Ada is working. Your message joins in." when it can
  steer, today's "Ada reads this when it finishes" (`ChatPane.tsx:827-831`) when it cannot. In a group room the composer
  cannot know which bot a message reaches (coordinator or `@mention`), so the placeholder stays general and the per-message
  result comes from the hub.
- The user's bubble stays where it was sent. A `text-hint` status line goes **under the bubble**, in the slot the outbox
  uses for "Sent" (`PendingSends`, `ChatPane.tsx:315`), in words, with no new motion:
  `Joined Ada's turn` / `Queued: Ada reads this next` / `Queued: Gemini can't take messages mid-task` (reason from the hub).
  Not a `SystemLine`: that centred block is too heavy for every steer.
- The bot's work after a steer continues the **same `turnId`**, so the second WorkLine is labelled "continued" instead of
  looking like a new turn.
- Stop and Send are icon-only buttons named through `title` (`ChatPane.tsx:893-896`). Give both `aria-label` plus `Tooltip`
  in this change, because their meaning shifts.
- The steering result is never promised before the hub confirms it: between `lane.pending.splice(0)` (`RoomRouter.ts:319`)
  and `laneTurns.set` (`BotRunner.ts:568`) a lane is running but has no turn (semaphore wait, rotation summary, classifier,
  computer start). A message sent then is queued, and the line says only "Queued", never "this bot cannot take messages".
- **Stop is room-wide.** The composer's Stop button interrupts **every** running turn in the room
  (`ChatPane.tsx:893-895`, `activeTurns.forEach(([t]) => interrupt(t))`), not only the bot a steer joined. Its tooltip and
  `aria-label` say "Stop all running bots in this room".
- **Stop with unanswered steers** (05 Round 3 #3): steers the bot had not answered yet are **re-queued and the bot answers
  them right after Stop**. Stop does not drop them. The note after Stop says so in words, for example
  `Stopped. Ada will answer your 1 new message next.`; with none pending it stays "stopped by you" (task 2.3).
- When the running turn is a hand-off or an automation, the status line says so ("Joined Ada's routine turn; it uses that
  routine's budget"), because the steer spends that cause's budget (owner decision #2).

**Rules (safety, principles 1-2 and 4).**
- Only a **person's** message can steer, and only at hop 0 (`causeKind: 'user'`). Bot hand-offs, routines, triggers and
  follow-ups always queue. A steer never wakes a second bot and cannot loop.
- A steered turn keeps its own cause, hop, budget and `strictApprovals`. A routine- or trigger-started turn still asks for
  approvals in bypass mode (decision Q6).
- The steered text goes in as one formatted transcript line (`formatMessage`, `RoomRouter.ts:58`), so `quoteTags` and the
  author tag apply. Pictures go through `userContent` (`claude.ts:319`).
- Its cost is charged to the running turn's cause and stays under `maxBudgetUsd`, the token brake and the cause cap.
- Once consumed, the steered message's `cause_id` is set to the running turn's cause (today it is its own cause,
  `RoomRouter.ts:161`, which would leave a cause with no turns), so threads and usage group correctly.

**Hub contract (pr-backend).**
1. `providers/types.ts:162-180`: optional
   `steer?(turnId: string, input: { text: string; images?: string[]; uuid: string }): boolean`. `true` means only
   "pushed", not "answered". `ProviderInfo` gains `steer: boolean` so the UI can compute `canSteer`.
   **For Claude, `canSteer` is derived, not hard-coded:** it is true only when the CLI's `system/init` frame advertises the
   `interrupt_receipt_v1` capability (SDK typings `sdk.d.ts:4279` and `:5531`, per the readiness review). Without the
   receipt, Stop cannot tell which steers are still queued, so an older CLI queues every busy message with reason
   `'provider'`.
2. `TurnOutcome` gains `steers: { consumed: string[]; pending: string[] }` (uuids taken from `user_message_uuids` on results
   and assistant frames, and from the interrupt receipt's `still_queued`). `TurnResult` gains `unansweredSteers`.
3. `message.update` carries **per-bot maps**, because one message can reach several lanes and steer into one while it
   queues for another: `payload.steered: Record<botId, turnId>` and
   `payload.queued: Record<botId, { reason: 'setting' | 'shortcut' | 'provider' | 'between-runs' }>`.
4. `message.send` gains optional `busy?: 'steer' | 'queue'` (`shared/src/protocol.ts:108` area). The REST route
   `POST /api/rooms/:id/messages` (`api/rest.ts:414`) gains the same optional `busy` field, so scripted and device senders
   behave like the composer. `SettingsStore` gains `busyMessages: 'steer' | 'queue'`, default `'steer'`.

**Hub changes.**
1. **Claude adapter** (`providers/claude.ts:313-321`, `:559-644`): replace the one-shot generator with a per-turn input
   channel (push/wake pattern). `steer()` pushes an `SDKUserMessage` with a `uuid`; `priority` stays unset unless spike 1.0
   shows a value that helps.
   - The read loop no longer `break`s on the first `result` (`:635-636`). It ends once every pushed uuid appears in some
     result's `user_message_uuids`, or a `result` arrives with nothing outstanding. A steer after the final result returns
     `false`.
   - **Result without `user_message_uuids`.** If a `result` frame lacks the field (older CLI, error result), the adapter
     cannot tell what was answered: it **ends on that result** and returns **every** pushed steer uuid as
     `steers.pending`, so the router re-queues them rather than guessing.
   - **Several results per query.** Cost comes from the last result's cumulative `total_cost_usd` (`:620-622`), but `usage`
     tokens and `durationMs` are per result and must be **summed** (today `:628-634` overwrites them). `ok`/`error` come
     from the last result.
   - **Stop = interrupt receipt, then close.** On abort the adapter calls `q.interrupt()`, reads the receipt's
     `still_queued` uuids, then calls `q.close()` and stops reading. Without the close, uuid-stamped queued messages
     "WILL run" in the CLI (sdk.d.ts:4283) and Stop would run the steer as a new turn. The surviving uuids return as
     `steers.pending`, and the router re-queues them so the bot answers them right after Stop (05 Round 3 #3). The token
     brake's internal interrupt (`claude.ts:586-589`) does the same.
   - **Outdated-CLI replay** (`claude.ts:276-278`, the second `runOnce` after the first attempt fails on an old CLI): the
     replay's input carries the pending steers, so a steer pushed into the failed first attempt is not lost.
2. **BotRunner** (`agent/BotRunner.ts:120-180`, `:600-760`): `steer(botId, roomId, input)` looks the lane up in `laneTurns`.
   `laneTurns` stays set for the whole turn (`:568` to `:727`), including the gaps between provider runs, so it cannot say
   whether a query is live. Add a **separate run-in-progress flag** per lane, set when a provider run starts and cleared when
   it returns; `steer()` returns `false` when it is clear (stale-session retry `:615-632`, move-up `:636-637`, continuation
   loop `:676`), or when the provider has no `steer`. `steer()` calls **the provider the turn started on** (kept with the
   run), never `this.providers.active()` (`:165`, `:186`), which may change mid-turn. When the runner continues (move-up, continuation, stale retry, the
   outdated-CLI replay at `claude.ts:260-279`) it carries `steers.pending` into the next run's input; whatever is still
   pending when the turn ends returns on `TurnResult.unansweredSteers`.
3. **RoomRouter** (`rooms/RoomRouter.ts`):
   - `dispatchUser` (`:186-212`): for each target whose lane is running, in steer mode, call `runner.steer`. On success do
     not enqueue; write a `lane_journal` row with `status = 'steered'` (migration block 250) and remember the seq on the lane.
   - When the turn ends, delete the steer rows of consumed uuids, and **re-enqueue `unansweredSteers` as normal user items**
     with the note "Your message runs next". Without this an unconsumed steer is lost, because the router skipped `enqueue`.
   - **Cursor rule (replaces both the `max(startSeq, steeredSeq)` draft and the contiguous-prefix draft).** Keep
     `lastSeenSeq = startSeq` exactly as today (`:370`). Instead of moving the cursor, **filter consumed steers out** with one
     helper, `isConsumedSteer(botId, roomId, messageId)` (backed by the `lane_journal` steer rows), used by every reader of
     `messagesAfter(lastSeenSeq)`: `buildInjected` (`:455-466`), `userImages` (`:447-453`) and `latestUserText` (`:345`).
     Everything else after `startSeq` (a Ctrl+Enter queued message, another bot's report in `lane.pending`, group chatter)
     stays unread and shows next turn; a consumed steer never repeats. Skip when `frozen` (`:366`). Task 2.1b reuses the
     same helper for cancelled messages, so there is one filter, not two.
   - **Crash mid-steer.** The steer's own journal row lets FollowUp resume it even when the parent item has already used its
     one resume (`FollowUp.ts:89-96`, `MAX_RESUMES = 1` at `:10`). A resumed session may show the steer twice (in the CLI
     transcript and as unread); `RESUME_NOTE` already tells the bot to check what is done.

**Providers after Phase 1.** Claude steers. Codex, OpenCode, Grok and Gemini queue with reason `'provider'`. A Codex steer
needs the adapter moved to app-server (`turn/steer`); that rewrite is **parked** (05 §02 #5) until someone can test Codex.

### Design: queue controls (Phase 2). Revised after review 2026-11-17

Owner decision 05 §02 #6: **cancel, edit, send now, pause; no reorder.** A lane runs all pending items as one batched turn
(`RoomRouter.ts:319`), so order inside a lane barely matters, and across lanes the only order is the FIFO
`MAX_CONCURRENT_TURNS` semaphore (`:469-480`).

- **See the queue.** Nothing shows a waiting lane item today (only the client outbox, `ChatPane.tsx:315`), so this is new
  work. A chip row above the composer shows one chip per busy bot (`@ada 2 · @dev 1`); a chip opens a `Popover` listing
  that lane's items, each with Edit and Cancel, plus Pause queue and "Send now…". Queued bubbles in the transcript show only
  the word "Queued", with no buttons. At 360 px the chip row scrolls inside its own box.
- **Protocol.** `GET /api/rooms/:id/queue` and a `queue.changed` event per lane:
  `{ botId, roomId, paused, items: [{ journalId, messageId, text, editable }] }`. Add the route to `DEVICE_ALLOW`
  (`api/guard.ts:321`) or paired phones cannot see the queue; the queue WS commands get the same device rules as
  `message.send`.
- **Cancel is per lane, and message-level.** Cancel removes that lane's item from `pending` and the journal and settles it
  with `onDone({ok:false, error:'cancelled'})`, as `botLeftRoom` does (`:504-514`). One message can target two lanes, so the
  message itself is marked `messages.cancelled_at` only when no lane still holds it. Because the cursor reads
  `messagesAfter(lastSeenSeq)`, `buildInjected`, `userImages` (`:447-453`) and `latestUserText` (`:345`) must filter
  cancelled messages, or the next turn still shows them. They do it through the **same helper** Phase 1 adds for consumed
  steers (widened to skip cancelled messages too), not a second filter.
- **Edit** happens in the popover (a `Textarea`, Save, Cancel). The hub refuses it, and sends `editable:false` with a
  reason, once any bot has read the message, once any lane steered it, or once any member's session cursor is past its seq.
- **Send now** keeps the queue and interrupts the running turn, then runs the queue. It asks first through `confirmAction`
  (`ui.tsx:192`), because partial work may be lost. Stop and Send now are different actions and are labelled in words.
  The failure note for an owner interrupt reads "stopped by you" (`BotRunner.ts:750` already has an `aborted` branch).
- **Pause / resume** a bot's queue reuses `LaneControl.isPaused` (`RoomRouter.ts:300-305`, `:598-602`) with a second reason
  besides computer takeover. Label `Queue paused` (the queue) distinct from `Paused` (the screen,
  `ChatPane.tsx:97`). Resume lives on the chip and in the header badge's menu.
- **Crash-safe** through `lane_journal` and `FollowUp`. Phase 2 adds tests that cancelled and edited items survive a restart
  in their new state. Migration block **250-259** (see `docs/specs/decisions.md`): `lane_journal.status` (moved into
  Phase 1's migration, since the steer rows need it), `lane_journal.owner_ref` (Phase 3), `messages.cancelled_at`.

---

## (b) Workflows

### Problem / user story
"Every Monday at 09:00, have @research collect last week's GitHub issues, have @writer draft a summary, let me
approve it, then post it to #team." Today this is a routine plus hand-offs that the bots decide on themselves.
It works, but it is not repeatable step by step, and the owner cannot see or edit the chain.

### What we already have (the parts a workflow reuses)
| Part | Where | What a workflow uses it for |
|---|---|---|
| Schedules | `RoutineScheduler.ts:60-138`, `Routine` `models.ts:206-218`, time zone and one-shots | The trigger "Monday 09:00" |
| Event triggers | `TriggerService.ts`, `Trigger` `triggers.ts:89-107`, `fireTrigger` `RoomRouter.ts:582-594` (untrusted fencing, budget) | The trigger "new GitHub issue", "Slack message" |
| Turn per bot, crash-safe | `fireRoutine` `RoomRouter.ts:172-180`, `lane_journal`, `FollowUp` | Each agent step |
| Approvals that wait for a person | strict causes `RoomRouter.ts:343,493`, parked cards and resume `PermissionBroker.ts:300-320`, `resumeParked` `RoomRouter.ts:548-562` | The approval step parks until the owner answers, even at 3 a.m. |
| Forms in chat | `FormPayload` `models.ts:163-178`, `FormBroker.ts:27` | An approval step can show the draft plus approve / reject / "change this" |
| Hand-off | `handoff` tool `botTools.ts:342`, `dispatchFromBot` `RoomRouter.ts:215` | What workflows make deterministic |
| Automations page | `AutomationsPage` `FleetPages.tsx:35-42` (Routines plus Triggers) | Where workflows live in the UI |

### Editor UX: decided by the owner. Revised after review 2026-11-17
The draft recommended a step list without a canvas. The owner chose (05 §02 #3) a **canvas with React Flow
(`@xyflow/react`, MIT), lazy-loaded**, and asked that the data stay a plain step graph so a list view can render it on
phones. The design review confirms React Flow fits under the constraints in "Design: workflows" below; the concerns that led
to the original recommendation (touch, keyboard, screen readers) are handled by an always-available Steps list that shares
one step card with the canvas.
### Research: canvas libraries (read 2026-11-17)
| Library | Licence | Paid part | Size | Fit |
|---|---|---|---|---|
| **React Flow** (`@xyflow/react` 12.x; latest is 13.0.1, see risk 9) | MIT | "Pro" ($169-289/mo) sells examples, templates and support. No library feature is locked. A small attribution link shows by default and can be hidden with `proOptions`. | ~57 KB gzip (third-party figure, depscope) plus its CSS | Best React option. Lazy-load it on the Automations page only. Themeable through CSS variables, so it can map to our tokens. |
| Rete.js v2 | MIT | none | larger; plugin-based | Built for dataflow editors, more than we need |
| Hand-rolled SVG | ours | none | ~0 | Enough for a read-only diagram of a linear flow |
Sources: [React Flow Pro](https://reactflow.dev/pro), [npm @xyflow/react](https://www.npmjs.com/package/@xyflow/react),
[depscope size](https://depscope.dev/pkg/npm/@xyflow/react). OpenBot's renderer is SolidJS, so it does not use
React Flow. Its workflow node kinds are prompt, LLM, agent, image, trigger, condition, approval, output and
annotations (from `packages/contracts/src/ipc-workflows.ts`; read only).

The draft's options table (A step list, B canvas, C bot-authored playbook) is superseded: **B, as a view over a step graph
that a list also renders**, is the decided direction. C stays what hand-offs already do.

### Design: workflows (Phase 3). Revised after review 2026-11-17

**Data (additive migration, block 260-269).**
- `workflows(id, name, enabled, room_id, trigger_kind 'routine'|'trigger'|'manual', routine_id NULL, trigger_id NULL, graph_json, budget_usd, created_at, updated_at)`
- `workflow_runs(id, workflow_id, cause_id, node_id, status 'running'|'waiting'|'success'|'error'|'cancelled', outputs_json, cost_usd, started_at, ended_at)`
- `graph_json` is a **graph**: `{ nodes: [{ id, kind, ...fields, ui?: {x, y} }], edges: [{ from, to }] }`, zod schema in
  `shared/src/workflows.ts`. Node ids are stable.
- **v1 is linear only.** The validator refuses anything but a single path (one trigger node, each node at most one in-edge
  and one out-edge, no cycles, every node reachable) with a clear error. Branches can come later without a migration.
- **Layout is not data.** v1 does not write `ui`; the canvas lays a chain out automatically (left to right when wide, top to
  bottom when narrow), so no dagre/elk. `ui` is reserved for free placement later, and the engine never reads it.
- Node kinds:
  - `trigger {routineId | triggerId | manual}`.
  - `agent {botId, prompt}`: the prompt may use `{{previous}}`, the previous node's final text, fenced as data.
  - `approval {title}`: shows the previous output with Approve / Reject / Send back with a note. Send back re-runs the
    previous agent node once, with the note.
  - `output {target: 'room' | 'file'}`. Posting to Slack, GitHub and the like is an `agent` node using the integration tool,
    so it still goes through approvals.
  - `image`: deferred (05 §02 #4).

**Lane and journal foundations (pr-backend, task 3.2a).** A workflow step is a lane item, and the review found four places
where today's lane code would break it:
1. **Solo items.** A step item would otherwise be spliced into one turn with the owner's chat items in that lane
   (`RoomRouter.ts:319`), and the reply that answers both would become `{{previous}}`. Add `LaneItem.solo`: a solo item runs
   alone and nothing is batched with it.
2. **Park-safe owner ref.** `onDone` is skipped for parked turns only when the item has a `runId` (`:376`), and
   `resumeParked` rebuilds `onDone` only for routine runs (`:548-562`, `:559`). Generalise the journal's `run_id` and the
   parked record's `run_id` (`db/approvalStore.ts:57-61`) into an **owner ref** (`routine:<id>`,
   `workflow:<runId>:<nodeId>`, later `channel:<linkId>`), and rebuild `onDone` from it in both
   `FollowUp.resumeInterrupted` and `resumeParked`. A parked step then neither advances nor hangs the run after a restart.
3. **Journal rehydration has one owner.** FollowUp resumes any step that has a journal row. WorkflowRunner, on startup,
   only restarts runs that are `running` with **no** journal row (a crash between steps), and leaves `waiting` runs to their
   cards.
4. **Hop reset per step.** `MAX_HOPS` (default **3**, `config.ts:164`; the review said 5) over the whole thread would kill a 3-4 step workflow whose steps hand off once or
   twice. Each step starts at hop 0 on the run's cause. The cause cost cap and the run budget still cover the whole run:
   generalise the trigger budget hook `triggerLeft` (`:419`, `:436-444`) into `causeBudget(causeId)` so the run budget
   applies to every hop on the thread.

Also: add `'workflow'` to `CAUSE_KINDS` (`shared/src/models.ts:312`) and to `resumedCauseKind` (`RoomRouter.ts:565-568`,
which maps every non-user non-trigger thread to `'routine'` today). "Run now" puts `manual: true` on the cause payload; the
shared attended predicate (spec 01) reads it.

**Engine (task 3.2b): `services/WorkflowRunner.ts`.**
- A routine or trigger with a `workflow_id` creates a run instead of a plain prompt (`RoutineScheduler.fire` `:115`,
  `TriggerService`).
- Each agent node enqueues through a new `RoomRouter.fireStep()`, modelled on `fireRoutine` (`:172`): same thread, `solo`,
  strict (Q6), hop 0, `budgetUsd` = what is left of the run budget.
- The step's `onDone` stores `finalText` in `outputs_json` and advances `node_id` along the single out-edge.
- An approval node posts a **person-only card** (a new kind on the parked-card store), sets `waiting` and lists it in
  Needs-you. Cards expire after `MAX_PARK_MS` (24 h, `permissions/PermissionBroker.ts:73`).
- **Steering into a step** (allowed, 05 §02 #2): the answer becomes part of that step's output, and the steer is recorded on
  the run timeline. Stop or "send now" on a step ends the run as `error` with "stopped by you" and offers "Retry this step".
  Chat messages never answer a workflow approval card; only the card does.

**Security (principles).**
- A workflow is created or changed by the owner in the UI, or by a bot only through the fleet-approval `gate()`
  (`botTools.ts:216`), like `create_routine`.
- Every step is strict. The approval card is person-only: no bot, no `cta` button (`CtaButton` `models.ts:180` sends text
  as the owner) and no chat text can answer it.
- Budget per run and per day; cause cost cap over the whole run; hops reset per step as above.

**UI (pr-design-system, from review-design).**
- **Where it lives.** A new `Page` kind `{kind:'workflow', id}` that covers the chat like the other fleet pages, with a
  `FleetHeader` (name, Enabled switch, Run now), a `Tabs` switch **Canvas | Steps** (choice remembered per viewer in
  `localStorage`), and an inspector for the selected step (a 320 px column at `lg` and up, a wide `Dialog` below). The
  Automations page (`FleetPages.tsx:35-42`) gets a third section, "Workflows", linking to it.
- **One step card.** `components/workflows/StepCard.tsx` draws a step; the React Flow custom node and the list row both use
  it, so the two views cannot drift. Status is always a `Badge` with words (Waiting, Running, Done, Failed, Skipped). Warn
  colour appears only while a step needs the person; an approval step at rest is neutral.
- **Steps view** is an ordered list (`<ol>`, "Step 3 of 5"), always available, and is the accessible and phone view. Below a
  640 px container Steps is the default and the Canvas is read-only (pan and pinch).
- **Canvas** (`React.lazy(() => import('./workflows/WorkflowCanvas'))` behind `Suspense` with a `Skeleton`; the app's first
  lazy chunk):
  - **Add step with a "+" on each edge** (a focusable custom edge button via `EdgeLabelRenderer`), **not wire dragging**:
    React Flow has no keyboard way to connect nodes. Handles are hidden (`isConnectable={false}`), `nodesDraggable={false}`.
    Each node has a menu: Edit, Move up/down, Duplicate, Delete… (Delete through `confirmAction`). Each node has a real
    `aria-label` ("Step 2 of 4: Ada, agent").
  - Theming: import `@xyflow/react/dist/base.css` only, inside the chunk; map `--xy-*` variables to our tokens in one scoped
    `.wf-canvas` block; no `colorMode` prop. Dot background in `--line` on `--bg`; selected node `ring-2 ring-accent`.
  - Motion: no animated edges, `fitView` without duration, the running step uses the existing `.chip-running` shimmer (off
    under reduced motion), `zoomOnScroll={false}` with `panOnScroll`.
  - Keep React Flow's attribution link, restyled `text-hint text-dim` (hiding it is an owner call, not a design one).
- **Stale chunk after a hub update.** `sw.js` caches `/assets/*`; a tab opened before an update can fail to import a chunk
  hash that no longer exists. Catch the chunk-load error and reload once.
- **Bundle budget.** CI asserts `@xyflow` code is not in the entry chunk and the entry chunk stays under a set budget
  (pr-infra). React Flow brings its own zustand 4 (we use 5): accept the tiny duplicate.
- **Approval card.** Built on a new `ActionCard` primitive in `ui.tsx` (the `rounded-lg ring-1` shell that ApprovalCard,
  TakeoverCard and FormCard each re-implement today; extract it before adding the workflow card and spec 01's limit card).
  Approve (primary), Reject (danger), "Send back with a note" (inline `Textarea`). No `CtaButtons`.

---

## (c) Image and video generation steps

### Research: providers usable with the user's own key (read 2026-11-17)
| Provider | Access | Price model | Subscription covers it? | Third-party app / terms notes | Source |
|---|---|---|---|---|---|
| **Higgsfield API** (what OpenBot uses) | API key from its console, prepaid USD balance, $5 minimum, funds expire after 1 year | Per successful generation | **No.** "A subscription on higgsfield.ai and the API are two separate products with separate billing." | You own the outputs and can use them commercially. Resale and redistribution rules are not stated in the article; read the Terms of Use. | [Higgsfield: What is the Higgsfield API](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api) (modified 2026-09-24) |
| **Google Gemini API** (Gemini image models; video models) | AI Studio API key with Cloud Billing | Image about $0.034-0.15 per image by model and size; video about $0.07/s at 720p (`gemini-omni-1.2-flash`) | **No.** Google AI Pro/Ultra benefits apply in the AI Studio web UI only, and the API is billed separately. Developer Program Cloud credits may apply, amount not stated. | The image and video models show **no free tier** on the pricing page. On the free tier, data is used to improve products; on paid, it is not. | [Gemini API pricing](https://aistudio.google.com/docs/pricing), [Google AI plans](https://aistudio.google.com/docs/google-ai-plans) |
| Google Veo 3.1 / Imagen 4 (older ids) | Gemini API | Veo about $0.40/s, Imagen 4 $0.02-0.06 per image (third-party figures). One source says Veo 3.1 shuts down 2026-10-22. | No | Check before building on these ids | [benchlm Veo pricing](https://benchlm.ai/media-pricing/veo) (third-party) |
| **OpenAI** (GPT Image, Sora 2) | API key | Images billed by token (about $0.01-0.2 per image); Sora 2 $0.10/s at 720p, Pro $0.30-0.70/s | **No.** ChatGPT plans do not include API usage. | Standard API terms | [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) |
| **fal** | API key, prepaid credits | Per output (image or megapixel, video second), e.g. `fal-ai/flux/dev` $0.025 per image; failed calls free | No subscription | One key reaches many models, video included | [fal pricing docs](https://fal.ai/docs/documentation/model-apis/pricing) |
| **Replicate** | API token | Per prediction or per GPU second, about $0.003-0.09 per image (aggregator figures) | No | Standard API terms | [costbench Replicate](https://www.costbench.com/software/ai-productivity/replicate/) (third-party) |

**Takeaways.**
1. Every option costs money per image, and **none is covered by a plan the owner already has**. Claude Max
   cannot make images at all. The owner has no paid budget, so this can only ship as "bring your own key", and
   testing it live needs a few dollars from someone. The owner deferred this (05 §02 #4).
2. OpenBot also lists `codex` and `grok` as media providers. That suggests generation through the
   subscription CLIs (ChatGPT login, SuperGrok). This is **unverified for us**: we have no Codex or Grok account, and
   the terms for driving those plans from a third-party app need checking before we depend on it.
3. **Zero-code path, available today.** The owner can add any image-generation MCP server in Settings
   (`data/mcp-servers.json`, `api/mcpServers.ts`, `outsideMcp.ts`). Calls go through approvals
   (`claude.ts:304-311`). A short GUIDE section covers this until a native step exists.

### Decision: deferred (05 §02 #4). Revised after review 2026-11-17
No native image or video step now. Ship only the GUIDE note "Generate images today with an MCP server" (task 4.0). The
design below is kept for later.

On the owner's question whether ChatGPT can make images: the ChatGPT app can, but the OpenAI Images API is billed separately
and is not part of ChatGPT plans. Whether Codex CLI on a ChatGPT login exposes image generation is **unverified**; check it
only when Codex returns to scope.

### Design (Phase 4, later; not scheduled)
- A `generate_image` hub tool, also usable as a workflow `image` node, behind one provider interface.
- The key goes in `IntegrationVault` (`IntegrationVault.ts:29`, encrypted, never in the cloud) and each bot must be granted
  it (decision Q7).
- Every generation shows an approval card with the estimated cost (principle 4). A per-day media budget counts into `usage`.
- Output is saved to room files (`api/files.ts`), not chat media (`MAX_MEDIA_BYTES` 512 KB, `protocol.ts:120`).
- Video is an async job that reuses the WorkflowRunner `waiting` state. Migration block 300-309 is reserved for it.

---

## Tasks. Revised after review 2026-11-17

Owners: **BE** = pr-backend, **DS** = pr-design-system, **IN** = pr-infra. Sizes: S < half a day of agent work, M about one
pass, L needs splitting. Sizes follow the reviews' re-estimates.

### Phase 1: steering on Claude (ship first)
| # | Owner | Files | Change | Acceptance criteria | Verify | Size |
|---|---|---|---|---|---|---|
| 1.0 | BE + **owner** | scratch script (not shipped) | Spike on Claude Max with SDK `^0.3.278`, owner present. Push a second `SDKUserMessage` (with `uuid`) while the bot runs `Bash sleep 20`. Record: fold timing, `user_message_uuids` on each result, what `priority` changes, several results per query, Stop with a queued steer (receipt `still_queued`, then `close()`), `error_max_turns` with a queued steer, whether `maxTurns` resets per folded turn, and the minimum CLI version | Written finding in the PR, plus captured fixtures for 1.1 tests | manual, on Claude Max | S |
| 1.1 | BE | `providers/types.ts:147-180`, `providers/claude.ts:253-279,313-321,559-644` | `steer()` on `AgentProvider`; `ProviderInfo.steer`. Claude adapter: per-turn input channel, uuid-stamped pushes, loop until every uuid is answered, **usage tokens and duration summed across results**, cost from the last cumulative result, `TurnOutcome.steers {consumed, pending}`, **Stop = `interrupt()` receipt then `close()`**, same for the token brake (`:586-589`). **`canSteer` from the init capability `interrupt_receipt_v1`**; a result without `user_message_uuids` ends the read loop and returns all pushed uuids as `pending`. The outdated-CLI replay (`:276-278`) carries pending steers | A steer pushed mid-tool is answered in the same turn. A steer after the final result returns `false`. Stop with a queued steer stops, and returns the uuid as `pending`. Two results sum their tokens. No capability → `canSteer` false. A result lacking the field → all pushed uuids pending. A steer pushed before the replay is answered by the replay | unit tests with a fake `query()` emitting two results and an interrupt receipt | M/L |
| 1.2 | BE | `agent/BotRunner.ts:120-180,568-727,600-760` | `BotRunner.steer(botId, roomId, input)` gated on a **separate run-in-progress flag** (not `laneTurns`, which stays set `:568-727`); returns `false` between runs (stale retry `:615-632`, move-up `:636-637`, continuation `:676`) and for providers without `steer`. Steers through **the turn's starting provider**, never `providers.active()`. Carries `pending` steers into the next run on move-up, continuation and stale retry; returns the rest as `TurnResult.unansweredSteers` | No steer lands in a dead query; no pending steer is dropped across a retry; changing the active provider mid-turn does not redirect a steer | unit tests | M |
| 1.3 | BE | `rooms/RoomRouter.ts:161,186-212,345,366-370,447-466`, `api/rest.ts:414`, `db/migrations.ts` (block 250), `shared/src/protocol.ts`, `shared/src/models.ts`, `services/SettingsStore.ts` | `dispatchUser` steers busy targets (person, hop 0 only), else enqueues. Steer journal rows (`lane_journal.status = 'steered'`). **Cursor stays `lastSeenSeq = startSeq`; one `isConsumedSteer` helper filters `buildInjected`, `userImages`, `latestUserText`.** Re-enqueue `unansweredSteers` (including after Stop) with "runs next". Reassign a consumed steer's `cause_id`. `message.send.busy` plus the same `busy` field on REST `POST /api/rooms/:id/messages`, `settings.busyMessages`, per-bot maps `payload.steered` / `payload.queued` | No duplicate in the next turn. A Ctrl+Enter message or a pending hand-off sent during the turn is still unread next turn. After Stop the unanswered steer runs next. Bot hops never steer. Hub killed mid-turn: the steer is answered once on resume even when the parent item gave up. Routine-started turn stays strict | tests in `rooms/*.test.ts` (fake runner), including restart | M |
| 1.4 | DS | `components/ChatPane.tsx:315,813-896`, `store.ts`, `settings/*` | Send-mode menu next to Send (**Ctrl+Enter** queues); `canSteer` placeholder; status line under the bubble (not `SystemLine`); "continued" WorkLine on the same `turnId`; `aria-label` + `Tooltip` on Stop ("Stop all running bots in this room") and Send; the after-Stop note names re-queued steers; Settings default | Keyboard-only and phone flows work. AA contrast. No new motion. Copy never promises a join the hub did not confirm | manual: Claude Max, long task, steer it; screen reader pass | M |
| 1.5 | planner | `CHANGELOG.md` Unreleased, `docs/GUIDE.md` | Document steering, Ctrl+Enter, the per-provider limits, that Stop stops every bot in the room, and that unanswered steers are answered right after Stop | | review | S |

### Phase 2: queue controls
| # | Owner | Files | Change | Acceptance | Verify | Size |
|---|---|---|---|---|---|---|
| 2.1a | BE | `rooms/RoomRouter.ts`, `api/rest.ts`, `api/guard.ts:321`, `shared/src/protocol.ts` | `GET /api/rooms/:id/queue` (added to `DEVICE_ALLOW`), `queue.changed` event per lane with `{botId, roomId, paused, items[{journalId, messageId, text, editable}]}` | A paired phone sees the queue; a device cannot reach any other new route | tests | S |
| 2.1b | BE | `rooms/RoomRouter.ts:345,447-466,504-514`, `db/migrations.ts` (block 250), `db/repos.ts` | `queue.cancel {journalId}` per lane, `messages.cancelled_at` when no lane holds it, filtered through the **1.3 helper** in `buildInjected`/`userImages`/`latestUserText`. `queue.edit` with the refusal rules (read, steered, any cursor past it). `queue.sendNow {botId, roomId}` (interrupt, then run) | Cancelled and edited items survive a restart in their new state. A cancelled message never reaches the next turn. Edit refused once read or steered | tests incl. restart | M |
| 2.2 | BE | `RoomRouter.ts:300-305,598-602`, `services/ComputerControl.ts` | Pause/resume a bot's queue with a reason, separate from computer takeover | Paused bot runs nothing; resume drains | test | S |
| 2.3 | BE | `agent/BotRunner.ts:750`, `agent/turnFailure.ts` | An owner interrupt or send-now posts "stopped by you", not a failure | No red error note on Stop | test | S |
| 2.4 | DS | `ChatPane.tsx`, `store.ts` (`queues: Record<laneKey, LaneQueue>`) | Chip row + popover (Edit, Cancel, Pause queue, Send now… via `confirmAction`). Bubbles show only "Queued". `Queue paused` label distinct from `Paused` | Works at 360 px and from the keyboard. Edit refusal explains why | manual | M |

### Phase 3: workflows (graph data, canvas + Steps views)
| # | Owner | Files | Change | Acceptance | Verify | Size |
|---|---|---|---|---|---|---|
| 3.0 | DS | `web/src/components/ui.tsx`, `Cards.tsx` / `ChatPane.tsx` card call sites | Extract `ActionCard` (header icon, pending ring, action row) from ApprovalCard, TakeoverCard and FormCard; no visual change | Existing cards look the same in both themes | visual check, web tests | S |
| 3.1 | BE | `shared/src/workflows.ts` (new), `db/migrations.ts` (block 260), `db/workflowRepo.ts` (new) | `workflows` and `workflow_runs`; `graph_json {nodes, edges}` with stable ids; node kinds `trigger`, `agent`, `approval`, `output`; **linear-only validator** | Round-trip. A branch, cycle or orphan node is refused with a clear error. `ui` is accepted and ignored | unit | M |
| 3.2a | BE | `rooms/RoomRouter.ts:319,376,419-444,548-568`, `services/FollowUp.ts`, `db/approvalStore.ts:57-61`, `db/migrations.ts` (block 250: `lane_journal.owner_ref`), `shared/src/models.ts:312` | `LaneItem.solo`; owner ref replacing `run_id` in journal and parked records, `onDone` rebuilt from it in `resumeInterrupted` and `resumeParked`; `causeBudget(causeId)`; `'workflow'` cause kind; `manual` flag on cause payloads | Routines behave exactly as today (regression tests). A solo item is never batched. A parked owner-ref item resumes into the right `onDone` after restart | tests incl. restart | M |
| 3.2b | BE | `services/WorkflowRunner.ts` (new), `RoomRouter.ts` (`fireStep`), `RoutineScheduler.ts:115`, `TriggerService.ts` | Run engine: nodes in edge order, `{{previous}}` fenced, solo + strict + hop 0 per step, run budget, startup restarts only runs with no journal row, steers recorded on the timeline, Stop/send-now ends the run with "Retry this step" | Three-step run completes. Kill between steps resumes at the right node; kill mid-step resumes once (FollowUp) without a double run. Over budget stops with a note. A 3-step run with two hand-offs per step is not killed by `MAX_HOPS` | tests with a fake runner and fake clock | M |
| 3.3 | BE | `WorkflowRunner.ts`, card payload in `shared`, Needs-you | Person-only approval card kind on the parked-card store (Approve / Reject / Send back once), 24 h expiry | A 3 a.m. run waits for a morning answer. A bot, a cta or chat text cannot answer | tests | M |
| 3.4 | BE | `api/rest.ts`, `agent/botTools.ts` (`gate()` `:216`) | REST CRUD plus "Run now" (`manual: true`). Bot tools `create_workflow`/`update_workflow` behind fleet approval | Bot proposal shows a fleet card | `fleetApproval.test.ts` | S |
| 3.5a | DS | `FleetPages.tsx:35-42`, new `components/workflows/{WorkflowPage,StepCard,StepsList,Inspector}.tsx`, page routing | `{kind:'workflow'}` page, `FleetHeader`, Canvas/Steps tabs, StepCard, Steps list (`<ol>`), inspector (column at `lg`, Dialog below), Workflows section on Automations | Usable without docs; keyboard and phone; status in words | manual, axe | M |
| 3.5b | DS | `components/workflows/WorkflowCanvas.tsx` (lazy), `package.json` (`@xyflow/react` pinned to an exact version; **12 vs 13 decided before this task starts**, risk 9) | Lazy React Flow canvas: `base.css` only, `--xy-*` token map, auto-layout, "+" insert on edges, no handles, no drag, node menu, read-only below 640 px, attribution restyled, chunk-load error reloads once | `@xyflow` absent from the entry chunk; reduced motion respected; both themes | `vite build` chunk report, manual | M |
| 3.5c | DS | workflow page, `ChatPane.tsx`, Needs-you, Usage page (`FleetPages.tsx:248`) | Run view on canvas and list (per-step Badge and cost), run history, the approval card on `ActionCard` in chat and Needs-you, `workflow` cause label in Usage | A waiting run is obvious and answerable from Needs-you | manual | M |
| 3.6 | IN | new `scripts/bundle-budget.mjs`, `.github/workflows/ci.yml` | After `pnpm -r build`, assert no `@xyflow` code in the entry chunk and the entry chunk under a budget | CI fails if the canvas leaks into the entry chunk | CI | S |

### Phase 4: media steps (deferred by 05 §02 #4)
| # | Owner | Files | Change | Acceptance | Verify | Size |
|---|---|---|---|---|---|---|
| 4.0 | planner | `docs/GUIDE.md` | "Generate images today with an MCP server" section | | review | S |
| 4.1-4.4 | BE / DS | see the Phase 4 design | Not scheduled. Revisit after workflows ship and the owner funds a test key | | | — |

## Order and dependencies. Revised after review 2026-11-17
1. **1.0** spike (owner on Claude Max) → **1.1 + 1.2** in one PR → **1.3** (migration 250) → **1.4** (ships with 1.3). 1.5
   alongside 1.4. Backend Phase 1 is about three passes.
2. **2.3 and 2.2** (independent, S) → **2.1a → 2.1b** → **2.4**.
3. **3.0** any time before 3.3/3.5c. **3.1 → 3.2a → 3.2b → 3.3 → 3.4**; 3.2a touches the same `RoomRouter` blocks as 1.3, so
   start after 1.3 merges. DS: **3.5a** after 3.1 → **3.5b** → **3.5c** after 3.3. **3.6** with 3.5b. Backend Phase 3 is about
   four passes.
4. Phase 4 not scheduled; 4.0 any time.

## Risks. Revised after review 2026-11-17
1. **Folding is undocumented** (`priority` values undefined). Task 1.0 checks it. If a CLI update changes it, steering falls
   back to the queue. **Stop is not covered by that fallback**: a plain interrupt leaves uuid-stamped queued messages that
   "WILL run" (sdk.d.ts:4283), so the adapter must close the query after reading the receipt (task 1.1).
2. **Several results per query.** Cost, the token brake (`claude.ts:586-589`), `sessionCostUsd` and summed usage must handle
   two or more. Tests in 1.1.
3. **Cursor bugs.** Advancing `lastSeenSeq` wrongly hides messages (the `max(startSeq, steeredSeq)` draft rule did) or
   repeats them. Keeping `lastSeenSeq = startSeq` and filtering consumed steers through one helper (1.3) avoids moving the
   cursor at all; tests in 1.3 cover both directions.
4. **Cost attribution.** A steer spends the running turn's cause, possibly a hop-4 hand-off near its cap or a routine's
   budget. Accepted by the owner (05 §02 #2); the status line says so.
5. **Provider gap.** Only Claude steers. Gemini queues until Google ships a headless steer.
6. **Workflows overlap hand-offs.** The GUIDE says: hand-off for ad-hoc work, workflow for repeatable work.
7. **Canvas expectations.** A canvas invites branches and loops; v1 refuses them with a clear message, and the Steps view
   stays the accessible editor.
8. **First lazy chunk.** Stale chunk hashes after an update; handled by reload-once (3.5b) and the CI budget (3.6).
9. **React Flow major version.** The spec was written against 12.x, but the latest release is **13.0.1**. Before 3.5b,
   check 13's breaking changes against our use (`base.css`, `--xy-*` variables, custom nodes, `proOptions`, React 19 and
   zustand peers) and record the pin (exact 12.x or 13.0.x) in the 3.5b PR. Decision is open.

## Owner decisions (answered 2026-11-17, `05-owner-decisions.md`)
1. Busy bot: the message **joins the running turn**; **Ctrl+Enter** or the Send menu queues (Round 3); bot-to-bot hand-offs
   always queue. Stop re-queues unanswered steers and the bot answers them right after (Round 3).
2. Automation turns can be steered; they keep strict approvals and their budget.
3. Editor: **React Flow canvas, lazy-loaded**, over a plain step graph that a list view also renders.
4. Image and video: **deferred**; GUIDE note only.
5. Non-steering providers queue with a note; the Codex app-server rewrite is parked.
6. Queue controls: **cancel, edit, send now, pause**; no reorder.
