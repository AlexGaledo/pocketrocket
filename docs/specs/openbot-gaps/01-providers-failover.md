# Gap 1: Providers + failover

Status: **revised after review, 2026-11-17.** Owner answers in `05-owner-decisions.md` are applied (summarised in §10),
and the required changes from `review-backend.md`, `review-design.md` and `review-infra.md` are folded in. Revised sections
say so in their heading. Where this spec and 05 differ, 05 wins. Ground rules from `00-openbot-recon.md` apply (clean room, free MIT now, maybe paid later).

Owner facts used for this plan (interview, 2026-11-17): has **Claude Max**; will get a **Google AI** account
(Gemini / Antigravity) for live testing; **no** ChatGPT/Codex, **no** Grok, **no GPU** for local models.
Ship priority across gaps: steering + workflows first, **providers second**. Distribution budget: **$0**.

---

## 1. Summary verdict

| Sub-feature | Verdict | One line |
|---|---|---|
| Provider chosen **per bot** | **Go** | Mostly plumbing. The provider is global today (`registry.ts:74`, `BotRunner.ts:186`); sessions are already stored per provider (`repos.ts:291-303`). |
| "Change provider, keep the agent" | **Go** | Memory, identity, skills (as text), transcript and room notes carry over. The SDK session cannot; the existing rotation seed (`SessionRotation.ts:84`) re-primes the new provider. |
| **Failover** on usage limit / outage | **Go-with-limits** (revised) | Claude reports limits in a structured way (`rate_limit_event`). Owner decision: **ask with a card** (§4.7). The limited turn ends at once with the reset time; a press queues a new strict turn on the one owner-set backup. Nothing switches silently. |
| One generic **ACP** adapter | **Go** (recommended path) | ACP v1 is stable, Apache-2.0, supports HTTP MCP servers, permission requests and context usage. It is the only route to Gemini for a Google AI Pro login (`agy acp`). |
| Hand-written codex / grok / opencode adapters | **Keep, freeze** | They stay dev-only and `untested` (no accounts). No new work. Move each one to ACP once someone can test it. |
| **Local models** (Ollama, LM Studio, OpenAI-compatible) | **Go-with-limits, deferred** | Use the existing OpenCode adapter with a local base URL rather than writing our own agent loop. The owner has no GPU, so it cannot be verified: ship as `untested` or leave it out. |
| **Pooled / multiple accounts** per provider | **No-go** | Rotating subscriptions to get around limits breaks Anthropic's "ordinary, individual usage" rule and account-sharing ban, and Google staff explicitly exclude "automated account rotation". An API-key-only variant is possible but low value. |
| **Managed download + version pinning** of CLIs | **No-go** for download; **go** for a version check | Antigravity CLI and Claude Code are closed source, and auto-installing them conflicts with their terms and with principle 1. Instead: detect the CLI, show the official install command, and warn when the installed version is outside the tested range. Costs $0. |
| **Context monitor + compaction** | **Go** | Claude already has it (`contextTokens` plus session rotation, `BotRunner.ts:190-219`, `config.ts:230-238`), but no UI and Claude only. The UI goes on the Bot page, not the right panel (revised after review). ACP `usage_update {used,size}` extends it to Gemini. |

---

## 2. Licensing and terms (research 2026-11-17)

Sources are listed under the table. "Drive" means a third-party app spawns the user's own, unmodified CLI,
which signs itself in. PocketRocket never sees or stores the token. That is how PocketRocket works today: it
uses the user's `claude.exe` (`config.ts:68-71`, `claude.ts:450`), and the installer **removes** the SDK's
bundled CLI copy (`scripts/build-hub.mjs:110-128`).

| Provider / CLI | CLI licence | Redistribute / auto-download? | Free personal app may drive the user's own subscription login? | If PocketRocket is sold / hosted / has team seats |
|---|---|---|---|---|
| **Anthropic Claude Code + Agent SDK** (Pro/Max) | Proprietary; use under Consumer Terms (Pro/Max) or Commercial Terms [A2] | Only under **Commercial Terms**, unmodified binary, all auth methods kept [A2]. We don't bundle it; keep it that way. | **Grey, tolerated.** The legal page lets "an end user [sign] in to the unmodified Claude Code binary with their own Claude subscription", and plan limits "assume ordinary, individual usage of Claude Code **and the Agent SDK**" [A2]. But the SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" [A1]. Consumer Terms ban automated access "except ... where we otherwise explicitly permit it" [A3]. | **Blocker for selling/hosting on subscriptions.** Hosting needs Commercial Terms; each end user must use their own credentials; we may not "pay for, resell, or intermediate" usage [A2]. Team seats on one shared Max login = account sharing [A3]. A paid tier needs **API keys (BYO)** or written approval from Anthropic. |
| **OpenAI Codex CLI** (ChatGPT plan) | **Apache-2.0** (github.com/openai/codex) | Allowed by licence | **Likely yes.** OpenAI documents ChatGPT plan usage for "open-source and locally hosted apps" through Sign in with ChatGPT, including the Codex app-server [O1]. ChatGPT Terms govern [O2]. Owner can't test. | Paid or remotely hosted apps must fill in OpenAI's **interest form** [O1]. |
| **Google Antigravity CLI `agy`** (Google AI Pro/Ultra) | **Proprietary**, closed source [G4][G5] | **No** (closed; OpenBot downloads it at runtime for this reason, per recon) | **Yes, narrowly.** Clause 6: "Using third party software, tools, or services to access the Service ... is a breach" [G2]. But Google staff (2026-11-09) said a "private, single-user interactive client" that launches the **unmodified `agy acp`** binary with its own OAuth is fine. That excludes "unattended background automation, multi-user serving, and automated account rotation", and wrapping `agy` inside another agent loop [G3]. Other staff replies are narrower [G6]. Forum answers are **not binding**. | **Blocker.** Multi-user, hosted or paid use isn't covered. A paid tier needs a **Gemini API key** (Gemini API Terms) [G1]. |
| **Google Gemini CLI** | **Apache-2.0** | Allowed by licence | **Dead for Pro/Ultra**: since **2026-06-18** it serves only API keys and Code Assist Standard/Enterprise [G4]. Its ToS page warns that third-party access to "the services powering Gemini CLI" via OAuth can lead to suspension [G1]. There have been mass suspensions of OpenClaw/OpenCode users reusing that OAuth [G7]. | API-key mode only. |
| **xAI Grok Build CLI** | **Apache-2.0** (xai-org/grok-build) | Allowed by licence | **Unclear.** Third-party guides say unattended / headless use should use `XAI_API_KEY`, not the SuperGrok login [X1]. No official text found. Owner can't test. | Unknown; assume API key only. |
| **GitHub Copilot CLI** | Proprietary "GitHub Copilot CLI License" | **Yes, conditionally**: unmodified, as part of an app with "material functionality beyond the Software", with the licence included [C1] | **Yes.** `copilot --acp` is pitched for third-party tools [C2]. Needs Copilot Pro/Pro+/Business/Enterprise, and an org admin must enable the CLI [C3]. | No licence blocker found. Copilot plan terms not reviewed. |
| **Cursor agent** | Proprietary | Not reviewed. Assume no. | Not reviewed. Out of scope. | — |
| **Cline** | **Apache-2.0** | Allowed | Bring-your-own key/provider. Inherits that provider's rules. | Inherits provider rules |
| **OpenCode** | **MIT** | Allowed | Fine as a tool. **But** using it with Claude Max OAuth breaks [A2], and with Google OAuth breaks [G1][G2]. Use it only with API keys or local models. | Inherits provider rules |
| **Kimi** | `MoonshotAI/kimi-cli` Apache-2.0, **archived**; successor `kimi-code` not reviewed | — | Not reviewed | — |
| **Mistral Vibe** | **Apache-2.0** (mistralai/mistral-vibe) | Allowed | API key; plan terms not reviewed | Not reviewed |
| **ACP protocol + SDK** | **Apache-2.0** (`@agentclientprotocol/sdk`) | Allowed (npm dependency) | n/a | None |
| **Ollama** / **LM Studio** | Ollama MIT; LM Studio proprietary freeware | Don't bundle either; detect a running server | Local, no account | None (Ollama); check LM Studio's terms before selling |

**Top findings**
1. **Driving the user's own unmodified CLI login is the defensible pattern** for Anthropic and Google. Bundling
   a CLI, proxying its tokens, or rotating accounts is not. PocketRocket already follows the first part
   (`build-hub.mjs:110-128`).
2. **Unattended automation is the weak spot.** Google excludes it outright for `agy` [G3]. Anthropic's limits
   assume "ordinary, individual usage" [A2]. PocketRocket routines and triggers are unattended. This affects
   Gemini bots now and Claude if usage ever looks abusive.
3. **Any paid, hosted or team-seat version cannot run on consumer subscriptions** (Anthropic [A1][A2], Google
   [G3], OpenAI [O1]). It would need BYO API keys or written approval. This doesn't block the free MIT tool.
4. **Pooled accounts are a terms violation**, not a feature gap. Don't build them.

**Sources** (all read 2026-11-17)
- [A1] Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- [A2] Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- [A3] Anthropic Consumer Terms (effective 2025-10-08), §2 and §3(7): https://www.anthropic.com/legal/consumer-terms
- [O1] OpenAI, ChatGPT plan usage for open-source apps: https://developers.openai.com/siwc/token-sharing-open-source
- [O2] Codex with a ChatGPT plan: https://help.openai.com/en/articles/11369540
- [G1] Gemini CLI terms and privacy: https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md
- [G2] Antigravity Additional Terms, clause 6: https://antigravity.google/terms
- [G3] Google AI forum, "Personal app using the official agy acp binary" (staff answer 2026-11-09): https://discuss.ai.google.dev/t/personal-app-using-the-official-agy-acp-binary-with-google-ai-pro-permitted/198889
- [G4] Google Developers Blog, "Transitioning Gemini CLI to Antigravity CLI" (2026-05-19): https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- [G5] FOSS Force (2026-05-22): https://fossforce.com/2026/05/gemini-clis-short-life-and-googles-antigravity-bait-and-switch/
- [G6] Narrower staff replies: https://discuss.ai.google.dev/t/clarification-on-antigravity-cli-use-on-a-remote-aws-server-and-subscription-terms/187945 and https://discuss.ai.google.dev/t/hello-google-antigravity-team/187681
- [G7] The Register (2026-02-23): https://www.theregister.com/2026/02/23/google_antigravity_compute_burden/
- [X1] Grok Build guides (third party, unofficial): https://www.layer3labs.io/guides/grok-build-pricing
- [C1] GitHub Copilot CLI License: https://github.com/github/copilot-cli/blob/main/LICENSE.md
- [C2] GitHub changelog, ACP in Copilot CLI (2026-01-28): https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/
- [C3] About Copilot CLI: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli
- ACP: https://agentclientprotocol.com/protocol/overview, https://agentclientprotocol.com/protocol/session-setup, https://agentclientprotocol.com/protocol/schema, https://github.com/agentclientprotocol/agent-client-protocol
- Licences checked through the GitHub API (2026-11-17): openai/codex, anomalyco/opencode, cline/cline, MoonshotAI/kimi-cli, mistralai/mistral-vibe, github/copilot-cli, google-gemini/gemini-cli, xai-org/grok-build, agentclientprotocol/agent-client-protocol, ollama/ollama.

*Not legal advice. Forum staff answers can change. Re-check [A1], [A2] and [G2] before any paid release.*

---

## 3. ACP (Agent Client Protocol)

- **Status:** protocol version `1` is stable, Apache-2.0, with TS SDK `@agentclientprotocol/sdk`. JSON-RPC 2.0. The agent runs as a
  subprocess of the client. The Zed/JetBrains registry launched on 2026-01-28.
- **Agents with ACP:** Claude (through the Apache-2.0 `claude-agent-acp` adapter), GitHub Copilot CLI (`copilot --acp`),
  Antigravity (`agy acp`, confirmed by Google staff [G3]), Gemini CLI, Cline, Mistral Vibe, Goose, OpenCode, among others. Codex has
  no first-party ACP (`zed-industries/codex-acp` is archived). Codex's own surface is the app-server.
- **What it gives us:**
  - `session/new|load|resume` take `mcpServers`. Stdio is mandatory. **HTTP** works when the agent advertises
    `mcpCapabilities.http`, with headers. This is how the hub's `/mcp` tools reach the agent (`mcp/httpServer.ts:19`).
  - `session/request_permission` with `allow_once|allow_always|reject_once|reject_always` maps onto
    `TurnContext.permission` (`types.ts:59-63`), so approval cards work. **Parity depends on the agent asking.** It is
    `best-effort` until verified, like codex/grok today (`codex.ts:42`).
  - Client capabilities `fs/read_text_file`, `fs/write_text_file` and `terminal/*`: if the hub advertises them, the agent *may*
    route file writes and shell through the hub, where `projectGuard` / `shipGuard` / read-only roots
    (`types.ts:94-103`) could enforce them. Whether `agy` actually uses them must be checked live.
  - `session/update` kinds: message/thought chunks, `tool_call(_update)`, `plan`, `usage_update {used, size, cost?}`
    (context monitor), `compaction_update`, `notice`. Stop reasons: `end_turn|max_tokens|max_turn_requests|refusal|cancelled`.
  - `session/cancel` maps to `interrupt`. `session/set_config_option` and modes may select the model (check per agent).
- **What it lacks:** no standard error code for "usage limit reached". Detection is per agent (§4.3).

---

## 4. Technical feasibility and compatibility (file:line)

### 4.1 What is global today and must become per bot

| Place | Today | Change |
|---|---|---|
| `packages/shared/src/providers.ts:4-9` | Comment and type say "global choice"; `PROVIDER_IDS = claude, codex, opencode, grok` | Add `'gemini'` (and `'acp'` for custom agents, later). Rewrite the comment. |
| `packages/shared/src/providers.ts:50-69` `ProviderInfo` | `permissions`, `maturity` | Add `limits?: ProviderLimitState` (held until, window, utilization) and `testedVersions?: string`. |
| `packages/shared/src/providers.ts:99-102` `SettingsSchema.provider` | The provider every bot runs on | Becomes **default provider for new bots**. Same key, so old settings still parse. |
| `packages/shared/src/models.ts:83-97` `Bot` | `model` only | Add `provider: ProviderId \| null` (null = settings default) and `backup: {provider, model} \| null` (owner-only, **one** backup; revised after review 2026-11-17). |
| `packages/hub/src/db/schema.ts:2-7` bots table | no provider | Migration in block **270-279** (revised after review 2026-11-17; 250-259 is steering, see `decisions.md`): `bots.provider TEXT`, `bots.backup TEXT` (JSON), `usage.provider TEXT`. Additive only (`decisions.md` merge rules). |
| `packages/hub/src/providers/registry.ts:74` `active()` | `get(settings.provider)` | Add `forBot(bot)`. Keep `active()` only as the default-for-new-bots helper. |
| `packages/hub/src/agent/BotRunner.ts:186` | `const provider = this.providers.active()` | `this.providers.forBot(bot)`, or the failover choice (§6). |
| `packages/hub/src/agent/BotRunner.ts:165` `interrupt()` | Calls `providers.active().interrupt(turnId)` | **Latent bug once per-bot:** it would interrupt on the wrong provider. Keep a `turnId → provider` map. |
| `BotRunner.ts:125` `lastInit`, `/api/debug/last-init` | One slot | Key by provider, or it is last-writer-wins across providers (review 2026-11-17). |
| `BotRunner.ts:196, 264, 279, 320, 421, 436` | `provider.id === 'claude'` gates (rotation, chat model, move-up, tool prefix) | Unchanged in meaning, but now read from the bot's provider. Rotation (`:196`) is generalised in §4.5. |
| `packages/hub/src/agent/botTools.ts:60-61, 232-246, 496` | `ctx.models` = active provider's list; `create_bot`/`update_bot` validate a model against it | Validate against the **target bot's** provider. Bots may **not** set `provider` or `backup` (owner-only, principle 2). |
| `packages/hub/src/services/SettingsStore.ts:71-81, 97-132, 143-170` | On a global provider switch, re-point every bot's model | Re-point only bots whose `provider` is null (they follow the default). A per-bot change goes through `PATCH /api/bots/:id` with the same note. |
| `packages/hub/src/hub.ts:250, 296-300` | AutoMemory, SkillDistiller, SkillReflection, Training get `activeProvider()` | Change to "Claude is set up" (exe + login). These passes run on Claude Haiku (`AutoMemory.ts:28`) whatever the bot's provider. If Claude isn't set up, skip them, as today (`AutoMemory.ts:346`, `SkillDistiller.ts:220`, `SkillReflection.ts:120`, `Training.ts:329`). |
| `packages/hub/src/config.ts:184-188` `ENABLED_PROVIDERS` | Claude plus env opt-in | Unchanged. Gemini joins the opt-in list until verified, then is enabled by default. |
| `packages/hub/src/db/schema.ts:54-59`, `migrations.ts:236-242` usage | `model`, `route_reason`, `cause_kind` | Add `provider`. The Usage tab groups by provider. |
| `packages/web/src/components/dialogs/BotDialog.tsx:30-35, 91` | Model list from the *active* provider | Provider select (hidden while only one provider is enabled), then that provider's models. A backup select is added in phase 3. |
| `packages/web/src/components/settings/ClaudeSection.tsx:3, 28-29` | "v1 ships one provider, so there is no picker" | Becomes a Providers section: one card per enabled provider (status, plan, limits) plus "default for new bots". |
| `packages/web/src/components/ChatPane.tsx:673` + `CHAT_MODELS` `models.ts:295` | Composer picker gated on the **global** `s.settings.provider === 'claude'` (the draft cited `:1002-1003`) | Show it only when every bot in the room runs on Claude. Otherwise show nothing. |
| Usage and context UI | The draft pointed at the RightPanel Usage tab; the right panel is screen-only now (`RightPanel.tsx:1`) | Usage lives in `UsageSection` (`FleetPages.tsx:248`); the context meter goes on the Bot page header and the DM chat header. |

### 4.2 "Change provider, keep the agent": what carries over

| Part | Where it lives | Carries over? |
|---|---|---|
| Memory (`memory.md`), identity, voice, notes | Bot home, injected by PromptBuilder (`BotRunner.ts:215-216, 415-438`) | **Yes**, provider-agnostic |
| Transcript | Our `messages` table | **Yes.** The first turn on the new provider is seeded with `buildSeed` (summary + recent messages + room notes), the same as rotation and the stale-session path (`BotRunner.ts:206-207, 626`) |
| Provider session / prompt cache | Provider's own store; `sessions.provider` (`migrations.ts:59`); a stale token is ignored (`repos.ts:291-303`) | **No.** It can't be ported. **Revised after review 2026-11-17:** no per-provider token map. `session_state` (`costTotal`, `contextTokens`, snapshots) is not per provider, and resuming an old Claude session after a switch would hand the SDK a 0 cost baseline (`claude.ts:535`) and stop the turn at once. Switching back reseeds. Today a switch already drops the token without a seed, so P1-4 fixes an existing context-loss bug. |
| Skills | Claude: materialised plugin dir (`BotRunner.ts:220`, `types.ts:73-74`). Others: **not delivered at all** today | **Partly.** For non-Claude providers add a skill index to the prompt plus a `read_skill` hub tool. |
| Hub tools (rooms, hand-offs, memory, fleet) | `HubTool[]` over `/mcp` for CLI/ACP providers (`types.ts:92-93`, `BotRunner.ts:404, 465`) | **Yes**, through MCP |
| Outside MCP servers, images | Claude-only (`types.ts:107`, `:43-44`) | **No** at first. ACP can pass extra `mcpServers` later. |
| Auto-Auto model routing / `use_stronger_model` | Claude-only (`BotRunner.ts:279, 320`) | Other providers keep the router's tier mapping (`ModelRouter.ts:22-23, 79`) |

### 4.3 Detecting "usage limit reached" and "provider down"

New field on `TurnOutcome` (`types.ts:147-160`): `limit?: { kind: 'usage' | 'overloaded' | 'down' | 'auth'; resetsAt?: number; window?: string }`.
Today the only signal is a regex over error text (`turnFailure.ts:4-12`).

| Provider | Reliable signal | Confidence |
|---|---|---|
| Claude (Agent SDK 0.3.278) | `rate_limit_event.rate_limit_info.status === 'rejected'` with `resetsAt` and `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, ...) (sdk.d.ts `SDKRateLimitInfo`). Assistant `error: 'rate_limit' \| 'overloaded' \| 'billing_error' \| 'authentication_failed'` (`SDKAssistantMessageError`). `api_retry` with `error_status` 429/529. **`allowed_warning` plus `utilization`** give an early warning. | **High**. Owner can test on Max. Not parsed today: the read loop (`claude.ts:559-644`) ignores these messages. On subscriptions the CLI has also reported the limit as a *successful* result carrying the limit text, so P0-1 maps it to `ok:false` (revised after review 2026-11-17). |
| Claude, overload only | SDK option `fallbackModel` (sdk.d.ts: "used if the primary model is overloaded or unavailable"; primary retried each turn) | High. In-provider, no hub logic needed. |
| Codex | codex-rs `UsageLimitReachedError { resets_at, limit_window_minutes, rate_limits }` maps to `CodexErrorInfo::UsageLimitExceeded`. The app-server also sends `account/rateLimits/updated`. Our adapter uses `exec --json` (`codex.ts:180-201`), which surfaces it as an `error` / `turn.failed` message. | Medium. Can't be tested (no account). Fixture-only. |
| Gemini via `agy acp` | No ACP code. Expect a JSON-RPC error or `notice` carrying a quota message (`RESOURCE_EXHAUSTED` / 429 style). | **Low until live-tested.** Owner can capture a real one; build the matcher from that fixture. |
| Generic ACP / OpenCode / Grok | Text classifier (extend `turnFailure.ts` with a `limitKind()` that returns kind + parsed reset time) | Low; best effort |
| "Down" (any) | Spawn failure, ECONN*, 5xx, `overloaded` repeated after the SDK's own retries | Medium |

### 4.4 Permissions and MCP through other providers

- The fleet, integration, routing and outside-handoff gates live **with the tool** (`BotRunner.ts:313-317`), so they hold on
  any provider that reaches `/mcp`. Principle 2 is kept for hub actions on every provider.
- Built-in file and shell actions: on Claude they go through `canUseTool` plus hooks (`claude.ts:461-489`). On ACP they go through
  `session/request_permission`, plus the `request_approval` tool and prompt text for `best-effort` (`PromptBuilder.ts:219`).
  The ACP fs/terminal client capabilities (§3) may raise this to `full`; that has to be verified.
- `bypassPermissions` (`types.ts:57`): answer `allow_once` to every request. Strict turns (routines/triggers, `BotRunner.ts:257`)
  still card.
- **Revised after review 2026-11-17:** the broker classifies by Claude tool names, so ACP requests need an explicit mapping
  (§4.8, task P2-1b), and a strict backup only means something if `agy` actually asks (§4.7 item 7).

### 4.5 Context monitor and compaction

- Already there for Claude: `TurnOutcome.contextTokens` (`types.ts:156-157`), stored at `BotRunner.ts:601`, and rotation with a Haiku
  summary (`BotRunner.ts:196-208`, `SessionRotation.ts:36-120`, thresholds `config.ts:230-238`).
- Missing: (a) any UI showing context size; (b) non-Claude providers (rotation is gated on `provider.id === 'claude'`, `BotRunner.ts:196`).
- Plan: map ACP `usage_update.used` to `contextTokens`, and gate rotation on "provider reports contextTokens" rather than on Claude. Turn
  `compaction_update` into a quiet system note. Show a context meter (used / window) per bot and room.

### 4.6 The shared "attended" predicate. Revised after review 2026-11-17

One function, `isAttended(causeId, item)`, used by the Gemini guard (05 §01 #1), the failover card (05 §01 #2) and steering
(spec 02). Build it once, in spec 02 Phase 3 (task 3.2a adds the `manual` flag), and reuse it here.

A turn is **attended** when any of these holds:
1. **A person started the thread**: the thread's root is a person's message (`requiresApprovals(causeId) === false`,
   `RoomRouter.ts:493`), so hand-offs inside that thread count too.
2. **The owner pressed Run now** on a routine or workflow (`manual: true` on the cause payload).
3. **The owner answered a card that queued this item**, for example "Continue on Gemini" on the failover card. So
   **pressing the failover card on a routine turn counts as attended for Gemini**: the owner chose, at that moment, to
   run it there.

FollowUp nudges and restart resumes inherit the thread's answer. Routines, triggers, workflow schedules and timed retries
are **unattended**. A card that is never pressed never makes anything attended.

### 4.7 Failover: ask with a card. Revised after review 2026-11-17

Owner decisions: 05 §01 #2 (ask with a card), #3 (backup always strict). The draft's automatic, off-by-default chain is
dropped. The flow must not hold a turn slot: waiting inside `runTurn` would hold one of the 4 global slots
(`RoomRouter.ts:307`) and the lane for up to 10 minutes.

1. **The limited turn ends at once.** P0-1 turns the limit into `ok:false` with `limit {kind, resetsAt, window}`. The note
   reads "Claude 5-hour limit reached, resets 14:00". The CLI's limit text is never posted as the bot's reply or run
   through `parseMentions`.
2. **Then a card, if a backup is set.** A new person-only card kind on the parked-card store (the pattern of
   `PermissionBroker.ts:300-320` and `resumeParked`): "Ada hit Claude's 5-hour limit. It resets at 14:00." with
   **Continue on <backup>** (primary) and **Wait until 14:00** (outline). It is listed in Needs-you and follows the same
   paired-phone rules as approvals. With no backup set there is no card, only the note plus "Set a backup in Ada's
   settings", linking to the bot dialog.
3. **Pressing Continue** queues a **new strict turn on the backup**: a lane item on the same cause with
   `providerOverride = backup` and `forceStrict = true`, seeded with `buildSeed` and the unanswered message(s), using the
   cause's **remaining** budget, and counting toward the cause cap. The press makes the item attended (§4.6).
4. **The card expires at `resetsAt`.** Unanswered (a routine, a trigger, or a person who walked away) it turns into a quiet
   note "Not continued. Resets 14:00." Nothing ever switches silently.
5. **While on the backup.** After a press, attended turns for that bot go to the backup until `resetsAt` (badge "On Gemini
   until 14:00"). Unattended turns during that window follow the Gemini rule: refused on a Google login, run on an API key
   (§4.8), always strict.
6. **Never** fail over on `auth` or on a user interrupt. One backup per bot (provider plus model), owner-only; the draft's
   chain of 2 adds UI for no benefit.
7. **Strict only means something if the backup asks.** `agy` must run in its most restrictive approval mode. If it has none
   that asks for writes and shell, the backup runs read-only (the draft's Q3 option c). P2-4 verifies this live.
8. **Claude-only passes pause while Claude is held.** Auto-memory, rotation summaries (`BotRunner.ts:765`), skill reflection
   and training all call Haiku on the same login. Skip them while `ProviderHealth` holds Claude (rotation already tolerates
   a failed summary). `claudeReady()` (P1-6) includes "not held".

### 4.8 Gemini: auth, ACP permissions and the PC/server environment. Revised after review 2026-11-17

- **API-key exception keyed to the reported auth.** 05 §01 #1 lets unattended Gemini turns run "if a Gemini API key is set".
  The guard must check **what `agy` reports it is using** (`check()` returns the CLI-reported auth method), not whether a
  key exists, or an unattended turn could run on the OAuth login. Unknown counts as OAuth. The key lives in the secrets
  store; its variable name (`GEMINI_API_KEY` or what `agy` documents, confirmed at build time) goes on a new Gemini entry in
  `providers/env.ts:25-38` only.
- **ACP permission mapping.** `PermissionBroker.decide()` classifies by Claude tool names (path tools, `Bash` through
  `classifyBash`). `agy` asks with its own names. Map ACP `ToolKind` plus `locations`: `read`/`edit` with locations through
  `pathRules.isInside` (realpath), `execute` through `classifyBash` when the command is present, everything else a card.
- **Limit result shape.** On subscriptions the Claude CLI has reported the limit as a *successful* result whose text is the
  limit message. P0-1 maps assistant `error: 'rate_limit'` and a rejected `rate_limit_event` to `ok:false`. Capture a real
  fixture on Max.
- **Per-provider leftovers.** `BotRunner.lastInit` (`:125`) and `/api/debug/last-init` become last-writer-wins across
  providers; key them by provider. `MAX_CONCURRENT_TURNS` stays global (intended).
- **Stale PATH on Windows (pr-infra).** The hub inherits the Tauri process's environment (`lib.rs:470-495`), and with
  close-to-tray the app runs for days, so installing `agy` while it runs leaves Gemini "not found" until a full quit. Fix:
  (a) an `AGY_EXE` override, then the default install directory **once a live install confirms it**, then PATH; and (b) the
  shell re-reads the user and machine `Path` from the registry each time it spawns the hub.
- **Shims.** If `agy` installs as a `.cmd`/`.ps1` shim, reuse the codex resolver (`codex.ts:70-79`); never `shell: true`
  (do not copy `opencode/server.ts:181`).
- **Versions.** No hourly update cron for `agy` (unlike `deploy/claude-update.sh`); "newer than tested" is a warning, not a
  refusal; an unparsable `agy --version` means "unknown version (untested)"; same 12 s cold-start timeout as Claude.
- **Server.** `agy` installs into `~/.local/bin`, already first on the unit's `PATH` and inside `ReadWritePaths`, so no unit
  change. A headless login works only if `agy` has a device-code or paste-code flow (unverified); a headless VPS has no
  keyring (`DBUS_SESSION_BUS_ADDRESS` is not on the base env list). Recommend the **API key on a VPS** and the Google login
  on the PC. Live-test where `agy` stores its login on both.
- **CI.** `ci.yml` already runs `pnpm test`, so the fake-ACP-agent tests need no workflow change (the draft's I-1 is dropped).

---

## 5. Options

### Option A: Claude native + one generic ACP adapter, Gemini first (recommended)
- Claude stays on the Agent SDK (full approvals, plugins, structured limits). New `providers/acp/` client. `gemini` is its first
  preset (`agy acp`). Other ACP agents (Copilot, Cline, Vibe, custom command) are presets marked `untested`.
- **Pros:** one adapter instead of N. Gemini is the only second provider the owner can verify. It is the only allowed way to
  drive a Google AI Pro login [G3]. It gives context usage and permission requests for free. Apache-2.0.
- **Cons:** permission parity depends on each agent. `agy` is closed and can change without notice. No standard limit code.

### Option B: hand-write a Gemini adapter (like codex.ts / grok.ts)
- Spawn `agy -p` / headless per turn and parse its own output.
- **Pros:** no new protocol dependency.
- **Cons:** Google staff split on whether `agy --print` driven by another app is allowed [G6]. The ACP route has the clearer
  staff answer [G3]. One more bespoke parser to maintain, and it doesn't help Copilot, Cline and the rest.

### Option C: route every non-Claude provider through OpenCode
- OpenCode already supports many providers, including Ollama, LM Studio and OpenAI-compatible endpoints, and we have a verified adapter.
- **Pros:** least new code, and it covers local models.
- **Cons:** **not allowed for subscriptions.** OpenCode with Google OAuth or Claude Max OAuth is exactly what [G1][G2][A2] prohibit,
  so it only works with API keys. The owner pays nothing for API keys today, so there is nothing to verify on.

**Recommendation: A**, with C kept only as the local-model and API-key route later (phase 5). Keep the hand-written codex/grok/opencode
adapters dev-only and frozen.

---

## 6. Recommended direction. Revised after review 2026-11-17

Ship order (05 cross-cutting): steering and workflows first, then providers. Phase 0 is small and owner-testable, so it can
run alongside spec 02.

1. **Phase 0, Claude limits:** parse `rate_limit_event` and assistant error kinds into `ok:false` + `limit`; hold a
   provider/model as "limited until X"; show plan usage on the Usage page with a `Meter`; calm banner when limited; SDK
   `fallbackModel` for overload (Opus/Fable to Sonnet only, never upward).
2. **Phase 1, provider per bot + keep the agent:** schema (block 270), runner, dialog, seed on switch (fixing today's silent
   context loss), skills as text for non-Claude. No per-provider session token map.
3. **Phase 2, ACP adapter + Gemini preset:** transport, then permission mapping; live-verified by the owner; Gemini guard
   per 05 §01 #1 using the attended predicate and the reported-auth API-key exception.
4. **Phase 3, failover card (§4.7):** one owner-set backup per bot, the turn ends at once with the reset time, a card offers
   the backup, a press queues a new strict turn.
5. **Phase 4, context meter + generic rotation.**
6. **Not doing now:** pooled accounts, CLI downloads, local models (no GPU to verify), new work on Codex/Grok/OpenCode
   (dev-only, frozen, 05 §01 #6).

The next release ships **Claude + Gemini** (Gemini only after the owner's live test); everything else stays dev-only
(05 §01 #4).

---

## 7. Tasks. Revised after review 2026-11-17

Sizes: S ≤ half a day, M ≈ 1-2 days, L ≈ 3-5 days for one agent (L items are split).

| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| **P0-1** | pr-backend | `providers/claude.ts:559-644`, `providers/types.ts:147-160` | Handle `rate_limit_event`, assistant `error`, `api_retry`. Map assistant `error:'rate_limit'` and a rejected event to **`ok:false`** with `TurnOutcome.limit`, plus an `onLimit` sink callback. Size S/M | A rejected event yields `limit {kind:'usage', resetsAt, window}`. The limit text is never posted or mention-parsed. `allowed_warning` yields utilization only | Unit tests with fixtures, including one **captured on Max** |
| **P0-2** | pr-backend | new `services/ProviderHealth.ts`, `providers/registry.ts`, `api/rest.ts`, `shared/src/protocol.ts`, `shared/src/providers.ts` | In-memory hold per `(provider, model?)` until `resetsAt`. `GET /api/providers` returns `limits`. WS `provider.limit` event | A held model is reported until reset, then clears. Not persisted across restart (acceptable) | Unit test with a fake clock |
| **P0-3** | pr-backend | `agent/turnFailure.ts:4-19`, `agent/BotRunner.ts:746-756` | Failure note from the structured limit: "Claude 5-hour limit reached, resets 14:00". Payload stays `external` | Local reset time shown; training classifier unchanged | Unit test |
| **P0-4** | pr-backend | `providers/claude.ts` options (~`:461-535`) | SDK `fallbackModel` = next cheaper Claude model when the bot runs Opus/Fable. Never upward | Opus overload continues on Sonnet; Sonnet has none; usage row records the model that ran | Unit test on the options builder |
| **P0-5** | pr-design-system | `web/src/components/ui.tsx` (new `Meter`), `FleetPages.tsx:248` (`UsageSection`), `ChatPane.tsx`, `store.ts` | `Meter` primitive (`role="meter"`, `aria-valuetext`, 6 px bar; accent < 80 %, warn ≥ 80 %, bad at limit, always % and reset time as text). Plan meter on the **Usage page** (the right panel is screen-only now, `RightPanel.tsx:1`) and a limited `Banner` (tone warn) above the composer | Screen reader reads "Claude 5-hour limit 82%, resets 14:00". Hidden for API-key auth. `--warn` in dark mode re-checked with axe | Manual on Max, axe |
| **P1-1** | pr-backend | `shared/src/models.ts:83-97`, `shared/src/providers.ts:4-9,99-102`, `db/schema.ts`, `db/migrations.ts` (**block 270-279**), `db/repos.ts` | `Bot.provider` (null = default), `Bot.backup {provider, model} \| null`, `usage.provider`. Settings `provider` documented as the default for new bots | Old DB migrates; bots read `provider:null`; round-trip | `db.test.ts`, `repos.test.ts` |
| **P1-2** | pr-backend | `providers/registry.ts:51-89`, `agent/BotRunner.ts:125,163-187,261-279` | `registry.forBot(bot)`; runner uses it; `turnId → provider` map for `interrupt`; `lastInit` and `/api/debug/last-init` keyed by provider. Size M | Two bots on two providers run concurrently; interrupt hits the right one | Unit test with `providers/stub.ts` |
| **P1-3** | pr-backend | `agent/botTools.ts:60-61,232-246,496`, `api/rest.ts` | Validate the model against the target bot's provider. `create_bot`/`update_bot` cannot set `provider`/`backup`; REST can | A bot setting a provider is refused; owner PATCH emits `bot.updated` | `botTools.test.ts`, `fleetApproval.test.ts` |
| **P1-4** | pr-backend | `agent/BotRunner.ts:187-219`, `services/SessionRotation.ts:84` | On the first turn after a provider change, seed with `buildSeed` and post "Ada now runs on Gemini; earlier context carried over as a summary". This **fixes an existing bug**: a switch already drops the token (stale check, `repos.ts:291-304`) without a seed. **No per-provider token map**: `session_state` is not per provider and a switch resets `costTotal` (`BotRunner.ts:219`), so resuming an old Claude session would pass baseline 0 to `sdkBudgetUsd` (`claude.ts:535`) and stop the turn at once. Switching back reseeds | Memory and identity unchanged; switching back starts a fresh seeded session | Unit test |
| **P1-5** | pr-backend | `services/SettingsStore.ts:97-170` | A default-provider change re-points only bots with `provider:null` | Explicit-provider bots untouched | `SettingsStore` tests |
| **P1-6** | pr-backend | `hub.ts:250,296-300`, `services/AutoMemory.ts:346`, `SkillDistiller.ts:220`, `SkillReflection.ts:120`, `Training.ts:329`, `BotRunner.ts:765` | Replace `activeProvider()==='claude'` with `claudeReady()` = exe + login + **not held** by `ProviderHealth` | Auto-memory runs for a Gemini bot when Claude is ready; all Claude passes skip while Claude is limited | Unit tests |
| **P1-7** | pr-backend | `agent/PromptBuilder.ts`, `agent/botTools.ts` | Non-Claude: skill index in the prompt plus a read-only `read_skill` tool | Prompt byte-stable across turns of one session (`PromptBuilder.ts:138-139`) | `PromptBuilder.test.ts` |
| **P1-8** | pr-design-system | `dialogs/BotDialog.tsx:30-35,91`, `settings/ClaudeSection.tsx` → **Providers**, `ProviderCard.tsx`, `SettingsDialog.tsx:105`, `Onboarding.tsx:72`, `ChatPane.tsx:673` | Provider select per bot (hidden when one provider is enabled). Settings section renamed Providers, "not ready" dot moved to it. **Fix ProviderCard's Re-check button nested in `role="radio"`** (radio covers the title row only). Composer model picker gated on "every member of this room runs on Claude", not the global `settings.provider` (`:673`). Warn when Gemini is picked for a bot with automations. Size M | Keyboard reachable; `untested` label kept; model list follows the provider | Manual, web tests |
| **P1-9** | pr-design-system | `FleetPages.tsx:248` (`UsageSection`) | Group usage by provider; subscription cost marked "estimate" | — | Manual |
| **P2-1a** | pr-backend | new `providers/acp/{client,adapter,events}.ts`, `package.json` (`@agentclientprotocol/sdk`, pinned) | ACP transport and session: spawn per turn, `initialize`, `session/new\|resume\|load` with HTTP MCP (per-turn bearer) or a stdio bridge, stream to `TurnSink`, `cancel` → interrupt, `usage_update` → `contextTokens` | Fake ACP agent fixture: text, tool call, cancel, usage | Unit tests (run by existing `pnpm test` in CI) |
| **P2-1b** | pr-backend | `providers/acp/permissions.ts` (new), `permissions/PermissionBroker.ts` | `request_permission` → broker: `ToolKind` + `locations` through `pathRules.isInside`, `execute` through `classifyBash`, else a card; start the agent in its most restrictive approval mode for strict turns | Out-of-workspace edit raises a card; unknown kinds card; bypass answers `allow_once` except strict turns | Unit tests |
| **P2-2** | pr-backend | new `providers/gemini.ts`, `shared/src/providers.ts`, `config.ts:184-188`, `providers/env.ts:25-38` | Gemini preset: `agy acp`; `check()` with version, login state, **reported auth method**, `exePath` (`AGY_EXE` override first), install hint; `testedVersions`; lenient version parse; models; limit matcher from a captured fixture; `maturity:'untested'`; Gemini env list incl. the key variable only | Missing CLI gives a clear hint; nothing is downloaded; shims resolved without `shell: true` | Unit tests, then P2-4 |
| **P2-3** | pr-backend | `rooms/RoomRouter.ts`, `agent/BotRunner.ts:257` | Gemini guard with `isAttended()` (§4.6): unattended turns refuse on a Google login with a clear note, run when `check()` reports API-key auth | A routine on a Gemini OAuth bot posts the note and does not run; with reported API-key auth it runs strict; a failover-card press runs | Unit test |
| **P2-4** | **owner** + pr-backend | `docs/PRODUCTION-CHECKLIST.md` | Live smoke on the owner's Google AI account: DM, hand-off, approval card, interrupt, **does `agy` ask for writes and shell**, where it stores its login (PC and VPS), the limit fixture, the key variable name. Then `maturity:'verified'` | Checklist ticked | Manual |
| **P2-5** | pr-backend | `providers/acp/` | (Stretch) Advertise `fs/*` and `terminal/*` client capabilities through the hub guards; `permissions:'full'` if `agy` uses them | Out-of-workspace write cards without the prompt rule | Live + unit |
| **P3-1** | pr-backend | `services/ProviderHealth.ts`, `rooms/RoomRouter.ts`, `permissions/PermissionBroker.ts`, `db/approvalStore.ts`, `shared/src/models.ts` | Failover card kind (person-only, expires at `resetsAt`, Needs-you). On limit: turn ends, note, card if a backup is set. Press → new lane item on the same cause with `providerOverride` + `forceStrict`, seeded, remaining budget, attended. Unanswered → quiet note. Sticky for attended turns until reset. Never on `auth` or interrupt. Size M/L | No slot is held while the card waits. Limit on Claude continues on the backup once per press; no loops; budget not raised; a routine's card left unanswered never switches | Unit tests with stub providers and a fake clock |
| **P3-2** | pr-design-system | `ui.tsx` (`ActionCard`, from spec 02 task 3.0), `ChatPane.tsx`, `BotDialog.tsx`, `BotPage.tsx`, sidebar | Limit card on `ActionCard` (`Gauge` icon, `ring-warn/40`, Continue on <backup> / Wait until 14:00; quiet note when expired). One "If Claude hits its limit" backup select in BotDialog (owner only). Muted Badge "On Gemini until 14:00" in the chat header, Bot page and sidebar row | AA; reduced motion; the card never offers a button the hub would refuse | Manual |
| **P4-1** | pr-backend | `agent/BotRunner.ts:196`, `providers/acp/` | Rotation gated on "provider reports contextTokens"; ACP `compaction_update` → quiet note | Gemini session rotates at the threshold | Unit test |
| **P4-2** | pr-design-system | `BotPage.tsx` header, DM chat header | Context meter on the `Meter` primitive (used / window, rotation marker) | — | Manual |
| **P5-1** | pr-backend | `providers/opencode.ts` | (Deferred) Local endpoint through OpenCode, `untested` | — | Fixture only |
| **D-1** | planner | `docs/GUIDE.md`, `packages/site` (via pr-design-system) | "Providers" page: what each login allows, the unattended caveat, no pooled accounts | — | Review |
| **I-1** | pr-infra | `packages/desktop/src-tauri/src/lib.rs:470-495` | Re-read user and machine `Path` from the registry (expand `REG_EXPAND_SZ`) each time the hub is spawned | Installing a CLI while the app is in the tray is seen after "Restart hub" | Manual on Windows |
| **I-2** | pr-infra | `packages/desktop/src-tauri/src/scan.rs:436,590` | (Optional) a read-only `command -v agy` line in the SSH scan; one line, no single quotes | Scan reports Gemini on servers | `cargo test` |

## 8. Order and dependencies. Revised after review 2026-11-17
```
P0-1 → P0-2 → P0-3, P0-4 (parallel) → P0-5          (can start alongside spec 02 step 4)
P1-1 → P1-2 → P1-3, P1-4, P1-5, P1-6, P1-7 (parallel) → P1-8, P1-9
P1-2 → P2-1a → P2-1b → P2-2 → P2-3 (needs spec 02 3.2a for isAttended/manual) → P2-4 (owner) → P2-5 (stretch)
P0-2 + P2-4 + spec 02 3.0 (ActionCard) + 3.2a (forceStrict/override, parked kinds) → P3-1 → P3-2
P2-1a → P4-1 → P4-2
I-1 before P2-4; I-2 any time
```
Migration block **270-279** is recorded in `docs/specs/decisions.md`.

## 9. Risks. Revised after review 2026-11-17

- **Terms drift.** Anthropic [A1] and Google [G3] can tighten without notice; Google enforcement has hit innocent setups
  [G7]. Gemini is opt-in, a provider page explains what is allowed, nothing proxies tokens.
- **Unattended use.** Routines, triggers and timed retries are excluded for `agy` [G3]. The attended predicate and the
  reported-auth API-key check are the guard; a bug there is a terms breach, so both get tests.
- **`agy` is closed and young.** Flags and output can change; `testedVersions` warning, fake-agent contract tests, owner
  smoke per release.
- **Strict may be hollow on Gemini** if `agy` never asks. Then the backup is read-only (§4.7 item 7).
- **Quality mismatch on failover.** A Gemini backup handles a Claude-shaped task differently (skills as text, no plugins);
  the card and badge make the switch visible and chosen.
- **Notional cost** for Gemini subscription turns (ACP `cost` is optional).
- **Codex / Grok / OpenCode** stay unverifiable, dev-only and frozen.

## 10. Owner decisions (answered 2026-11-17, `05-owner-decisions.md`)
1. Gemini on the Google login: **only person-started turns**; routines, triggers and timed retries refuse, but **run if a
   Gemini API key is set** (keyed on the CLI-reported auth, §4.8).
2. Usage limit: **ask with a card**; unanswered ends with the reset time (§4.7).
3. Backup runs **always strict**.
4. Next release ships **Claude + Gemini** (after the live test); everything else dev-only.
5. Commercial: stay free and personal; any paid tier is BYO API key.
6. Codex/Grok/OpenCode adapters: dev-only, frozen.

## Appendix: OpenBot source looked at (clean room)

Read only to understand behaviour. No code, identifiers, strings or UI copy were taken.
- Repository file listing of `github.com/nightly-labs/openbot` (names of provider, ACP, usage-limit, pool, compaction and failover files).
- `packages/contracts/src/team-protocol/agent-usage-limit-v1.ts`: header comment and route shape. **Behaviour learned:** a limited
  agent's message is held with a reset time (or none), and a manager can move that agent to another model and resend the held message.
- `packages/contracts/src/team-protocol/provider-account-pool-v1.ts`: header comment. **Behaviour learned:** an account pool
  rotates each agent to the account whose window resets first, keeping a buffer below each limit. This is what §1 rules out.
- Not read: provider adapters, ACP client, failover runtime, e2e scripts (names only).
