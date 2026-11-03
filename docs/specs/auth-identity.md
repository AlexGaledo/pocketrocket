# Auth and identity

Status: phases 1 and 2 built. Later phases wait on the hosting decision below.

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

### Phase 2: real sessions (built)

- Owner password, hashed with scrypt, set in Settings, Security. No password means the server token is the only way in, as before.
- Sessions in an httpOnly, SameSite=Strict cookie for 30 days. Only a hash of the session token is stored.
- Browser list, sign out one or all others, and a password change signs out the others. A revoked session's websocket closes at once.
- The server token stays for the desktop app and scripts, and resets a forgotten password. It still gives full access, so it remains the key to protect.
- Audit log, from one point in the hub for all successful API changes, plus explicit rows for sign-ins, permission levels, approval answers and fleet changes bots make. Labels and ids only.

Limits: browsers send cookies to every port on a host, so another web server on the same machine (`127.0.0.1:<other port>`) receives the sign-in cookie. Each hub's cookie name carries its port, which stops hubs signing each other out but not that leak. The Screen proxy removes the cookie before passing a request to the screen backend.

Not yet: email sign-in, MFA, and turning the server token off in the browser. `approvals.decided_by` still says `owner`, and the audit log holds who answered.

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
