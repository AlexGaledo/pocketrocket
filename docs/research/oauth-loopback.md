# OAuth on the loopback, paste-a-key options, and polling per provider (researched 2026-10-31)

The hub listens on `http://127.0.0.1:7790`. Each user connects with **either** their own OAuth app (PKCE plus a loopback redirect `http://127.0.0.1:<port>/oauth/callback/<provider>`) **or** a pasted key or token. Events arrive by outbound polling, plus Slack Socket Mode. Items marked *unverified* are uncertain.

## Summary

| Provider | Loopback OAuth | PKCE | Secret | Paste-key option | Event polling |
|---|---|---|---|---|---|
| Google (Gmail, Calendar, Drive) | Yes. A **Desktop app** client accepts `http://127.0.0.1:<any port>` without registering it; a Web client needs the exact URI | S256 (send it explicitly; the default is plain) | Docs call it "optional" for Desktop clients. Collect it and send it anyway | **Not viable for the REST API.** Fallbacks: Gmail IMAP/SMTP app password; Calendar secret iCal URL (read only) | Gmail `history.list` (historyId; a 404 means full resync). Calendar `syncToken` (410 means full resync). Drive `changes.list` |
| GitHub | Yes. Register `http://127.0.0.1/oauth/callback/github`; the port may differ at runtime | S256 | Yes for the web flow. The device flow needs only the client_id | **Yes.** The notifications API needs a **classic PAT** (`notifications` + `repo`). A fine-grained PAT works for repo work only | `/notifications` with `If-Modified-Since` (a 304 costs nothing) and `X-Poll-Interval` |
| Slack | Only with PKCE, which is one-way and **blocks bot scopes**. Otherwise HTTPS is required | — | — | **Paste is the default:** `xoxb-` bot token plus `xapp-` app token (`connections:write`) | **Socket Mode** (outbound WebSocket, ack within 3s, no replay). Avoid history polling: the rate limit for non-Marketplace apps is 1 request/min |
| ClickUp | *unverified* for localhost | No | Yes | **Paste is the default:** `pk_...` personal token, sent as a raw `Authorization` header with no `Bearer` | `GET /team/{id}/task?date_updated_gt=<ms>&order_by=updated`. Limit 100 requests/min on Free/Business |
| Teams (Graph) | Yes. A public client under Mobile/desktop with `http://localhost/...` ignores the port | Yes | No (public client) | **Not viable** for reading. A Workflows webhook URL works for posting only | Channel `messages/delta` (needs admin consent). Chats: poll `/me/chats` with `lastMessagePreview`. Delegated chat delta is not available |

## What to apply
- **Settings → Integrations:**
  - Google, Teams and GitHub use OAuth by default. GitHub also accepts a PAT; warn that a fine-grained PAT can't read notifications.
  - Slack and ClickUp use paste by default.
  - Offer the **device flow** for GitHub and Microsoft when the hub runs on a VPS behind a tunnel.
- **SSH tunnel:** the OAuth redirect only works when the tunnel forwards the same local port that appears in the redirect URI (`ssh -L 7790:127.0.0.1:7790`).
- **Google:** in Testing mode, refresh tokens expire after 7 days. The user should publish their own app to "In production" and click through the unverified-app warning once. Request `access_type=offline` and `prompt=consent`.
- **Scopes:**

  | Provider | Read | Write |
  |---|---|---|
  | Gmail | `gmail.readonly` | `gmail.send` |
  | Calendar | `calendar.events.readonly` | `calendar.events` |
  | Drive | `drive.readonly`, or `drive.file` for less access | — |
  | GitHub | `notifications` + `repo` | `repo` |
  | Slack | `channels:history`, `groups:history`, `im:history`, `channels:read`, `users:read` | `chat:write` |
  | Teams | `Chat.Read`, `ChannelMessage.Read.All` | `ChatMessage.Send`, `ChannelMessage.Send` |

  Teams also needs `offline_access` and `User.Read`.
- **Pollers** persist their cursor and re-seed when the cursor has expired.
