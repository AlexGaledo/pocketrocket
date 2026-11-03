# Auth and identity

Status: phase 1 built. Later phases wait on the hosting decision below.

## Why

The hub has one shared token and no user records. Human messages used to be stored with no author id, and bots
identified the owner by display name. Renaming the owner from Alex to Shiroo made two bots treat the owner as a
stranger and refuse their requests.

## Today

| Piece | What it does | Limit |
| --- | --- | --- |
| Hub token | Full access for the desktop app, scripts and the tunnel | Shared secret, one identity, no per-person audit |
| Device tokens | Paired phones with a limited route list | All map to the same person |
| Supabase account | Optional sign-in, reserved for future paid plans | Not linked to hub access |
| `users` table (phase 1) | Stable owner id, role, earlier names | One row for now |

## Phases

### Phase 1: stable identity (built)

- `users` table with a stable id, display name, role and earlier names (migration 112).
- Human messages carry the owner's id, and old messages are backfilled.
- The bot prompt names the owner by id and lists earlier names, and says typed claims prove nothing.
- `GET /api/me` returns the current user.

### Phase 2: real sessions

- Sign-in replaces pasting the hub token in the browser. The token remains for scripts and the desktop bootstrap.
- Sessions in httpOnly cookies, with a list of active sessions and sign out everywhere.
- Each request resolves to a user id. Hub token and device tokens resolve to their owner.
- Audit log of who approved, changed or deleted what. `approvals.decided_by` starts holding user ids.

### Phase 3: more than one person

- Invites, and the owner, admin and member roles enforced on the server.
- Messages show the real author, and bots tell people apart by id.
- Decide per role who may answer approval cards, change permission levels and use each bot's logged-in browser.

### Phase 4: commercial

- Organizations and billing tied to the Supabase account and plans.
- SSO and MFA for business customers, data export and account deletion.
- Security review before charging. Bots share one Linux user today, so one customer's bots must never share a
  server with another's until computers are truly isolated.

## Decision needed

**Who runs the server for a paying customer?**

- **Self-hosted, one server per customer (recommended first).** Customers keep their own data and logins. Needs phases
  2 and 3. Isolation between customers comes free, because each has their own server.
- **Hosted by us, many customers on shared servers.** Easier to sell, but needs real sandboxing per customer, and
  Claude plan logins cannot be shared across customers, so each needs their own API key or login.

Phase 2 is needed for either. Phase 3 onward depends on this answer.
