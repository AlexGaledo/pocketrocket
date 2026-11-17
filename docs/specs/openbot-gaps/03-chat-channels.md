# Gap 3: Chat channels (WhatsApp, Discord, Telegram, Slack, Teams)

Status: plan, **revised after review 2026-11-17**: owner answers in `05-owner-decisions.md` are applied (§9) and the
required changes from `review-backend.md`, `review-design.md` and `review-infra.md` are folded in. **Scope now: Telegram
notifications only (Phase A).** Phases B-E are kept as the later plan. Research sources were read on 2026-11-17. Owner rules from `00-openbot-recon.md` apply:
clean room (we read OpenBot's docs to learn behaviour and copy nothing), MIT, free for now, flag anything that
would block selling or hosting later.

## 0. Verdict

| Channel | Two-way channel (bot reads and answers in the app) | Trigger / notify only | Verdict |
|---|---|---|---|
| **Telegram** (Bot API, BotFather token) | Yes. Outbound long-poll `getUpdates`, no public URL, no new dependency | Yes, simplest phone-notify path we have | **Go: notify now** (05 §03 #6); chat later |
| **Discord** (the owner's own bot application) | Yes. Outbound gateway WebSocket. Message Content intent is not needed for DMs and mentions | Yes (DM to the owner) | **Go with limits.** Second. No self-bots. Mentions and DMs only |
| **Slack** (the owner's own app, Socket Mode, already shipped) | Mostly built. Add threads, reply to where the message came from, and buttons | Already shipped as a trigger | **Go with limits.** Deepen after Telegram. Data must not train an LLM |
| **Teams** (delegated Graph, already shipped) | A real two-way bot needs Azure Bot Service with a public HTTPS endpoint. Today's client posts *as the user* | Keep the current 60 s poll trigger | **No-go** for two-way. Keep it as a trigger |
| **WhatsApp, official** (Cloud API) | Needs a public HTTPS webhook, a Meta business portfolio, templates outside the 24 h window, and per-message fees from 2026-10-01. **Section 4.7 bans general-purpose AI assistants as the primary function** | Notify needs a paid template | **No-go** |
| **WhatsApp, unofficial** (Baileys / whatsapp-web.js linked device) | Works from a home PC (an outbound socket). It breaks WhatsApp's Terms and can get the number banned | Same risk | **No-go** (owner decision 05 §03 #1) |

**Correction to the recon** (`00-openbot-recon.md`, "No Telegram seen"): OpenBot ships Telegram, Discord and Slack.
All three run through **its own cloud relay ("Signal")**, which holds one shared bot token and needs an OpenBot account.
WhatsApp is the only local one: a vendored Baileys linked device, with a ban warning in its own docs
(github.com/nightly-labs/openbot `docs/messaging.md`, read 2026-11-17).
**Where we can lead:** each owner brings their own bot token, the hub connects directly with no relay and no
account, and the transport works with a hub that binds `127.0.0.1` (`packages/hub/src/config.ts:74`). This also
keeps decision Q5: no relay and no inbound webhooks (`docs/specs/decisions.md`).

## 1. Problem / user story

- "I'm away from my PC. I want to text my bot from the chat app already on my phone and get an answer there."
  The PWA plus pairing exists, but it needs the hub reachable from outside (decision Q9).
- "Tell me on my phone when a bot needs an approval, without installing a PWA." Web Push exists but is opt-in and
  carries no content (`services/PushService.ts:8-18`).
- "Let my bot sit in our team's Discord or Telegram group and answer when someone mentions it."

## 2. Licensing and terms (sources read 2026-11-17)

| Item | Licence / terms | What it means for us | Source |
|---|---|---|---|
| WhatsApp Terms of Service (eff. 2021-01-04) | Bans access "through automated or other means", "bulk messaging", auto-messaging, reverse engineering, and software that works like the Services. Meta "may … terminate your access … for any reason" | Any unofficial client puts **the user's number** at risk. Meta could also claim our project assists the breach ("or assist others to") | https://www.whatsapp.com/legal/terms-of-service |
| Meta Terms for WhatsApp Business Platform §4.7 "AI Providers" (last modified 2026-09-23) | Providers of LLMs, generative AI platforms or general-purpose AI assistants are "strictly prohibited" from the platform when AI is the "primary (rather than incidental or ancillary) functionality". Some countries are excepted. Platform data may not train models | PocketRocket's bots are exactly that, so bring-your-own Meta app does not help: the user becomes the prohibited provider. Hosting it later would make **us** the provider. **Blocks selling and hosting** | https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform ; reporting: https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform |
| WhatsApp Cloud API pricing | Per message since 2025-07-01. Inbound is free. Service replies are free only inside the 24 h window and only up to 1,000 per number per month from 2026-10-01. Templates are needed outside the window | Ongoing cost and template approval, even for one person | https://developers.facebook.com/docs/whatsapp/pricing |
| WhatsApp Cloud API webhooks | Public HTTPS with a valid CA certificate. Self-signed certificates are not supported | Needs a relay or tunnel, which breaks principle 1 and decision Q5 | https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks |
| WhatsApp Cloud API test number | Up to 5 verified recipients. Unverified portfolios are limited to 250 recipients per 24 h (third-party sources) | It is a test path, not a product path | https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/ ; https://help.wanotifier.com/en/article/test-phone-number-limitations-kt0ly2/ |
| Baileys | **MIT.** "Not affiliated … with WhatsApp". It "discourage[s] … bulk or automated messaging" | The licence is fine. The risk is the Terms, not the code. It is a protocol re-implementation that breaks when WhatsApp changes the protocol | https://github.com/WhiskeySockets/Baileys |
| whatsapp-web.js | **Apache-2.0.** "WhatsApp does not allow bots or unofficial clients … not guaranteed you will not be blocked." It drives WhatsApp Web through Puppeteer | Same Terms risk. It also needs a headless Chromium, which is heavy on the desktop installer (about 30 MB today) | https://github.com/pedroslopez/whatsapp-web.js |
| Discord: self-bots | "using a user token in any application (known as a Selfbot), or any automation of your account, may result in account suspension or termination." A spokesperson called self-botting a ToS violation | Bot applications only. Never ask the user for a Discord user token | Discord safety page "tips against spam and hacking" (https://discordapp.com/safety/360044104071-tips-against-spam-and-hacking), via search. Discord's support site returned 403 to our fetcher, so the Developer Terms and Policy text could not be read; see the open item below |
| Discord: Gateway, privileged intents | `MESSAGE_CONTENT` is privileged. Without it, content is empty **except** in DMs with the app, messages that mention the app, and the app's own messages. Apps under 100 servers can switch on privileged intents without review. Verification is required at 100+ servers, and a review at 10k users | A bot the owner makes for one or a few servers works without any review if we read DMs and mentions only. A hosted, shared bot would need verification | https://docs.discord.com/developers/events/gateway |
| Discord: AI | Discord's policy page: "we do not allow AI companies to train their models using your messages." | We never train. We run inference only, for the server's own members | https://discord.com/safety/important-policy-updates |
| discord.js / @discordjs/ws | **Apache-2.0** (keep NOTICE if bundled) | Optional. The gateway can be written on the `ws` we already ship (`packages/hub/package.json`) | https://github.com/discordjs/discord.js |
| Telegram Bot Developer ToS (undated, "effective when posted") | §4: the bot must have an accessible privacy policy. §4.2: delete data when no longer needed or when asked. §4.3: no collecting "to create large datasets, machine learning models and AI products". **§4.4: user data encrypted at rest and stored apart from its key.** §6.2: digital goods sold *inside* Telegram must use Stars. §10: violations can lead to a ban | Inference for the chat's own users is fine. **§4.4 conflicts with our plaintext SQLite messages table** (see risks). §6.2 only matters if we ever sell inside Telegram. The developer of record is the owner who made the bot | https://telegram.org/tos/bot-developers |
| Telegram Bot API (v10.4, 2026-11-09) | Two mutually exclusive ways to receive updates: `getUpdates` long-poll or `setWebhook` (ports 443/80/88/8443). Unfetched updates are kept up to 24 h | Long-poll needs no public URL. Messages sent while the PC is off arrive later, within 24 h | https://core.telegram.org/bots/api |
| Telegram features | BotFather `/newbot` gives a token. Privacy mode on by default: in groups the bot sees only commands, replies to it and mentions. Bots don't see other bots unless "Bot-to-Bot Communication Mode" is on | Safe defaults for groups. Keep privacy mode on | https://core.telegram.org/bots/features |
| Telegram encryption | Bot chats are cloud chats (server-client encryption, not end-to-end). Bots can't join Secret Chats (secondary sources) | Message **content** passes through Telegram's cloud. That bends principle 1, so the user must opt in knowingly | https://core.telegram.org/api/end-to-end ; https://bugs.telegram.org/c/4566 |
| grammY / telegraf | **MIT** (grammY) | Optional. The Bot API is plain HTTPS JSON and `fetch` is enough, so we add no dependency | https://github.com/grammyjs/grammY |
| Slack developer policy, API terms (2025) | Prohibits "Using Data to train an LLM under any circumstances". API terms bar bulk export and persistent copies. Since 2025-05-29, non-Marketplace **commercially distributed** apps are limited to 1 req/min on `conversations.history/replies`. **Internal custom apps are exempt** (50+/min) | Our bring-your-own-app model is an internal custom app, so the 1/min note in `integrations-client-api.md` (Slack row) is too pessimistic and should be corrected. Do not keep long-term copies of channel history. Store only what the bridged conversation needs | https://docs.slack.dev/developer-policy ; https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps |
| OpenBot (for reference only) | PolyForm Noncommercial 1.0.0 | Clean room. We read its doc page `docs/messaging.md` for behaviour only and copy no code, names or text | https://github.com/nightly-labs/openbot |

**Open item:** the full Discord Developer Terms and Developer Policy (support-dev.discord.com) answered 403 to our
fetcher. Before Phase D ships, the owner or an agent with a browser should check their data-retention and AI
clauses.

### Things that block selling or hosting later
1. **WhatsApp Cloud API §4.7.** A hosted PocketRocket would be the prohibited "AI Provider". Permanent unless Meta
   changes the terms.
2. **WhatsApp unofficial clients.** Shipping one in a paid product invites a takedown, and it ties paying users'
   numbers to a ban risk. OpenBot accepts this risk. We should not, at least while we are unsigned and pre-revenue.
3. **Discord hosted shared bot.** It needs verification and privileged-intent review at 100 servers or 10k users,
   plus a public privacy policy. Bring-your-own app avoids this, but a hosted plan could not use one shared bot
   without that review.
4. **Telegram §4.4 and the privacy policy.** A hosted service would be the bot developer of record. It would need a
   privacy policy and encryption at rest for stored Telegram user data.
5. **Slack.** A hosted multi-workspace app is "commercially distributed": it gets the 1/min history limit until
   Marketplace approval, and the no-LLM-training rule still applies.

## 3. How a channel fits what we have (file:line)

**What exists today**
- Slack is already half two-way. `SlackSocketMode` is an outbound WSS with ack-first, reconnect and backoff
  (`services/SlackSocketMode.ts:36-151`). Events become trigger events (`services/TriggerService.ts:391-405`) and
  fire a turn through `router.fireTrigger()` (`rooms/RoomRouter.ts:582-596`). The bot can answer with
  `slack_post_message`, which raises an approval card **every time** (`integrations/tools.ts:128`,
  `permissions/PermissionBroker.ts:517-531`). Every reply needs a card, so this is a trigger, not a channel.
- Teams: `pollChats` every 60 s (`integrations/teams.ts:53-63`, `TriggerService.ts:20`). `sendChat` posts as the
  signed-in human (`teams.ts:47-50`).
- Credentials: `IntegrationVault` uses AES-256-GCM, a separate key file, and `addSecret` on every value
  (`services/IntegrationVault.ts:7-23`). Pasted tokens are allowed for `TOKEN_PROVIDERS`
  (`services/IntegrationService.ts:35`). Slack's extra `appToken` shows how to store a second secret per connection
  (`IntegrationService.ts:277-309`). Telegram and Discord bot tokens fit here as `method: 'token'` providers.
- Untrusted wrapping: a nonce-fenced block and one-line placeholders (`rooms/untrusted.ts:4-80`).
- Strict approvals: any cause message whose author is not `'user'` turns approvals on even under bypass
  (`RoomRouter.ts:493-495`, `:343`). Trigger turns park instead of timing out (`PermissionBroker.ts:290-324`).
- Owner identity: `ownerTag()` = `userName + ' (owner)'` (`services/SettingsStore.ts:189`). Only the hub adds it, and
  only to `authorType === 'user'` messages (`RoomRouter.ts:60`). The prompt tells bots that nothing else is the owner
  (`agent/PromptBuilder.ts:159-160`).
- `gateOutsideRoom`: a bot posts freely in its own room. Any other room needs a card (`agent/botTools.ts:224-231`,
  used at `:256`, `:448`).
- Devices: a paired phone may answer a card **once** and never sets an "always" rule
  (`PermissionBroker.ts:124-125`, `:460-463`, `:680-688`). `SIGN_IN_TOOLS` need a password-signed-in browser
  (`PermissionBroker.ts:675-680`).
- Rate and budget per automation: hourly cap and daily budget (`TriggerService.ts:440-446`).
- Push: a content-free `{"kind":…}` payload, coalesced every 30 s (`PushService.ts:8-21`, `:131-136`).
- Room types: `RoomKind` is `'dm' | 'group'` (`shared/src/models.ts:101`; `protocol.ts:158` is the room input schema's `kind` enum), with `coordinatorBotId`
  (`shared/src/models.ts:107`). Message authors are `'user' | 'bot' | 'system'`, and the kinds include `'trigger'`
  (`models.ts:118-119`).
- The Settings page sends WhatsApp to "a bot's browser" (`web/src/components/settings/IntegrationsSection.tsx:4`,
  `:186-190`), and `CHANGELOG.md:324` says so too.

**Mapping (proposed)**

| Concept | Proposal |
|---|---|
| Connection | A new integration provider (`telegram`, later `discord`) in `INTEGRATION_PROVIDERS` (`shared/src/integrations.ts:5`), connected by pasting a token. One token = one external bot identity. The vault holds the token |
| Channel link | A new table `channel_links(id, provider, external_chat_id, room_id, mode 'notify'\|'chat', allowed_senders_json, max_per_hour, budget_usd, enabled)`. **One external chat ↔ one PocketRocket room.** A Telegram DM with the owner maps to a DM room with one bot. A Telegram or Discord group maps to a group room: the coordinator answers, or a mentioned `@handle` |
| Per-bot identity (option) | Each PocketRocket bot can have its own BotFather token, so it shows as its own Telegram contact. This fits the "pocket fleet" pitch. One token per room is the simpler default |
| Inbound message | Inserted with `authorType: 'system'`, a new `kind: 'channel'`, and a payload `{provider, chatId, senderId, senderName, externalMsgId}`. Because it is not `'user'`, the turn is **strict** (`RoomRouter.ts:493-495`). Text is fenced with `wrapUntrusted` (`untrusted.ts:50`), and **never** gets `ownerTag()` |
| Outbound reply | When the turn ends, `ChannelService` posts `TurnResult.finalText` (`agent/BotRunner.ts:77-80`) to **the chat the message came from**, after `redact()` (`providers/redact.ts:44`). `NO_REPLY` posts nothing. This *origin reply* is the one ungated write (Q3). Posting to any other chat or app still goes through `askIntegrationWrite` |
| Approvals | Cards stay in the hub (the Needs-you inbox, Web Push or Telegram notify). Answering from the chat app is Q2 |
| Strangers | Default allowlist = the owner's own external account only. Everyone else is dropped, and a "wants to talk to @bot" request is listed in Settings for the owner (Q4) |
| Cost | Each link has an hourly cap and a daily budget, using the trigger code path (`TriggerService.ts:440-446`). The cause cost cap applies |
| History | Store only messages of linked chats, in the room's messages. No back-fill and no bulk history (Slack terms, Telegram §4.2) |

**Transport check (hub binds 127.0.0.1)**

| Channel | Transport | Public URL? | Missed while offline |
|---|---|---|---|
| Telegram | `getUpdates?timeout=50` long-poll over HTTPS (`fetch`) | No | Kept up to 24 h by Telegram |
| Discord | Gateway WSS (identify, heartbeat, resume) on the `ws` package we already have. Interactions (buttons) arrive on the gateway when no endpoint URL is set | No | Lost (no replay). Resume covers short drops |
| Slack | Socket Mode WSS (exists) | No | Lost (`SlackSocketMode.ts:42`) |
| Teams two-way bot | Azure Bot Service posts to a messaging endpoint | **Yes** | n/a (no-go) |
| WhatsApp Cloud API | Meta webhook | **Yes, valid TLS** | n/a (no-go) |
| WhatsApp linked device | Outbound socket | No | Queued on WhatsApp's servers |

**One consumer per token:** Telegram `getUpdates` and a Discord gateway session each allow only one live consumer. A
PC hub and a VPS hub using the same token will conflict (Telegram answers 409). The token belongs to one hub, and the
UI must say so.

## 4. Options

| Option | What | For | Against |
|---|---|---|---|
| **A. Notify only** (Telegram first) | Hub → owner's Telegram: the fixed text "A bot needs your approval", or "A routine finished", plus a link. Outbound `sendMessage` only | Small (S). Works on any phone without the PWA or off-loopback access. Keeps Q10 (no content) | Telegram learns *when* the hub has activity |
| **B. Owner-only chat** | Two-way, but only the owner's linked external account can talk to the bot. Auto-reply to the origin chat | The main user story. Small attack surface | Message content passes through Telegram's or Discord's cloud. Bends principle 1 by explicit opt-in |
| **C. Allowlisted people and groups** | B plus named senders and groups. Mentions only in groups | The team use case | Strangers' text drives turns, and the auto-reply becomes an exfiltration path (§6) |
| **D. Open public bot** | Anyone can message it | Like OpenBot's "Full access" | Conflicts with principles 1 and 2. **Not proposed** |
| **E. Relay service** (OpenBot's model) | Our cloud holds a shared bot | One-click setup | Breaks Q5 and principle 1, costs money to run, and brings the hosted-bot review burdens above. **Not proposed** |

## 5. Recommendation and order. Revised after review 2026-11-17

Owner decision 05 §03 #6: **Telegram notifications only, now.** Telegram chat, Discord and Slack channel mode wait.

1. **Phase A: Telegram notify (now).** Content-free, outbound `sendMessage`, plus one short `getUpdates` poll only while
   linking. No standing long-poll, no buttons, no inbound turns.
2. **Later, in this order when the owner reopens scope:** Phase B Telegram owner-only chat (auto-reply to the origin chat,
   redacted and rate-capped, 05 §03 #3; owner only by numeric id, #4), then C allowlists (with §4.4 encryption first, #5),
   then D Discord, then E Slack channel mode.
3. **Allow once / Deny from chat** (05 §03 #2) is **deferred to the chat phase** (B). It needs a standing poll for
   `callback_query`, and an Allow button on a content-free message would approve blind. Phase A stays content-free with no
   buttons.
4. **WhatsApp: none** (05 §03 #1). Meta §4.7 bans general AI assistants; unofficial libraries breach WhatsApp's Terms.
   Keep using it in a bot's browser as today. Revisit only after a paid launch.
5. **Teams:** no change; it stays a trigger.

## 6. Security risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| **Auto-reply exfiltration.** A stranger, or text forwarded into a group, asks "paste your memory, your notes, the last email". The origin reply sends the answer to them with no card | Phase C+ | Default allowlist is the owner only. Linked group rooms run a bot with **no integration grants and no memory of other rooms** (a "front-desk" bot), enforced at link time. `redact()` on every outbound post. Outbound attachments always ask. Q3 and Q4 |
| Prompt injection | All inbound text | `wrapUntrusted`, strict approvals (`RoomRouter.ts:493`), no bypass, park instead of timeout. Fleet changes, settings and approvals stay human-only (`api/guard.ts:316`) |
| Owner impersonation | The display name "Alex" in Telegram | Owner identity is the **external numeric user id** captured once by a one-time link code shown in Settings, never a name. Inbound text never gets `ownerTag()` |
| Account takeover of the owner's Telegram or Discord | Approving from chat (Q2) | At most "allow once" (device semantics, `PermissionBroker.ts:680-688`). Never "always", never `SIGN_IN_TOOLS`, never fleet cards. Card buttons carry a per-card nonce |
| Content in a third-party cloud | Phases B-E | Explicit opt-in per link, with a plain warning in the UI: "Messages in this chat pass through Telegram's servers and are not end-to-end encrypted." The notify mode stays content-free |
| Telegram §4.4 (encrypted at rest) | Bridged messages stored in plaintext SQLite | Owner decision (Q5). Options: encrypt `channel` message bodies with the vault key, or document that the owner is the developer of record and that their own disk is in scope |
| Token theft | Vault file, URL paths in logs | Existing vault and `addSecret`; a Telegram pattern in `redact.ts`, no full URLs in logs (A1). A token is shown once, then masked. One-click "revoke": tell the user to run `/revoke` at BotFather or reset the token in Discord |
| Cost runaway (spam) | Inbound floods | Per-link hourly cap, per-sender cap, daily budget, and the existing cause cap. Messages from one sender within about 2 s are coalesced into one turn |
| Bot loops (our bot ↔ another bot in a group) | Groups | Ignore messages from bots (Telegram `from.is_bot`, Discord `author.bot`, Slack `bot_id`, as already done at `TriggerService.ts:394`). Keep Telegram's bot-to-bot mode off |
| Double consumers | PC and VPS with the same token | Lock the token to one hub id. Show the 409 as "Another PocketRocket is using this bot" |

## 7. Tasks

Sizes: S ≈ half a day for one agent, M ≈ one pass of 1-2 days, L = split further.

### Phase A: Telegram notify (content-free). Revised after review 2026-11-17
| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| A1 | pr-backend | `shared/src/integrations.ts:5`, `services/IntegrationService.ts:35`, new `integrations/telegram.ts`, `providers/redact.ts` | Add `telegram` as a token provider. `TelegramClient`: `getMe`, `sendMessage`, `getUpdates` via `apiRequest` (`integrations/http.ts`). **Token hygiene:** the token sits in the URL path (`/bot<token>/`), so `addSecret` it on load, add a Telegram token pattern (`\d{8,10}:[A-Za-z0-9_-]{35}`) to `redact.ts`, route `apiRequest` errors and logs through `redact`, never log full request URLs | Valid token shows `@botname`; a bad token gives a 400 with Telegram's words; a thrown error containing the token is redacted in `hub.log` | unit tests with `fakeFetch.ts` (S) |
| A2 | pr-backend | `IntegrationService.ts`, `api/integrations.ts`, `hub.ts` (shutdown) | "Link my Telegram": one-time code (≥ 8 random base32 chars, single use, 10 min) and a `t.me/<bot>?start=<code>` deep link. A short `getUpdates` poll, each `fetch` with an `AbortController` that hub shutdown aborts, acknowledged with `offset = last+1`, stopped once linked. Accept only `chat.type === 'private'`, `from.is_bot === false`, `from.id === chat.id`, update `date` after the code was issued. Lock linking after about 5 wrong codes. Store `from.id` (never username or display name). 409 shows "another PocketRocket or a webhook uses this bot"; never call `deleteWebhook`. Expose link status (linked + display name to mask), the code's `expiresAt`, and a test-send route | Only the code's sender is linked; wrong, expired, group or bot senders are ignored; shutdown does not wait for the poll | tests with fake updates and a fake clock (M) |
| A3 | pr-backend | `services/PushService.ts:131-160` | Restructure `notify()` into per-sink gates. Today it returns early when there are no Web Push subscriptions (`:134`) and keeps one coalesce stamp per kind (`:133`, `:135`), so a Telegram-only owner would never be notified. Each sink (Web Push, Telegram) gets its own gate and its own 30 s coalesce stamp. Telegram sends one fixed text per kind plus a hub link | Telegram-only owner is notified. The payload text is one of the fixed strings: no bot, room or tool name | test that pins the bytes sent (S) |
| A4 | pr-design-system | `web/src/components/settings/NotificationsSection.tsx`, `SettingsDialog.tsx:100` | **Placed under Notifications, not Connections** (Telegram notify is not a bot tool with grants). Show the Notifications section on every non-device client (the desktop card keeps its `canNotify()` gate), with a pointer to "Phone: Devices › Notifications on this device". Telegram card: `ApiKeyField` token (masked after check, shows `@yourbot`); link step reusing the Devices pairing pattern (`DevicesSection.tsx:140-197`: mono code read per character, "Valid 10 minutes", "Open in Telegram" link, `QrCode` of the deep link); "Linked to <name>" behind `Private`; the content-free cloud warning **visible before** the "Notify me here" `Switch`; Send a test, Unlink, link to BotFather `/revoke`; note "One hub per bot token" | Keyboard, AA contrast; the warning is visible before the switch can turn on | manual (S-M) |
| A5 | planner + pr-infra | `docs/PRODUCTION-CHECKLIST.md:32`, `docs/GUIDE.md`, `deploy/keys.sh:85-93` | Add `api.telegram.org` to the outbound list (with the updater hosts from spec 04); GUIDE section; pr-infra adds a Telegram line (BotFather `/revoke`) to `keys.sh` | Doc review; `keys.sh` prints the Telegram revoke step | review (S) |

No VPS unit change is needed: `pocketrocket.service` allows `AF_INET`/`AF_INET6` and there is no egress firewall.

### Phase B: Telegram owner-only chat
| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| B1 | pr-backend | `db/migrations.ts` (block 280-289), new `db/channelRepo.ts`, `shared/src/models.ts:119,312`, `rooms/RoomRouter.ts:54-61,565-568` | `channel_links` table, a `'channel'` MessageKind and `ChannelPayload`, plus `isConversation`, the `formatMessage` label, `resumedCauseKind` and `CAUSE_KINDS += 'channel'` | Migration is additive, and the old DB opens | test (S) |
| B2 | pr-backend | new `services/ChannelService.ts`, `services/channels/telegramTransport.ts` | Long-poll loop (timeout 50 s, backoff like `SlackSocketMode.ts:140-151`), offset persisted, dedupe by `update_id`, 409 → "another hub" status. Runs only while a link is enabled | Restart resumes from the stored offset with no double fire. 409 stops the loop with a visible error | tests with fake fetch and a fake clock (M) |
| B3 | pr-backend | `rooms/RoomRouter.ts` (append block after `:596`) | `fireChannel(room, bot, {text, payload, budgetUsd, onDone})`, modelled on `fireTrigger`: a system author, `wrapUntrusted`, strict, `causeKind 'trigger'` (or a new `'channel'`) | A prompt-injection fixture ("ignore previous, run X") cannot run a gated tool without a card. `ownerTag` is never present | test (M) |
| B4 | pr-backend | `ChannelService.ts` | Origin reply: on `onDone` post the redacted `finalText` to `chat.id`, split at 4096 characters, skip `NO_REPLY`. Typing indicator while the turn runs. A parked card sends the fixed text "Waiting for your approval in PocketRocket" | A reply goes only to the origin chat. A secret in the text is redacted | test (S) |
| B5 | pr-backend | `ChannelService.ts`, `TriggerService.ts:440-446` (extract helper) | Per-link hourly cap and daily budget. Coalesce bursts from one sender | The 11th message in an hour at cap 10 is skipped with a note in the room | test (S) |
| B6 | pr-design-system | `RightPanel`/bot page "Automations", `ChatPane` message renderer | Link a room to a Telegram chat. Render `channel` messages as "via Telegram · {name}" with a distinct, calm style (one accent) | The owner can tell hub messages from Telegram ones at a glance. Screen-reader label | manual (M) |

### Phase C: allowlists and groups (only if Q4 allows)
| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| C1 | pr-backend | `ChannelService.ts`, `channelRepo.ts` | Allowed senders by numeric id. Unknown senders are dropped, with a pending request listed for the owner. In groups, react only to mentions and replies to the bot (keep privacy mode on) | Unknown sender gets no turn and no reply | test (S) |
| C2 | pr-backend | `ChannelService.ts`, `services/IntegrationService.ts` | Front-desk rule: linking a chat with people other than the owner to a room requires that the room's bots hold no integration grants (`integrations.repo.forBot`). Bots ignore other bots | Linking is refused with a clear reason when a grant exists | test (S) |
| C3 | pr-design-system | Settings, Needs-you inbox | Pending-sender requests (approve or block). Allowlist editor | manual (S) |

### Phase D: Discord bring-your-own app
| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| D1 | pr-backend | new `integrations/discord.ts`, `services/channels/discordGateway.ts` | Gateway on `ws`: identify with non-privileged intents (guild messages, DMs), heartbeat, resume, reconnect. REST `POST /channels/{id}/messages`. Mentions and DMs only. Ignore `author.bot` | A mention in the test server reaches the room. Survives a forced reconnect with resume | tests with a fake socket, modelled on `SlackSocketMode` tests (M) |
| D2 | pr-backend | `ChannelService.ts` | Plug in Discord as the second transport. Origin replies split at 2000 characters. No `@everyone` or role pings (`allowed_mentions: {parse: []}`) | A reply never pings a role | test (S) |
| D3 | pr-design-system | Settings | Discord row: token, a link to the Developer Portal with steps (create app, bot, invite URL with minimal permissions), and server and channel pick | manual (S) |

### Phase E: Slack channel mode
| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| E1 | pr-backend | `services/SlackSocketMode.ts`, `ChannelService.ts`, `TriggerService.ts:371-405` | Share one socket between triggers and channel links (a single owner of the socket, events fanned out). Thread-aware conversation key (`thread_ts`) | Triggers keep working, and a linked channel replies in-thread | test (M) |
| E2 | planner | `docs/specs/integrations-client-api.md` | Correct the Slack 1/min note: internal custom apps are exempt | Doc review (S) |

### Phase Q2 (allowed by 05 §03 #2; deferred to the chat phase, after B)
| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| Q2a | pr-backend | `PermissionBroker.ts:680-688`, `ChannelService.ts` | Cards from strict turns are sent to the owner's linked chat with Allow-once and Deny buttons (Telegram `callback_query`, Discord interaction, Slack block action). The answer goes to `resolve(id, d, {device: true})`. Only the owner's numeric id is accepted. Never "always", `SIGN_IN_TOOLS` or fleet cards | A press by someone else is ignored and audited. "Always" is impossible | test (M) |

## 8. Order and dependencies. Revised after review 2026-11-17
**Now:** A1 → A2 → A3, with A4 alongside A2 (it needs A2's link-status and test-send routes) and A5 at the end. Phase A
needs no migration if link state lives in the vault entry; anything persisted beyond that uses block **280-289**
(`docs/specs/decisions.md`).

**Later (not scheduled, 05 §03 #6):** B1 → B2 → B3 → B4/B5 → B6 → Q2a → C (with §4.4 encryption first) → D → E. Phase B
needs the owner-ref journal foundation from spec 02 task 3.2a (`channel:<linkId>`) so origin replies survive a restart and a
park. B1 must also update `isConversation` (`RoomRouter.ts:54-56`), the `formatMessage` author label (`:61`),
`resumedCauseKind` (`:565-568`) and `CAUSE_KINDS` (`shared/src/models.ts:312`), or the bot never sees a channel message
and its usage is filed as `'routine'`. Phase B's long-poll passes an `AbortSignal` so a systemd stop does not wait out the
90 s stop timeout; Node's `fetch` ignores `HTTPS_PROXY` unless opted in, so do not promise proxy support.

## 9. Owner decisions (answered 2026-11-17, `05-owner-decisions.md`)
1. **No WhatsApp.** Revisit only after a paid launch.
2. The linked owner account may press **Allow once / Deny** from chat; no sign-in or fleet cards. **Deferred to the chat
   phase** (review: it needs a standing poll and must not approve blind from a content-free message).
3. **Auto-reply** to the origin chat without a card (redacted, rate-capped). Chat phase.
4. Audience: **only the owner** (by numeric id) first; allowlist later.
5. Telegram §4.4: store as usual while owner-only; **encrypt before allowlist or hosted**.
6. Scope now: **Telegram notifications only.**
