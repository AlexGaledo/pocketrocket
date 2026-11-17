# OpenBot gaps: backend review (pr-backend, 2026-11-17)

Reviewed specs 01, 02, 03 and the hub parts of 04 against `origin/main` @ 694db1a in this worktree. Where a spec
and `05-owner-decisions.md` disagree, 05 is applied. Line numbers below are from this worktree. "Required" means
the change is needed before that task is built; "risk" means it needs care or a test but not a design change.

SDK claims were checked against `@anthropic-ai/claude-agent-sdk` 0.3.269 `sdk.d.ts` in the main dev clone (this
worktree has no `node_modules`; `packages/hub/package.json` pins `^0.3.278`).

---

## Spec 02: Steering, queue, workflows (owner priority 1)

### Confirmed
- Lane model as described: `enqueue` `RoomRouter.ts:279-289`, `runLane` `:291`, batch `lane.pending.splice(0)` `:319`,
  `startSeq = maxSeq` `:324`, cursor save `:370`, frozen early return `:366`, journal add `:283-286`,
  pause `:300-305`, `LaneControl` `:598-602`, semaphore `:469-480`, `botLeftRoom` `:504-514`, strict `:343`, `:493-495`,
  `fireRoutine` `:172`, `fireTrigger` `:582-594`, `resumeParked` `:548-562`.
- `lane_journal` is migration 31 (`migrations.ts:124-133`); `FollowUp.MAX_RESUMES = 1` (`FollowUp.ts:10`);
  shutdown keeps the journal (`hub.ts:796-798`).
- Claude adapter: one-shot generator `claude.ts:314-321`, `break` on first result `:635-636`, `this.active` `:560`,
  `interrupt()` `:253-258`, cumulative `total_cost_usd` `:620-622`.
- `BotRunner.interrupt` `:163-168`, stale retry `:615`, move-up `:636-637`, failure note `:750`.
- SDK: `SDKUserMessage.priority?: 'now'|'next'|'later'` (sdk.d.ts:5712) and `uuid?` (:5763); `user_message_uuids` on
  results and assistant frames (:3358, :5107, :5311, :5342); `Query.streamInput()` (:2942); `interrupt()` resolves to a
  receipt with `still_queued` (:2621, :4279-4285); `cancel_queued` exists only on the raw control request (:4273-4275),
  `Query.interrupt()` takes no arguments. `Query.close()` kills the CLI process (:2964-2971).
- Dropping reorder is right: a lane runs all pending items as one turn.

### Wrong or imprecise claims
| Claim | Correction |
|---|---|
| Continuation at `BotRunner.ts:670` | The step-limit loop starts at `:676`; `:670` is the end of `moveUp`. |
| Token brake `claude.ts:578-581` | It is `:586-589`. |
| `MAX_PARK_MS` at `PermissionBroker.ts:72` | `:73`. |
| "A steer needs no new journal row; the frozen path is crash-safe" | Only half true. If the running item already has `attempts >= MAX_RESUMES`, FollowUp gives up on it (`FollowUp.ts:89-96`) and the steered message, which has no row of its own, is never answered. |
| "`lastSeenSeq = max(startSeq, steeredSeq)`" fixes the cursor | It introduces the read-marker bug below. |
| Risk 1 "fallback is the queue, today's behaviour" | Not for Stop. Per sdk.d.ts:4283 a plain interrupt leaves uuid-stamped queued messages in the CLI and they "WILL run". With the proposed "read until every uuid is answered" loop, Stop would interrupt the current step and then run the steered message as a new turn. |

### Read-marker bug in the proposed cursor rule (required fix)
Messages between `startSeq` and `steeredSeq` that were **not** steered get marked read: an Alt+Enter queued message,
another bot's report that mentions this bot (it sits in `lane.pending` with `triggerSeq` below `steeredSeq`), or group
chatter. The next turn's `buildInjected(messagesAfter(lastSeenSeq))` (`RoomRouter.ts:455-466`) then never shows them; a
pending hand-off item would get "(No new messages; you were triggered on #N)".
**Fix:** advance the cursor only over a contiguous prefix: the largest `s` such that every conversation message from
someone else in `(startSeq, s]` is a steer the provider *consumed*. Anything else stays unread. DB-only, no new state.

### Steering edge cases the spec misses (required)
1. **Consumed, not accepted.** `steer()` returning `true` only means "pushed". The turn can still end before the CLI
   folds it in: abort/Stop, token brake, `error_max_turns`, stale-session retry (`BotRunner.ts:615-632` starts a new
   `query()`), outdated-CLI replay (`claude.ts:260-279` calls `runOnce` again with the original `ctx.input`), budget stop.
   Add `TurnOutcome.steers: { consumed: string[]; pending: string[] }` (uuids from `user_message_uuids` and the interrupt
   receipt). BotRunner carries `pending` steers into the next run's input when it continues (move-up, continuation,
   stale retry) and returns the rest on `TurnResult.unansweredSteers`. RoomRouter enqueues those as normal user items.
   Since the router skipped `enqueue` on a successful steer, without this an unconsumed steer is silently lost.
2. **Stop with queued steers.** On abort, the adapter must `interrupt()`, read the receipt, then `q.close()` and stop
   reading. The surviving uuids go back as `pending` (re-queued with a note "your message will run next"), so Stop stops.
   Same for the token brake's internal interrupt (`claude.ts:588`).
3. **Several results per query.** Cost from the last `total_cost_usd` is right, but `usage` tokens and `durationMs` are
   per result and must be **summed** (`claude.ts:628-634` overwrites them). `ok`/`error` come from the last result.
   The spike (1.0) must also record whether `maxTurns` resets per folded turn.
4. **Crash mid-steer.** Journal each accepted steer as its own `lane_journal` row (status `steered`), removed when
   consumed. A crash then resumes it even when the parent item gives up, and Phase 2's `status` column covers it
   (move the column into Phase 1's migration). Accept that a resumed session may show the steer twice (once in the CLI
   transcript, once unread); `RESUME_NOTE` already tells the bot to check what is done.
5. **Start-up window.** Between `lane.pending.splice(0)` (`:319`) and `laneTurns.set` (`BotRunner.ts:568`) the lane is
   running but has no turn (semaphore wait, rotation summary, classifier, computer start). `steer()` correctly returns
   false and the message queues, but the UI note must not say "this bot cannot take messages mid-turn" there; say
   "queued" only.
6. **Cost.** A steer spends the running turn's cause, which may be a hop-4 hand-off near its $5 cap. Fine per 05 #2, but
   the composer note should say when the turn is a hand-off or automation.
7. **Cause id.** The steered message keeps `cause_id = itself` (`RoomRouter.ts:161`), so it is a cause with no turns.
   Set its `cause_id` to the running turn's cause when the steer is consumed, so threads and usage group correctly.

### Queue controls (Phase 2) required changes
- **Cancel must be message-level, not only journal-level.** The cursor reads `messagesAfter(lastSeenSeq)`, so a
  cancelled message is shown to the next turn unless `buildInjected`, `userImages` (`:447-453`) and `latestUserText`
  (`:345`) filter it. Add a message flag (`messages.cancelled_at`, or payload) and filter in those three places.
- **Per-lane vs per-message.** One user message can target two bots (two lanes). Define cancel as per-lane (remove that
  lane's item; mark the message cancelled only when no lane still holds it).
- **Edit refused once read** must also refuse when any lane steered it, and when any member's session cursor is past its
  seq.
- Add `GET /api/rooms/:id/queue` to `DEVICE_ALLOW` (`guard.ts`), or phones cannot see the queue. Queue WS events need
  the same device rules as `message.send`.

### Workflows (Phase 3) required changes (05 #3: canvas with React Flow)
1. **Data is a graph.** `steps_json` becomes `{ nodes: [{id, kind, ..., ui?: {x,y}}], edges: [{from, to}] }`. The v1
   engine refuses anything but a single path (each node at most one out-edge, no cycles) with a clear error, so a list
   view and the canvas render the same data and branches can come later without a migration.
2. **No batching.** Today a step item would be spliced into one turn with the owner's chat items in that lane
   (`:319`); the step's `onDone` would get a reply that also answers chat, and that becomes `{{previous}}`. Add
   `LaneItem.solo`: a solo item runs alone and is not batched with others (small change in `runLane`).
3. **Parked steps.** `onDone` is skipped for parked turns only when the item has a `runId` (`:376`), and `resumeParked`
   rebuilds `onDone` only for routine runs (`:559`). Workflow steps need the same: a parked step must not advance.
   Generalise the journal's `run_id` and the parked record's `run_id` (`approvalStore.ts:57-61`) into an owner ref
   (`routine:<id>` / `workflow:<runId>:<step>`), and rebuild `onDone` from it in `FollowUp.resumeInterrupted` and
   `resumeParked`. Otherwise a step resumed after a restart finishes into nothing and the run hangs in `running`.
4. **One resume owner.** WorkflowRunner must not re-enqueue a step on startup when its journal row exists (FollowUp
   resumes it). It only re-starts runs that are `running` with no journal row (crash between steps).
5. **Hops.** "Hop and cause caps apply to the whole thread" with `MAX_HOPS = 5` kills a 3-4 step workflow whose
   steps hand off once or twice. Each step starts at hop 0 on the run's cause; the cause cost cap and the run budget
   still cover the whole run. The run budget must apply to every hop on the thread, like `triggerLeft`
   (`:436-444`): generalise that hook to `causeBudget(causeId)`.
6. **Usage.** Add `'workflow'` to `CAUSE_KINDS` (`shared/models.ts:312`), used by `resumedCauseKind` (`:565-568`, which
   today maps every non-user non-trigger thread to `'routine'`).
7. **Manual runs.** "Run now" is person-started. Put `manual: true` on the cause payload; the attended check
   (cross-spec section) needs it for Gemini.
8. **Steering into a step** (05 #2 allows it): the answer becomes part of the step output. Record steers on the run
   timeline. Stop or "send now" on a step ends the run as `error` with "stopped by you" and offers "Retry this step";
   chat messages never answer a workflow approval card (only the card does).

### Size re-estimate
| Task | Spec | Review |
|---|---|---|
| 1.1 adapter | M | M/L (input channel, multi-result loop, consumed/pending uuids, Stop + close) |
| 1.2 runner | S | M (carry pending steers across move-up/continuation/stale retry, return unanswered) |
| 1.3 router | M | M (contiguous cursor, re-queue unanswered, steer journal rows) |
| 2.1 queue | M | M/L (message-level cancel and filters, edit checks, device allowlist) |
| 3.1 schema | S | M (graph + linear validator + owner-ref generalisation) |
| 3.2 engine | M | L: split 3.2a lane/journal changes (solo, owner ref, hop reset, budget hook) and 3.2b WorkflowRunner + resume |

Backend Phase 1 is about 3 passes, not 2-3; Phase 3 backend about 4.

---

## Spec 01: Providers + failover (owner priority 2)

### Confirmed
- Global provider: `registry.ts:74` `active()`, `BotRunner.ts:186`; Claude gates at `:196`, `:264`, `:279`, `:320`,
  `:421`, `:436`; `interrupt()` uses `active()` (`:165`): the latent wrong-provider bug is real.
- Sessions per provider with stale-token check (`repos.ts:291-304`); `buildSeed` (`SessionRotation.ts:84`).
- Auto-memory / distiller / reflection / training gated on `activeProvider()` (`hub.ts:250`, `:296-300`,
  `AutoMemory.ts:346`). Auto-memory runs on Haiku (`AutoMemory.ts:28`).
- Env allowlist (`providers/env.ts:25-38`), `ENABLED_PROVIDERS` (`config.ts:184-188`), hub tools gated with the tool
  (`BotRunner.ts:313-317`), `/mcp` with a per-turn bearer (`mcp/httpServer.ts`, `hub.ts:603`).
- SDK: `SDKRateLimitInfo.status 'allowed'|'allowed_warning'|'rejected'`, `resetsAt`, `rateLimitType`, `utilization`
  (sdk.d.ts:5252-5262); `SDKAssistantMessageError` includes `rate_limit`, `overloaded`, `billing_error`,
  `authentication_failed` (:3411); `fallbackModel` option (:1559).

### Wrong or imprecise claims
| Claim | Correction |
|---|---|
| Migration block 250-259 | Collides with spec 02's proposed 250-259. See allocation below; providers get 270-279. |
| P1-4 "keep the last token per provider so switching back is cheap" | Unsafe as specced. `session_state` (`costTotal`, `contextTokens`, snapshots) is **not** per provider; a switch resets `costTotal` to 0 (`BotRunner.ts:219`). Resuming the old Claude session later passes baseline 0 to `sdkBudgetUsd` (`claude.ts:535`), the CLI compares the flag with the session's real cumulative cost and stops the turn at once. Drop it: switching back reseeds. |
| P1-4 implies seeding is new | Today a provider switch already drops the token (stale check) **without** a seed, so the bot loses context. P1-4 fixes an existing bug; say so. |
| §6/P3 "off by default, backup chain" | Overridden by 05 #2: ask with a card. P3-1/P3-2 must be rewritten (below). |

### Required changes
1. **Failover card must not hold a slot.** Waiting in `runTurn` for a card holds one of the 4 global turn slots
   (`RoomRouter.ts:307`) and the lane for up to 10 min. Instead: the limited turn ends at once with the note
   "Claude 5-hour limit reached, resets 14:00" and a card "Continue on <backup>?". Pressing it enqueues a new item on the
   same cause with `providerOverride` and `forceStrict` (05 #3). The card expires at `resetsAt`. Unanswered (routine,
   trigger, or a person who walked away) = the turn already ended with the reset time, so nothing switches silently.
   This is the parked-card pattern (`PermissionBroker.ts:300-320`, `resumeParked`) with a new card kind.
2. **Attended predicate.** One function used by the Gemini guard (05 #1), the failover card and steering:
   attended = the thread's root is a person's message (`requiresApprovals(causeId) === false`, so hand-offs inside it
   count), or a manual "Run now", or an owner card press (the failover card). FollowUp nudges and restart resumes inherit
   the thread's answer. Routines, triggers, workflow schedules and timed retries are unattended.
3. **Gemini API-key exception keyed on actual auth.** "Runs if a key is set" must check what `agy` reports it is using
   (`check()` auth method), not that a key exists; otherwise an unattended turn can run on the OAuth login. Store the key
   in the secrets store, add `GEMINI_API_KEY` (or what `agy` documents) to a new `ProviderKind` in `env.ts` only.
4. **ACP permission mapping.** `PermissionBroker.decide()` classifies by Claude tool names (path tools, `Bash` via
   `classifyBash`). `agy` will ask with its own names, so every request falls through to "otherwise a card" (safe but
   noisy) or, if mapped loosely, wrongly allowed. Map ACP `ToolKind` + `locations` to broker categories: `read`/`edit`
   with locations through `pathRules.isInside` (realpath), `execute` through `classifyBash` when the command is
   present, everything else a card. Strict backups (05 #3) also need `agy` started in its most restrictive approval
   mode; if it has none that asks for writes and shell, the backup must be read-only (spec Q3 option c).
5. **Limit result shape.** On subscriptions the CLI has reported the limit as a *successful* result whose text is the
   limit message. P0-1 must turn assistant `error: 'rate_limit'` (and a rejected `rate_limit_event`) into `ok:false`
   so the limit text is never posted as the bot's reply or run through `parseMentions`. Capture a real fixture on Max.
6. **Claude-only passes while Claude is limited.** Auto-memory, rotation summaries (`BotRunner.ts:765`), skill
   reflection and training all call Haiku on the same login. While `ProviderHealth` holds Claude, skip them (rotation
   already tolerates a failed summary). `claudeReady()` (P1-6) should include "not held".
7. **Per-bot provider leftovers.** `BotRunner.lastInit` (`:125`) and `/api/debug/last-init` become last-writer-wins
   across providers: key them by provider. `MAX_CONCURRENT_TURNS` stays global (fine, say so).

### Size re-estimate
P0-1 S/M; P1-2 M; P1-4 S once the per-provider token map is dropped; P2-1 L (adapter plus permission mapping, split
2.1a transport/session, 2.1b permissions/MCP); P2-3 S on top of the attended predicate; P3-1 M/L (card kind, override,
re-queue). Phase 3 is larger than the spec's because of the card.

---

## Spec 03: Chat channels (05 #6: Telegram notifications only now)

### Confirmed
- Loopback bind `config.ts:74`; push is content-free `{kind}` with 30 s coalescing (`PushService.ts:8-21`, `:131-137`);
  strict for non-user authors (`RoomRouter.ts:493-495`); `ownerTag` only on `authorType 'user'` (`:60`,
  `SettingsStore.ts:189`); device answers once (`PermissionBroker.ts:124`, `:681-686`); `INTEGRATION_PROVIDERS`
  (`shared/integrations.ts:5`).

### Wrong or imprecise claims
| Claim | Correction |
|---|---|
| `RoomKind` at `protocol.ts:158` | `RoomKind` is `models.ts:101`; `protocol.ts:158` is the room input schema's `kind` enum. |
| A3 "a second sink in `notify()`" | `notify()` returns early when there are no Web Push subscriptions and sets the shared coalesce stamp first (`PushService.ts:131-137`). A Telegram-only owner would never be notified. Each sink needs its own gate and coalesce stamp. |
| B1 "add a `'channel'` MessageKind" is enough | Also needed (Phase B, deferred): `isConversation` (`:54-56`) or the bot never sees the message, `formatMessage` author label (`:61`), `resumedCauseKind` (maps it to `'routine'` today), `CAUSE_KINDS`, usage breakdown. |

### Required for Phase A
1. **Long-poll lifecycle.** Even notify-only needs `getUpdates` for the link code (A2). Each `fetch` gets an
   `AbortController` that `hub.ts` shutdown aborts (else close waits up to 50 s); acknowledge with `offset = last+1`;
   stop polling once linked (Phase A needs no standing poll). Show 409 as "another PocketRocket or a webhook uses this
   bot"; never call `deleteWebhook` on the owner's behalf.
2. **Token hygiene.** The token sits in the URL path (`/bot<token>/`). `addSecret` it when loaded, and make sure
   `apiRequest` errors and logs go through `redact`.
3. **Owner identity by numeric id.** Accept the code only when `chat.type === 'private'`, `from.is_bot === false`,
   `from.id === chat.id`, and the update's `date` is after the code was issued. Code: at least 8 random base32
   characters, single use, 10 min, and lock linking after about 5 wrong codes. Offer the `t.me/<bot>?start=<code>` deep
   link. Store `from.id` in the vault entry; never match on username or display name.
4. **Scope conflict with 05 #2.** "Allow once / Deny from chat" needs a standing poll for `callback_query`, and an
   Allow button on a content-free message approves blind. Keep Phase A content-free with no buttons; Q2a ships with
   chat (Phase B), as spec 03 §8 already orders it.

### Size re-estimate
A1 S, A2 M (lifecycle, checks, lockout), A3 S (PushService restructure). Phases B-E unchanged and deferred.

---

## Spec 04 (hub parts only)

### `GET /api/busy` (A3)
- Confirmed: new routes are refused to devices by default (`DEVICE_ALLOW` in `guard.ts`), so device tokens are blocked
  without extra work.
- **Required: define "busy" as work a restart would lose.** Parked cards wait up to 24 h (`MAX_PARK_MS`) and survive a
  restart (approval store), as do journaled lane items and waiting workflow runs. Counting them means a hub with one
  parked routine card never updates. Busy = running turns (`BotRunner.activeTurns`) + live, unparked cards + lanes with
  pending items. Report parked cards and waiting runs separately for the dialog text.
- **Required: avoid check-then-install races.** A routine can fire between the check and the installer killing
  `node.exe`. Add `POST /api/maintenance/hold {minutes}` (hub token only): the router stops starting new turns (items
  stay journaled, like `freeze()` but reversible) until released or expired, and `busy` then drains to 0. Size S.

### Multiplayer notes (deferred by 05 #3, recorded for later)
- `MAX_ROOM_BOTS = 20` (`models.ts:2`) is correct on main.
- **Strictness rule must change first.** `requiresApprovals` is `authorType !== 'user'`. With members, a member's
  message would run under the owner's bypass. It must become "authored by the owner", before any member can post.
- Steering by members: only into turns of threads the same person started, or never; decide with C3.
- `decided_by` (`PermissionBroker.ts:304`, `:662`, `repos.ts:532`) and `ownerTag` (`RoomRouter.ts:60`,
  `botTools.ts:455`, `:1348`) are confirmed as listed.

---

## Cross-spec

### Shared foundations (build once, in the first spec that needs them)
| Foundation | First needed by | Also used by |
|---|---|---|
| `LaneItem` extensions: `solo`, `forceStrict`, `providerOverride`, owner ref | 02 Phase 3 (`solo`, owner ref) | 01 failover (`forceStrict`, `providerOverride`), 03 Phase B |
| Journal/parked owner ref (`routine:` / `workflow:` / later `channel:`) so `onDone` is rebuilt after restart and park | 02 Phase 3 | routines today (replaces `run_id`), 03 origin replies |
| `TurnOutcome.steers`, `TurnResult.unansweredSteers` | 02 Phase 1 | 01 failover (re-queue onto the backup) |
| `isAttended(causeId, item)` predicate + `manual` flag on cause payloads | 02 Phase 3 (Run now) | 01 Gemini guard and failover card |
| Person-only decision cards (workflow approval, failover) on the parked-card store with a `kind` | 02 Phase 3 | 01 P3 |
| `CAUSE_KINDS += 'workflow' \| 'channel'` | 02 Phase 3 | 03 Phase B, usage tab (DS) |
| `GET /api/busy` + maintenance hold | 04 A4 | release safety for all of the above |

### Conflicts between 05 decisions and specs
1. **Failover "ask with a card" vs unattended turns** (05 #2 vs 01 P3): resolved by the slot-free card above; the turn
   always ends with the reset time and only a press continues.
2. **Failover card vs Gemini rule** (05 #1): a press counts as attended, so a routine whose card the owner presses runs
   on Gemini as person-approved. A timed retry never does.
3. **Strict backup vs Gemini permission parity** (05 #3): strict only means something if `agy` asks. Verify in P2-4; else
   read-only backup.
4. **Steering + workflows** (05 #2, #3): allowed, but steps run solo, steers are recorded on the run, and Stop/send-now
   ends the run with "Retry this step".
5. **Telegram Allow-once (05 #2 of gap 3) vs notify-only scope (05 #6)**: defer Q2a to chat.
6. **Owner chose the canvas (05 #3)**: backend stores a graph; the list view on phones reads the same data.
7. **Auto-memory Claude-only vs failover**: skip Claude passes while Claude is limited.

### Migration block allocation (next free after 240-249; no unmerged `origin/*` branch claims a block)
| Block | Use |
|---|---|
| 250-259 | Gap 2 Phase 1-2: `lane_journal.status`, `lane_journal.owner_ref`, `messages.cancelled_at` |
| 260-269 | Gap 2 Phase 3: `workflows`, `workflow_runs` |
| 270-279 | Gap 1: `bots.provider`, `bots.fallbacks`, `usage.provider` |
| 280-289 | Gap 3: `channel_links`, Telegram offset/link state |
| 290-299 | Gap 4 multiplayer: `user_invites`, `room_members` |
| 300-309 | Gap 2 Phase 4 media (if ever) |

The planner should add these to the block table in `docs/specs/decisions.md` (it stops at P9) and fix spec 01 §4.1/§8.

### Recommended backend build order (steering + workflows first)
1. **1.0 spike** on Claude Max (owner present): fold timing, `priority`, multiple results, Stop with a queued steer,
   `error_max_turns` with a queued steer, whether `maxTurns` resets per folded turn.
2. **1.1 + 1.2** in one PR: input channel, consumed/pending uuids, Stop closes the query, summed usage, runner carries
   pending steers across runs.
3. **1.3**: contiguous cursor, re-queue unanswered steers, steer journal rows (migration 250), protocol `busy` field.
4. **2.3 + 2.2** (S each, independent): "stopped by you" and queue pause.
5. **2.1** queue controls (cancel/edit/send now, message-level cancel).
6. **04-A3** `/api/busy` + hold (S); slot it here so the updater is never blocked on us.
7. **3.1 → 3.2a → 3.2b → 3.3 → 3.4** workflows (graph schema, lane/journal foundations, runner, approval card, REST and
   gated bot tools).
8. **01 P0-1..P0-4** Claude limit parsing (can run in parallel from step 4; small and owner-testable).
9. **03 A1-A3** Telegram notify (filler after step 5).
10. **01 P1 → P2 (ACP + Gemini, owner live test) → P2-3 → P3** failover card.
11. Deferred: 03 Phases B-E, 04 Phase C, 02 Phase 4.

### Follow-ups for other agents
- **pr-planner:** rewrite spec 01 P3-1/P3-2 for the card flow; drop the per-provider token map from P1-4; change spec 02's
  cursor rule and 3.1 data model as above; record the migration blocks in `decisions.md`; fix the line numbers in the
  tables above.
- **pr-design-system:** steer, queue and failover need new client handling: `message.send.busy`, the
  `payload.steered` and "will run next" notes, a cancelled-message style, the failover card kind, the workflow approval
  card, new `CAUSE_KINDS` labels in the Usage tab, and the canvas reading `{nodes, edges}` with `ui.{x,y}`.
- **pr-infra:** the updater (04 A4) should call the maintenance hold, then poll `/api/busy`, rather than check once.
