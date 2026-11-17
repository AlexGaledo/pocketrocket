# OpenBot gaps: concluded direction

Concluded 2026-11-17 from `00-openbot-recon.md`, specs `01`-`04` (revised after review the same day),
`05-owner-decisions.md` (authoritative, including Round 3 after the readiness review), and the three reviews (`review-backend.md`, `review-design.md`,
`review-infra.md`). Code references are against `origin/main` @ 694db1a. Migration blocks and the key decisions are
recorded in `docs/specs/decisions.md`.

## Verdict

PocketRocket should close the OpenBot gaps that make a single owner's fleet better, and decline the ones that only make
sense for a hosted, multi-account product. All four gaps are feasible at $0 within our principles. **Steering** works today
on Claude because the Agent SDK already folds a message into a running turn in streaming-input mode. **Workflows** reuse
routines, triggers, approvals and lanes, with four lane changes and a lazy React Flow canvas over a plain step graph.
**Gemini** is the one second provider the owner can verify and the terms allow: through `agy acp`, on attended turns only
unless the CLI reports API-key auth. **Failover** asks with a card and never switches on its own. **Telegram** ships as
content-free notifications. **Distribution** gets a draft-then-finalize release pipeline, a Rust-only updater that installs
only when the hub is idle, attestations, and a SignPath application that will probably fail while the Agent SDK is bundled.
We do not chase OpenBot on pooled accounts, WhatsApp, relays, native mobile apps, hosted seats or CLI downloads: each one
breaks a provider's terms, principle 1, or the $0 budget. Build order follows the owner: steering, queue and workflows first
(with the pr-infra release lane in parallel), then providers.

## Feasibility per sub-feature

Effort is the total agent effort after the reviews' re-estimates (S < half a day, M about one pass, L needs splitting).

| Gap | Sub-feature | Verdict | Licensing / terms status | Compat effort | Owner decision (05) |
|---|---|---|---|---|---|
| 2 | Steering into a running turn | **Go** (Claude); others queue with a reason | Clean: our own adapter over the SDK's documented streaming input | BE M/L + M + M, DS M | Joins the turn; Ctrl+Enter or the Send menu queues; hand-offs queue (§02 #1, Round 3 #2); Stop re-queues unanswered steers (Round 3 #3) |
| 2 | Steering automation turns | **Go**, strict and on their budget | n/a | in the above | Allowed (§02 #2) |
| 2 | Queue controls | **Go**, no reorder | n/a | BE S + M + S + S, DS M | Cancel, edit, send now, pause (§02 #6) |
| 2 | Workflows | **Go**: `{nodes, edges}` graph, v1 linear, canvas + Steps list | React Flow MIT (keep its attribution link); OpenBot not copied | BE 4 passes (S-M each), DS 3 x M + S, IN S | Canvas, lazy-loaded; list view on the same data (§02 #3) |
| 2 | Image / video steps | **Deferred**; GUIDE note on image MCP servers | No subscription covers image APIs; ChatGPT plan ≠ OpenAI API | planner S now | Defer (§02 #4) |
| 2 | Codex steering (app-server) | **Parked** | Codex CLI Apache-2.0 | L, not scheduled | Parked (§02 #5) |
| 1 | Provider per bot + keep the agent | **Go** | n/a | BE S-M x 7, DS M + S | — |
| 1 | Claude limit detection + plan meter | **Go** | n/a | BE S/M + S x 3, DS S + S | — |
| 1 | Gemini through `agy acp` | **Go**, attended turns only on the Google login | `agy` proprietary: never bundled or downloaded; a forum reply (author's staff status unverified) allows a private single-user client running the unmodified `agy acp`, not unattended automation (not binding) | BE L (split) + S, IN S | Person-started only; runs unattended if a Gemini API key is set (§01 #1); ships after live test (§01 #4) |
| 1 | Failover on usage limit | **Go**, card flow | Unattended failover onto Gemini would breach Google's rule; the card press makes it attended | BE M/L, DS M | Ask with a card (§01 #2); backup always strict (§01 #3) |
| 1 | Codex / Grok / OpenCode adapters | **Frozen**, dev-only | Codex Apache-2.0, Grok Build Apache-2.0, OpenCode MIT; OpenCode on Claude or Google OAuth is prohibited | none | Dev-only, frozen (§01 #6) |
| 1 | Local models (Ollama etc.) | **Deferred** | Ollama MIT; LM Studio freeware | M, unverifiable (no GPU) | — |
| 1 | Pooled / rotated accounts | **No** | Breaks Anthropic's individual-use and account-sharing terms and Google's "automated account rotation" exclusion | — | — |
| 1 | Managed CLI download / pinning | **No** download; version check only | Claude Code and `agy` are closed source with no licence to redistribute | in P2-2 | — |
| 3 | Telegram notifications | **Go now**, content-free | Bot API ToS fine for notify; token in the URL path must be redacted | BE S + M + S, DS S-M, IN S | Scope now (§03 #6) |
| 3 | Telegram owner-only chat | **Later** | §4.4 encryption at rest: not needed while owner-only, needed before allowlists | BE M x 2 + S x 2, DS M | Auto-reply, owner only, Allow once later (§03 #2-#5) |
| 3 | Discord / Slack channel mode | **Later** | Discord bot apps only (no self-bots); Slack internal apps exempt from the 1/min history limit; no LLM training on either | M each | Wait (§03 #6) |
| 3 | Teams two-way | **No** (stays a trigger) | Needs a public HTTPS endpoint | — | — |
| 3 | WhatsApp | **No** | Meta §4.7 bans "general-purpose artificial intelligence assistants"; unofficial clients breach WhatsApp's Terms | — | None; revisit after a paid launch (§03 #1) |
| 4 | Auto-updater | **Go** | Tauri MIT/Apache; GitHub Releases free | IN S + M + M, BE S, DS S | Daily check, ask first, never mid-turn (§04 #6); ships in v0.3.0 (Round 3 #1) |
| 4 | Windows signing | **Unsigned + attested now**; SignPath applied | SignPath bars proprietary components; the bundled Agent SDK is "All rights reserved", so expect "no" unless it is fetched at first run | IN S (+ L if A10) | Unsigned now, SignPath in parallel, unbundle only after the answer (§04 #1) |
| 4 | Linux / macOS installers | **Go** (verify; macOS stays unsigned) | Notarization costs 99 USD/yr: later | IN M | — |
| 4 | Server one-line installer | **Go** | n/a | IN S + L | — |
| 4 | Docker | **Go**, headless, no closed CLIs inside | Image must not redistribute Claude Code or `agy` | IN M | Linux `--network host` first (§04 #5) |
| 4 | Nix / Umbrel | **No** (now) | Umbrel's LAN exposure conflicts with principle 1 | — | — |
| 4 | Native iOS / Android | **No** (now) | Store fees; PWA already chosen (Q9) | — | — |
| 4 | Multiplayer | **Deferred** | Several humans on one Pro/Max login is outside "individual usage" | BE 6 x M + S, DS M | After gap 1 credentials, API key or Team/Enterprise only (§04 #3) |
| 4 | Hosted servers / seats | **No**; managed self-host if ever | Anthropic forbids routing users' subscription credentials; BYO API key only | — | Managed self-host first (§04 #4) |
| 4 | Licence | **MIT + CLA** | Keeps SignPath eligibility and relicensing options | IN S | MIT + CLA (§04 #2) |

## Licensing and terms summary

- **OpenBot, clean room.** OpenBot is PolyForm Noncommercial 1.0.0. Agents may read its source and docs to learn behaviour;
  no code, identifiers, strings, UI copy, layouts or assets enter PocketRocket. The design review did not open OpenBot's UI.
- **Anthropic subscription rule.** Driving the user's own unmodified `claude.exe` login is the defensible pattern, and
  PocketRocket already prunes the SDK's vendored CLI (`scripts/build-hub.mjs:110-129`). The Claude Code legal-and-compliance
  page says Agent SDK developers "should use API key authentication" and may not route requests "through Free, Pro, Max, or
  Ultra plan credentials on behalf of their users", but this does not prevent "an end user from signing in to the
  unmodified Claude Code binary with their own Claude subscription". **PocketRocket fits that carve-out**: each user signs in
  to their own unmodified `claude.exe`, and we never hold, pool or forward their credentials. The Agent SDK page adds that
  third-party developers may not offer claude.ai login or rate limits "unless previously approved", and plan limits assume
  "ordinary, individual usage", so **unattended routines and workflows on a subscription stay grey**. So: no pooled accounts, no team seats on one Max login, and any paid or hosted tier is BYO
  API key under Commercial Terms or written approval. Re-check both pages before any paid release.
- **Google Antigravity rule.** `agy` is proprietary; clause 6 of the Antigravity terms bars third-party access, but a forum
  reply (2026-11-09; author's staff status unverified) allowed a private, single-user interactive client that launches the
  unmodified `agy acp` with its own OAuth, excluding unattended automation, multi-user serving and account rotation. Forum
  replies are not binding. Hence:
  attended turns only on the Google login, unattended only when `agy` reports API-key auth, and the API key is the
  recommended path on a VPS. Gemini CLI (Apache-2.0) no longer serves Pro/Ultra logins.
- **Meta WhatsApp ban.** Business Platform terms §4.7 strictly prohibit "general-purpose artificial intelligence assistants"
  as the primary function, and unofficial linked-device libraries breach WhatsApp's Terms and risk the user's number. No WhatsApp.
- **Telegram §4.4.** Bot developers must encrypt stored user data at rest, apart from its key. Phase A stores no message
  content, so it does not apply. Owner-only chat stores as usual; encrypt before allowlists or any hosted use. The owner who
  made the bot is the developer of record and needs a privacy policy for anything beyond personal use.
- **SignPath Foundation.** Free OSS signing, but "the project may not contain any proprietary, non open-source component".
  The bundled `@anthropic-ai/claude-agent-sdk` is the only non-OSS component in the installer. Expect a refusal unless the
  SDK is fetched at first run (task A10). Other conditions: verifiable builds (pin the Node sidecar), MFA, exact policy-page
  wording, manual approval per release, publisher shown as SignPath Foundation.
- **MIT + CLA.** The owner is the sole copyright holder today, so relicensing future versions stays possible; released
  versions stay MIT forever. A CLA through cla-assistant.io must be in place before the first outside PR. Sell services
  (managed self-host), not licences, to stay SignPath-eligible.

## Roadmap

One ordered list. Backend and design work follows the owner's priority (steering, queue, workflows, then providers). The
pr-infra release lane (M3) runs in parallel from the start because it uses a different agent. Task ids refer to the spec
named in brackets. Sizes per the revised specs.

### M1. Steering on Claude [02 Phase 1]
- **pr-backend:** 1.0 spike (S), 1.1 + 1.2 adapter and runner in one PR (M/L + M; `canSteer` from the
  `interrupt_receipt_v1` init capability, a run-in-progress flag separate from `laneTurns`, steers on the turn's starting
  provider), 1.3 router: cursor kept at `startSeq` with one consumed-steer filter, steer journal rows, unanswered steers
  re-queued after Stop, `busy` on REST `POST /api/rooms/:id/messages`, migration 250 (M).
- **pr-design-system:** 1.4 send-mode menu (Ctrl+Enter queues), status line under the bubble, `canSteer` copy, Stop labelled
  as room-wide (`ChatPane.tsx:893-895`), after-Stop note for re-queued steers, aria-labels (M).
- **planner:** 1.5 CHANGELOG and GUIDE (S).
- **Depends on:** nothing. 1.4 ships with 1.3.
- **Owner must:** be present for the **live Claude Max spike** (1.0), then do the manual steer test on a long task.

### M2. Queue controls [02 Phase 2]
- **pr-backend:** 2.3 "stopped by you" (S), 2.2 queue pause (S), 2.1a queue read + device allowlist (S), 2.1b cancel, edit,
  send now with message-level cancel, reusing 1.3's filter helper (M). (04-A3 moved to M3, since it ships in v0.3.0.)
- **pr-design-system:** 2.4 chip row and popover (M).
- **Depends on:** M1 (same lane code).
- **Owner must:** manual check of cancel/edit/send now at 360 px.

### M3. $0 release pipeline and updater [04 Phase A] (pr-infra lane, parallel from M1)
- **pr-infra:** A1 updater wiring at `=2.12.0` + Dependabot rule, no `createUpdaterArtifacts` in the config (tag builds
  pass it with `--config`), release-URL-only endpoint override, `cargo test` in CI (S); A2 draft → finalize pipeline with
  attestations, `release` environment kept off the dispatch dry-run steps (M); A4 shell update UX: 24 h check in every
  mode, notification, `OkCancelCustom` dialog, local mode only: hold → `blocking` 0 → `/api/maintenance/stop` → hard-kill
  fallback; remote mode never holds a VPS hub; attach mode or a 404 just asks (M); A7 docs and outbound hosts (S).
- **pr-backend:** 04-A3 `GET /api/busy` returning one `blocking` number (running turns + live unparked cards; pending lanes,
  parked cards and waiting runs for display only), count getters for `BotRunner.activeTurns` and `PermissionBroker.pending`,
  capped hold re-checked after `acquire()`, `POST /api/maintenance/release` and `/stop`, hub token or owner session (S/M).
- **pr-design-system:** A5 desktop About copy (S); splash and site token parity (S, separate PR).
- **Depends on:** A0 (owner) before A2; A3 before A4.
- **Owner must:** **A0**: generate the updater key offline, store it twice, create the GitHub `release` environment with
  yourself as **required reviewer**; then, after v0.3.0, the first real update test: install v0.3.0 on a clean Windows VM,
  point the endpoint override at a **v0.3.1-rc.1** prerelease, and update (once with Smart App Control on, once with a turn
  running) before flipping a prerelease to latest.
- **Cut: v0.3.0** = everything already on `main` + M3 (05 Round 3 #1).

### M4. Workflows v1 [02 Phase 3]
- **pr-design-system:** 3.0 `ActionCard` extraction (S) first; then 3.5a workflow page, StepCard, Steps list, inspector (M),
  3.5b lazy React Flow canvas (M), 3.5c run view and approval card (M).
- **pr-backend:** 3.1 graph schema + linear validator, migration 260 (M), 3.2a lane foundations: solo, owner ref, hop reset
  hook, `causeBudget`, `'workflow'` cause kind, `manual` flag (M), 3.2b WorkflowRunner (M), 3.3 person-only approval card
  (M), 3.4 REST + gated bot tools (S).
- **pr-infra:** 3.6 CI bundle budget (S).
- **Depends on:** M1 merged (3.2a touches the same `RoomRouter` blocks); 3.5a after 3.1; 3.5c after 3.3 and 3.0.
- **Owner must:** build one real workflow (for example the Monday summary) and approve a step from Needs-you.
- **Cut: v0.4.0** = M1, M2, M4, M9 (the updater ships earlier in v0.3.0; see the owner answers at the end).

### M5. Claude limits and plan meter [01 Phase 0]
- **pr-backend:** P0-1 limit parsing to `ok:false` (S/M), P0-2 ProviderHealth (S), P0-3 failure note (S), P0-4
  `fallbackModel` (S).
- **pr-design-system:** P0-5 `Meter` primitive, plan meter on the Usage page, limited banner (S + S).
- **Depends on:** nothing technical; may start while M4 is in progress if pr-backend has slack.
- **Owner must:** capture a real limit fixture on Claude Max (it may take a heavy day to hit one).

### M6. Provider per bot [01 Phase 1]
- **pr-backend:** P1-1 schema, migration 270 (S), P1-2 `forBot`, interrupt map, `lastInit` per provider (M), P1-3, P1-4
  seeded switch without a token map, P1-5, P1-6 `claudeReady()` incl. "not held", P1-7 skills as text (S each).
- **pr-design-system:** P1-8 provider select, Providers section, ProviderCard radio fix, per-room picker gate (M), P1-9
  usage by provider (S).
- **Depends on:** M5 (P1-6 reads ProviderHealth).
- **Owner must:** nothing beyond review.

### M7. Gemini through ACP [01 Phase 2]
- **pr-backend:** P2-1a ACP transport (M), P2-1b permission mapping (M), P2-2 Gemini preset with reported auth (M), P2-3
  attended guard (S), P2-5 fs/terminal capabilities (stretch).
- **pr-infra:** I-1 PATH refresh on hub spawn (S), I-2 scan line (optional, S).
- **Depends on:** M6 (P1-2); P2-3 needs `isAttended` and `manual` from M4's 3.2a.
- **Owner must:** **get the Google AI (Gemini) account** and run the **live test** (P2-4): DM, hand-off, approval card,
  interrupt, whether `agy` asks for writes and shell, where it stores its login on PC and VPS, the limit fixture, the API-key
  variable name. Gemini flips to `verified` only after this.

### M8. Failover card [01 Phase 3, Phase 4]
- **pr-backend:** P3-1 failover card kind, re-queue on the backup with `providerOverride` + `forceStrict` (M/L); P4-1 generic
  rotation (S).
- **pr-design-system:** P3-2 limit card on `ActionCard`, one backup select, "On Gemini until 14:00" badge (M); P4-2 context
  meter (S).
- **Depends on:** M5, M7 (P2-4 passed), M4 (3.0 `ActionCard`, 3.2a lane fields, parked card kinds).
- **Owner must:** set a backup on one bot and press the card once on a real limit.
- **Cut: v0.5.0** = M5-M8 (Claude + Gemini, per 05 §01 #4 and Round 3 #1).

### M9. Telegram notifications [03 Phase A]
- **pr-backend:** A1 client + token redaction (S), A2 link flow with lifecycle and owner checks (M), A3 per-sink PushService
  (S).
- **pr-design-system:** A4 Telegram card under Notifications (S-M).
- **pr-infra + planner:** A5 outbound list, GUIDE, `keys.sh` revoke line (S).
- **Depends on:** nothing in M1-M8; pr-backend filler after M2, ships in v0.4.0 (owner answer 2, renumbered in Round 3).
- **Owner must:** create a bot with BotFather, link it, and confirm the notification text is content-free on the phone.

### M10. Trust, platforms and licence [04 A8, A9, A10, D1]
- **pr-infra:** A8 real installs on Ubuntu 22.04/24.04 and macOS 15, plus an `ubuntu-22.04-arm` AppImage (M); A9 pin the Node
  sidecar and publish the signing policy page (S); D1 cla-assistant.io + required check (S); A10 SDK first-run fetch only if
  SignPath requires it and the owner agrees (L, split with pr-backend).
- **Depends on:** M3 (A2 finalize job). A9 can start immediately; it is calendar-bound.
- **Owner must:** enable MFA, **submit the SignPath application** and ask in writing about the bundled SDK; create the CLA
  gist and approve the cla-assistant.io app; decide A10 when SignPath answers.

### M11. Server distribution [04 Phase B]
- **pr-infra:** B1 server tarball + `install.sh` in the release (S), B2 installer with Node 24, `releases/<ver>` + `current`,
  data path kept, layout migration, rollback (L), B3 headless Docker image without closed CLIs (M).
- **Depends on:** M3 (finalize job, attestations).
- **Owner must:** run B2 on a throwaway VPS and upgrade one existing VPS from the source layout.

## Not doing, and why

| Item | Why |
|---|---|
| Pooled or rotated subscription accounts | A terms violation for Anthropic and Google, not a feature gap. |
| Bundling or auto-downloading Claude Code or `agy` | Both are closed source with no licence to redistribute; principle 1. We detect, hint and version-check. |
| WhatsApp (official or unofficial) | Meta §4.7 ban on "general-purpose artificial intelligence assistants"; unofficial clients breach WhatsApp's Terms and risk the user's number (05 §03 #1). |
| A relay service or inbound webhooks | Breaks principle 1 and decision Q5; costs money to run. |
| Teams two-way bot | Needs a public HTTPS endpoint. |
| Telegram chat, Discord, Slack channel mode now | Owner scoped gap 3 to notifications (05 §03 #6). Planned in spec 03 Phases B-E. |
| Image and video steps | No owned plan covers image APIs; deferred (05 §02 #4). GUIDE note only. |
| Queue reorder | A lane runs all pending items as one turn; reorder would do almost nothing (05 §02 #6). |
| Workflow branches, loops, free node placement | v1 is linear; the graph format allows them later without a migration. |
| Codex app-server rewrite, new Grok/OpenCode work, local models | Nobody can test them (no accounts, no GPU); frozen dev-only (05 §01 #6). |
| Multiplayer | Credentials question first; then API key or Team/Enterprise only (05 §04 #3). |
| Hosted multi-tenant servers, seats, payments | Subscription terms and missing isolation; managed self-host only, if ever (05 §04 #4). |
| Native iOS/Android, Nix, Umbrel | Fees, store review, LAN exposure, maintenance; the PWA covers phones. |
| Notarized macOS, paid or EV signing certificates | $0 budget; EV no longer bypasses SmartScreen. First paid upgrade later. |
| Container bind override (04 B4) | Owner chose Linux `--network host` first (05 §04 #5). |
| Relicensing to AGPL or PolyForm | Would forfeit SignPath eligibility and at-work use; MIT + CLA keeps options open. |

## Open items and unverified claims

- **SDK steering behaviour** (spike 1.0): fold timing, `priority` values, several results per query, Stop with a queued
  steer, whether `maxTurns` resets per folded turn, minimum CLI version.
- **Claude limit result shape on Max**: reported as a successful result carrying the limit text; needs a captured fixture.
- **`agy` behaviour** (P2-4): whether it asks for writes and shell (else the backup is read-only), how it reports its auth
  method, the API-key variable name, where it stores its login on Windows and on a headless VPS, whether it has a
  device-code login, its default install path, whether it installs as a `.cmd`/`.ps1` shim, its limit error shape.
- **Google's position** rests on forum replies whose authors' staff status is unverified; they are not binding and partly
  conflict.
- **SignPath's answer** on the bundled Agent SDK.
- **Tauri details**: (resolved: the locked `tauri-plugin-dialog` 2.7.3 supports custom labels via `OkCancelCustom`); whether `--bundles dmg` produces the
  `.app.tar.gz` and `.sig`; relaunch after a passive update with the same token and data (clean VM); Smart App Control
  blocking (clean VM with SAC on).
- **Docker Desktop host networking** (4.34+) with a `127.0.0.1` bind in the container: unverified, so not documented.
- **cla-assistant.io** treatment of `Co-Authored-By: Claude` trailers.
- **React Flow chunk size**: the ~57 KB gzip is a third-party figure; measure with `vite build`.
- **React Flow major version**: the spec assumed 12.x; the latest is **13.0.1**. Decide the pin (12 vs 13) before task 3.5b
  (02 risk 9).
- **`interrupt_receipt_v1`** capability name and its typings lines (`sdk.d.ts:4279`, `:5531`) come from the readiness
  review; confirm against the installed SDK in spike 1.0.
- **Codex CLI image generation** on a ChatGPT login: unverified; only matters if Codex returns to scope.
- **Discord Developer Terms and Policy** could not be fetched (403); check before any Discord phase.
- **Known bug that shapes copy**: pending approvals are lost on a crash, so updater and resume copy must not promise that
  bots "pick up where they left off".
- **Corrections made during this pass**: `MAX_HOPS` defaults to **3** (`packages/hub/src/config.ts:164`), not 5 as the
  backend review said, which makes the per-step hop reset more necessary; the parked-approval store is
  `packages/hub/src/db/approvalStore.ts` and FollowUp is `packages/hub/src/services/FollowUp.ts`; `MAX_ROOM_BOTS` is 20 on
  main (`packages/shared/src/models.ts:2`).

## Owner answers to the residual questions (2026-11-17)

Round 2:
1. **React Flow attribution:** keep the link, styled quietly with our tokens (low contrast, corner).
2. **Telegram notifications:** ship with steering, as pr-backend filler right after M2 (now **v0.4.0**).
3. **Version cuts:** **the updater ships first** so every later release reaches users through it.

Round 3 (after the readiness review; `05-owner-decisions.md`):
1. **Versions shift up by one.** `main` is already 0.3.0 (`package.json:5`, `Cargo.toml:3`, `tauri.conf.json:5`,
   `CHANGELOG.md:15`) and only v0.2.0 was released, so the updater rides in v0.3.0 with everything already on `main`.
2. **Queue shortcut: Ctrl+Enter**, plus the Send-button menu. Alt+Enter is the desktop full-screen toggle
   (`packages/desktop/src-tauri/src/lib.rs:1134-1166`).
3. **Stop with unanswered steers:** re-queue them; the bot answers them right after Stop, and the copy says so.

Release cuts:

| Release | Contents |
|---|---|
| **v0.3.0** | Everything already on `main` (CHANGELOG `[0.3.0] - 2026-11-16` plus Unreleased) + M3: updater (A1, A2, A4) and 04-A3 `/api/busy`, maintenance hold and clean stop. **v0.3.1-rc.1** follows at once for the first real update test |
| **v0.4.0** | M1 steering, M2 queue controls, M4 workflows v1, M9 Telegram notifications |
| **v0.5.0** | M5 Claude limits, M6 provider per bot, M7 Gemini, M8 failover card |
| later | M10 trust and platforms (A9 and the SignPath application can start now), M11 server distribution |

Start order therefore: pr-infra A0/A1/A2 and pr-backend A3 first (owner does A0), M1 spike in parallel.
