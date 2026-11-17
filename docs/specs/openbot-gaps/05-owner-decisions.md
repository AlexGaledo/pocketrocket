# OpenBot gaps: owner decisions (interview, 2026-11-17)

These answers override the "Questions for the owner" sections in specs 01-04. Where a spec's
recommendation differs, this file wins.

## Cross-cutting
- Clean room: agents may read OpenBot source, never copy code, identifiers, strings or assets.
- Commercial: free MIT tool now. Licence: **MIT + CLA** from the first outside PR.
- If sold later: **managed self-host** (customer's own cloud + own API key, setup/support fee). No
  multi-tenant hosting, no seats for now.
- Ship order: **steering + workflows first**, then providers. Distribution budget **$0/yr**.
- Test accounts: Claude Max; Google AI (Gemini) to be added. No ChatGPT/Codex, Grok, or local GPU.

## 02 Steering + workflows
1. Busy bot: **message joins the running turn**; Alt+Enter queues. Bot-to-bot hand-offs always queue.
2. Automation turns (routine/trigger/workflow) can be steered; they keep strict approvals and their budget. (recommended default)
3. Workflow editor: **canvas with React Flow (`@xyflow/react`, MIT), lazy-loaded.** Owner chose this
   over the step list. Planners: keep the underlying data a plain step graph so a list view can also render it on phones.
4. Image/video: **defer**; document "add an image MCP server" only. Owner asked whether ChatGPT can do
   images: the ChatGPT app can, but the OpenAI Images API is billed separately and not part of ChatGPT
   plans. Whether Codex CLI on a ChatGPT login exposes image generation is **unverified**: check when
   Codex returns to scope.
5. Non-steering providers (Gemini, Codex, OpenCode, Grok): queue with a note why. Codex app-server rewrite parked. (recommended default)
6. Queue controls: **cancel, edit, send now, pause**; no reorder.

## 01 Providers + failover
1. Gemini (Antigravity login): **only person-started turns**; routines, triggers and timed retries refuse
   on the Google login, but **run if a Gemini API key is set**.
2. Usage limit hit: **ask with a card** ("Claude limit hit, continue on <backup>?"). Note: owner chose
   this over the off-by-default chain; the card still needs a configured backup to offer, and an
   unanswered card (routine/trigger turns) must end the turn with the reset time, not switch silently.
3. Backup runs **always strict** (cards even under bypass).
4. Next release ships **Claude + Gemini** (Gemini after live test); everything else dev-only.
5. Commercial path: stay free/personal; any paid tier is BYO API key. (from cross-cutting)
6. Codex/Grok/OpenCode adapters: dev-only, frozen. (recommended default)

## 03 Chat channels
1. **No WhatsApp** (Meta §4.7 bans general AI assistants; unofficial libraries breach WhatsApp ToS).
   Revisit only after a paid launch.
2. Linked owner account may press **Allow once / Deny** from chat; no sign-in or fleet cards there.
3. **Auto-reply** to the origin chat without a card (redacted, rate-capped).
4. Audience: **only the owner** (by numeric id) first; allowlist later.
5. Telegram §4.4 storage: store as usual while owner-only; encrypt before allowlist/hosted. (recommended default)
6. Scope now: **Telegram notifications only.** Telegram chat, Discord and Slack channel mode wait.

## 04 Distribution + money
1. Signing: **unsigned + checksums + attestations now; apply to SignPath Foundation in parallel.**
   Decide on unbundling the Agent SDK only after SignPath answers.
2. Licence: **MIT + CLA.**
3. Multiplayer: deferred until gap 1 settles credentials, then only on API key or Team/Enterprise login. (recommended default)
4. Selling: free now; managed self-host first if ever.
5. Docker: Linux `--network host` first. (recommended default)
6. Updates: **daily check at launch, ask before installing**, never during a turn or open approval.

## Round 2 (after reviews, 2026-11-17)
- React Flow attribution link: **keep, styled quietly**.
- Telegram notifications: **v0.3.0**.
- Versions: **updater first as v0.2.1** (with `/api/busy` + maintenance hold), then v0.3.0 = steering, queue, workflows, Telegram notify; v0.4.0 = Claude limits, provider per bot, Gemini, failover card.
- The failover card press counts as an attended turn (backend review's `isAttended` rule), so Gemini may take it.
