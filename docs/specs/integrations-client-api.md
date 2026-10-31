# Integration clients and the poll API (P4 → P5)

Status: shipped in P4. Audience: whoever builds P5 event triggers (`TriggerService`, spec §2.3).

## Getting a client

```ts
// hub.ts already builds one IntegrationService and exposes it as `hub.integrations`.
const gh = integrations.client('github');   // GitHubClient; throws IntegrationError(404) when GitHub is not connected
```

- `client(p)` reads the credential from the vault **on every call**, refreshes OAuth tokens a minute before
  they expire, and retries a 401 once after a forced refresh. Never cache a token yourself.
- Prefer `integrations.run(p, (c) => c.pollX(...))`: it also flips the connection to `expired` (and emits
  `integrations.changed`) when the provider refuses the credential, and back to `connected` on success.
- Errors are `IntegrationError { status, auth, message }`. `auth === true` means "reconnect needed": stop
  polling that provider until `integrations.changed` shows it `connected` again. `status === 0` is a
  network failure; back off.
- Grants (`bot_integrations`) gate **bot tools**, not pollers. A trigger rule should still check that its
  target bot holds a grant for the source provider before firing (`integrations.repo.forBot(botId)`).
- Nothing here persists cursors. P5 stores `cursor` / `etag` per poller (e.g. next to `events_inbox`).

## The result shape

Every poll method returns `PollResult<T>` (`packages/hub/src/integrations/base.ts`):

| Field | Meaning |
|---|---|
| `items` | New things since the cursor (empty on `notModified` or `resync`). |
| `cursor` | Pass back next time. Opaque per method (see below). |
| `etag` | Only where the provider supports conditional GETs; pass back too. |
| `notModified` | Nothing changed (GitHub 304s are free against the rate limit). |
| `resync` | The cursor expired. Call the method's `seed*` (or poll without a cursor) and treat the gap as missed. |
| `pollIntervalSec` | The provider's own minimum interval when it states one (GitHub `X-Poll-Interval`). Honour it. |

## Per provider

| Provider | Seed | Poll | Cursor | Suggested interval | Notes |
|---|---|---|---|---|---|
| GitHub | none (first call with `cursor: null`) | `pollNotifications({ cursor })` | `Last-Modified` header, sent as `If-Modified-Since` | `pollIntervalSec` (usually 60 s) | Needs a classic PAT or OAuth token with `notifications`; fine-grained PATs get 403. |
| GitHub | none | `pollRepoEvents(repo, { etag })` | `etag` (cursor = newest event id) | 60 s | Per repository; 304 when unchanged. |
| Gmail | `seedGmailHistory()` → historyId | `pollGmail({ cursor })` | historyId | 60 s | Returns message ids added; read them with `gmailRead(id)`. 404 → `resync`. |
| Calendar | `pollCalendar({})` (pages the calendar once, returns the first syncToken, no items) | `pollCalendar({ cursor })` | syncToken | 60–300 s | Includes cancelled events (`status: 'cancelled'`). 410 → `resync`. |
| Drive | `seedDriveChanges()` → page token | `pollDrive({ cursor })` | Drive page token | 300 s | `removed: true` for deletions/trash. |
| Slack | n/a | **Socket Mode**: `openSocketModeUrl()` → one-time `wss://` URL | n/a | real time | Needs the `xapp-` app token (`connections:write`). Ack every envelope within 3 s; Slack does not replay missed events. |
| Slack | none | `pollChannel(channel, { cursor })` | newest message `ts` | catch-up only | conversations.history is ~1 request/min for non-Marketplace apps; use after a Socket Mode reconnect, not as the main feed. |
| ClickUp | `workspaces()` → pick `id` | `pollTasks({ workspaceId, cursor })` | ms timestamp of the newest `date_updated` | ≥ 60 s | 100 requests/min on Free/Business. First call without a cursor looks back 60 s. |
| Teams | none | `pollChats({ cursor })` | ISO time of the newest `lastMessagePreview` | 60 s | Delegated chat delta does not exist; this lists `/me/chats`. Read new messages with `readChat(id)`. |

## Rules that carry over from P4

- Event text is third-party content. Wrap it as untrusted data in the turn input (spec §2.3); the P4 read
  tools already prefix their output that way.
- Never put a token in a prompt, env var, event payload or log. The vault registers every stored value with
  `addSecret`, so `redact()` scrubs it, but payloads you store in `events_inbox` should hold ids and text,
  not headers.
- Write tools stay gated by `PermissionBroker.askIntegrationWrite`, which asks on every call even under
  bypass, matching decision Q6 for trigger-fired turns.
- Tests use `integrations/fakeFetch.ts` (route by method + URL prefix, inspect `calls`); pass it as
  `new IntegrationService({ db, vault, fetch })`, or to `createHub({ integrations: (db) => ... })`.
