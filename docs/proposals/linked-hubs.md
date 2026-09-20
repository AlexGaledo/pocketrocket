# Proposal: linked hubs (local PC + VPS in one session)

Status: draft for Alex, 2026-09-20. Target: after v0.2.0 (suggest 0.3.0).

## Goal

Today the desktop app is in exactly one mode: `local`, `remote` (one `ssh -L` tunnel on port 7788) or
`attach`. One window, one hub, and a bot only sees the machine its hub runs on. Alex wants:

1. Both the local hub and the VPS hub reachable in the same session, side by side, to cross-check.
2. A bot that can reach the other machine: a local bot working on the VPS over SSH, and a VPS bot
   pulling context from files on the local PC when the request needs it.

## Design

### Phase 1: both hubs at once (desktop only)

- New mode `both` in `Config` (`lib.rs`): spawn the local hub on `port` (7788) and the tunnel on
  `remote_port` (default 7789). `spawn_tunnel` already takes the forward spec; it only needs the second port.
- One window per hub, titled `PocketRocket · This PC` and `PocketRocket · <host>`, plus a menu item to
  switch or open the other. Each window keeps its own hub token and `/screen` cookie, so nothing in the
  web app changes.
- The health watcher (`watch`) runs per connection instead of per app. Losing the tunnel must not tear
  down the local hub.

### Phase 2: peer link (hub + MCP tools)

- Each hub can hold one **peer**: `{ name, url, token }` in config. The desktop sets it up in `both` mode:
  the local hub gets `http://127.0.0.1:7789` as its peer, and the tunnel adds a reverse forward
  (`-R 127.0.0.1:7790:127.0.0.1:7788`) so the VPS hub gets the local hub as its peer. No new open ports:
  everything rides the existing SSH connection, and the link exists only while the desktop app is running.
- New per-turn MCP tools, offered only when a peer is connected:
  `peer_list_dir`, `peer_read_file`, `peer_search`, and `peer_run` (shell on the other machine).
- A peer request is executed by the hub that owns the machine, under **its** rules: workspace path rules
  apply, and anything outside them raises an approval card on the owning hub. The card says which bot on
  which peer is asking. `peer_run` always asks unless that hub is in bypass mode.
- The peer token is separate from the hub token, minted per link, scoped to `/api/peer/*` only, and
  dropped when the tunnel closes.
- Local bot → VPS over plain `ssh` keeps working as it does today through Bash; the bot prompt gains one
  line naming the configured host so it knows it may use it.

### Phase 3: one window

- Rooms from both hubs in one sidebar, each bot badged with its machine. Bigger web change (two API
  clients, two WebSockets, merged stores). Only worth doing if Phase 1's two windows feel clumsy.

## Security notes

- This deliberately lets a server reach into the user's PC, which SECURITY.md currently promises cannot
  happen. It must be opt-in per link, off by default, read-only by default, and visible (a "Linked to
  <host>" indicator with a disconnect button).
- A compromised VPS hub gets exactly what the peer tools allow: reads inside the local workspace without
  a card, everything else behind a card on the PC. It never gets the local hub token.
- The threat model section and the production checklist need new rows before this ships.

## Open questions for Alex

1. Two windows (Phase 1) good enough to start, or is the merged sidebar the actual ask?
2. Should a VPS bot read local files **outside** the local workspace at all (with a card), or workspace only?
3. Is `peer_run` on the local PC wanted, or read-only access from the VPS side?
