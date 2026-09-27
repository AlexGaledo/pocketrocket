# PocketRocket on your phone — plan and design

Status: **Proposal, 2026-09-27.** Nothing here is built yet. The screens are on the design canvas
[PocketRocket Mobile](https://claude.ai/artifact/1W9g43ZimNuJrfzwiR51yU) (private until shared);
this document is the plan behind them.

The goal: open your phone, see your bots like contacts in a messenger, read what they did, answer
an approval card, send the next instruction. The bots keep running where they already run (your
PC or your server); the phone is only ever a client of that hub.

## Contents

- [What you get](#what-you-get)
- [How the phone reaches the hub](#how-the-phone-reaches-the-hub)
- [Delivery: web app first, native shell second](#delivery-web-app-first-native-shell-second)
- [Design direction](#design-direction)
- [Screen by screen](#screen-by-screen)
- [Hub changes](#hub-changes)
- [Web UI changes](#web-ui-changes)
- [Native shell (packages/mobile)](#native-shell-packagesmobile)
- [Security](#security)
- [Phases](#phases)
- [Open questions and risks](#open-questions-and-risks)

## What you get

| On the phone | Same as desktop | Notes |
|---|---|---|
| Chats list (bots and group chats, state rings, unread counts) | ✓ | The sidebar becomes the home screen |
| DM and group transcripts, streaming replies, tool trace chips | ✓ | Chips wrap; a chip opens a sheet with input/output |
| Approval cards, plus an **Approvals** tab across all rooms | new | The one thing a phone is better at than a desktop: answering "needs your OK" from anywhere |
| Push notifications for approvals, replies, routine runs | new | Sent by the hub itself, no third-party relay (see below) |
| Bot panel: Memory · Skills · Routines · Usage | ✓ | As a bottom sheet; Skills is read/review only, authoring stays on desktop |
| Settings: connection, notifications, appearance, sounds | subset | Provider and API-key setup stay on the desktop |
| Create a bot from a template, create a group chat | ✓ | The full bot editor (identity text, tool grants) stays on desktop |
| Screen tab (noVNC) | view-only link | Usable in a pinch, not a goal |

Out of scope for v1 mobile: onboarding the hub itself, installing Claude Code, API keys, the
provider picker, skill authoring, the desktop's SSH server scan.

## How the phone reaches the hub

This is the decision everything else hangs on. Today the hub binds `127.0.0.1` only, requires the
hub token, and rejects any `Host` or `Origin` that is not loopback ([SECURITY.md](../SECURITY.md)).
The desktop app reaches a remote hub over an SSH tunnel. Neither works from a phone as is.

Three options were weighed:

| Option | What it needs | Verdict |
|---|---|---|
| **A. Private overlay network (Tailscale) + TLS in front of the hub** | Tailscale on the PC/VPS and the phone; `tailscale serve` (or Caddy) terminating HTTPS and proxying to `127.0.0.1:7788`; the hub accepting a configured hostname | **Do this first.** No new infrastructure, the hub keeps its loopback bind, and it is exactly what SECURITY.md already recommends for reaching a remote hub. HTTPS comes for free from Tailscale's certificates, and HTTPS is required for a home-screen web app and for push. |
| B. In-app SSH tunnel (like the desktop) | An SSH client inside the mobile app, a key per phone in `authorized_keys`, sshd on the hub machine | Works for a VPS, not for "This PC" behind a home router without opening a port. Heavy key UX on a phone. Not for v1. |
| C. Relay through the optional PocketRocket account | A hosted relay the hub dials out to, end-to-end encryption keyed at pairing, APNs/FCM push | Zero network setup and store-grade push, but it is a service to run and pay for. This is the paid-plan story; phase 3. |

With option A the path looks like this:

```text
phone ──HTTPS (WireGuard underneath)──▶ tailscale serve on alex-pc ──HTTP──▶ hub 127.0.0.1:7788
                                        (TLS, Host: alex-pc.tail1a2b.ts.net)
```

The hub needs to learn one thing: that `alex-pc.tail1a2b.ts.net` is an allowed `Host`/`Origin`.
Everything else stays as it is. A user without Tailscale can put any reverse proxy with TLS in front
and allow that hostname instead; the setting is generic.

Server mode ([docs/SERVER.md](SERVER.md)) is the natural partner for mobile: the hub is always on,
routines fire while the laptop is closed, and the phone can answer approvals from anywhere. A
"This PC" hub works too, but only while the PC is awake.

## Delivery: web app first, native shell second

The mobile UI is the **same React app** in `packages/web`, with a phone layout. It is delivered
two ways, in this order:

1. **Home-screen web app (PWA).** The hub already serves the UI. Add a manifest, a service worker
   and a phone layout, and the URL from the pairing code installs as an app on iOS and Android.
   Push notifications work through the Web Push standard, and the hub is the sender (it holds the
   VAPID key pair); no relay involved. iOS supports this for home-screen apps since 16.4.
2. **Native shell (`packages/mobile`, Tauri 2 for iOS and Android).** The repo already uses Tauri 2
   and the icon set for both platforms is already generated under `packages/desktop/src-tauri/icons`.
   The shell loads the same UI from the hub the way the desktop shell does, and adds what a web app
   cannot: a camera QR scanner for pairing, the device key in Keychain/Keystore, Face ID/fingerprint
   lock, haptics, and an App Store/Play listing. Push in the native shell needs APNs/FCM, which
   needs a sender holding Apple's and Google's keys, which is the phase-3 relay.

Why not React Native or Flutter: it would be a second UI to keep in step with the desktop one, and
the current UI already adapts to narrow windows (drawers below `md`, dialogs capped at phone width).
The phone layout is a continuation of that work, not a rewrite.

## Design direction

The phone uses the existing design system unchanged, from `packages/web/src/index.css` and
`components/ui.tsx`:

- **Tokens**: the same canvas (`--bg #f7f7f8`) with its two faint washes, floating white panels
  with 20 px radius and the two shadows, `--card2` soft fills, hairlines only where needed, one
  accent (`--accent`) for links, focus and the thinking ring, `--ok`/`--warn`/`--bad` for state.
  Dark mode swaps the same names. Geist and Geist Mono.
- **Primary actions are black pills** (`--ink` on `--ink-fg`), secondary are `--card2` pills,
  destructive are `--bad` at 10% with `--bad` text. Same `Button` variants, same sizes, but every
  tappable thing is at least 44 px tall.
- **Bot state rings** on avatars, unchanged: pulse for thinking, spinning arc for working, amber
  pulse for blocked, green for done, red for error. On the chats list they are the "presence" of a
  messenger.
- **Trace chips** (mono, pill, icon + verb + target, green check when done, shimmer while
  running) survive as they are; they wrap onto more lines on a phone.
- **Approval cards** keep the same anatomy (shield, "Needs your OK", tool name, reason, mono
  block, three decisions), with the buttons stacked full width and a `--bad` ring for risky ones.
- **Motion**: the same three effects only (ring pulse, ring spin, chip shimmer), all off under
  `prefers-reduced-motion`. Sheets slide up; nothing else animates.
- **Sounds**: the same WebAudio cues. On iOS a home-screen app follows the ring/silent switch,
  Settings says so.

What changes is the layout, not the look. The desktop's three columns (sidebar · chat · right
panel) become a navigation stack:

```text
Chats (was: sidebar)  ──tap a row──▶  Room (was: chat pane)  ──tap the bot──▶  Bot sheet (was: right panel)
        ▲                                     │
        └────────── floating tab bar ─────────┘   Chats · Approvals · Team · Settings
```

- The left drawer becomes the home screen; the right drawer becomes a bottom sheet.
- The composer stays the floating pill, pinned above the keyboard, inside the safe area. The
  textarea is 16 px so iOS does not zoom the page on focus.
- A floating pill tab bar replaces the sidebar footer (Usage · Settings · theme).
- Toasts are the same black pills, but stack above the tab bar, not in a corner.
- "New messages" and "Approval waiting" jump pills are unchanged.

## Screen by screen

Numbered as on the canvas.

1. **Pair this phone.** The desktop connection card, one column. Two choices drawn as radio cards:
   scan a pairing code (default) or type the hub address plus the six-digit code. The note under
   the card says the three things a user must know: the hub is never on the internet, the phone and
   the hub share a private network, the code expires in two minutes and the phone gets its own
   revocable key.
2. **Chats.** Header with the rocket mark, "N working" and a + for a new bot or group chat. The
   provider chip (`● Claude · Sonnet 5 · alex-pc`) opens Settings. Sections **Bots** and **Group
   chats**, rows of 66 px: avatar with state ring, name, time, one line of status or the last
   message, an unread pill (`--ink`, or `--warn` when the unread thing is an approval).
3. **DM, bot working.** Header: back, avatar with ring, name, "Working · Run pnpm test · ≈$0.41",
   a button for the bot sheet. Transcript exactly as on desktop: user bubbles right, bot messages
   with avatar and name, trace chips, the streaming "typing" block with a caret. Composer with the
   red stop square while a turn is running.
4. **Group chat.** Header shows `# name`, the coordinator badge, the member handles, stacked
   member avatars with their rings. Shows a handoff card and a pending approval card inline.
5. **Approval sheet.** Tapping an approval card, or a notification, opens it as a sheet over the
   room: who, where, minutes left, the tool chip, the reason, the command in mono with a red inset
   ring when risky, then **Allow once** (black), **Allow for this session**, **Deny**, each 50 px.
   The footer states the 10-minute timeout, which is what the hub already does.
6. **Approvals tab.** Every pending approval across every room, newest first, each with
   Review/Allow/Deny inline, then a **Recent** list of decisions with their outcome. This is the
   screen a push notification lands on when there is more than one waiting.
7. **Bot sheet.** The right panel as a sheet: avatar, name, "title · model · budget", the same
   segmented control (Memory · Skills · Routines · Usage), the Memory tab with its 8 KB counter,
   **Reset room session** and **Save**.
8. **Settings (this phone).** Connection (hub name and status, address, paired-as, Face ID lock,
   **Forget this phone**), Notifications (approval requests, replies while closed, routine runs,
   show message text: off by default), Appearance (System/Light/Dark segmented, sounds), version.
9. and 10. **Dark** versions of Chats and the DM, produced by the same token swap as the desktop.

## Hub changes

All small, all in `packages/hub`, none touching the loopback bind.

### 1. Allowed hosts (`config.ts`, `api/guard.ts`)

- New setting `mobile.hosts: string[]` (settings table, and `POCKETROCKET_ALLOWED_HOSTS` as a
  comma-separated env override for server operators). Empty by default, so nothing changes for
  existing installs.
- `checkRequestOrigin` accepts a `Host` that is loopback **or** in the list, and an `Origin` whose
  hostname is loopback **or** in the list. The list is exact hostnames, never wildcards, never IPs
  that are not private (`100.64.0.0/10`, `10/8`, `172.16/12`, `192.168/16`, `fd00::/8`), and the
  hub logs a warning at start for each entry it accepted.
- Native shells send `tauri://localhost` (iOS) or `http://tauri.localhost` (Android) as `Origin`;
  those two are accepted only when a device token, not the hub token, authenticates the request.

### 2. Device tokens and pairing (`db/schema.ts`, `services/DeviceService.ts`, `api/rest.ts`)

- Table `devices(id, name, tokenHash, createdAt, lastSeenAt, lastIp, pushSubscription JSON NULL,
  notify JSON)`. Tokens are 32 random bytes, stored as SHA-256, compared with `tokenMatches` after
  hashing.
- `POST /api/devices/pair` (hub token only, from the desktop UI) → `{ code, url, expiresAt }`. The
  code is six digits, single use, two minutes, one outstanding at a time. `url` is
  `https://<first allowed host>/#pair=<code>`, which is what the QR encodes.
- `POST /api/devices/redeem { code, name }` (no token; rate-limited by the existing
  `AuthRateLimiter`, so ten wrong codes lock the IP for a minute) → `{ deviceId, token }`. Refused
  when no allowed host is configured, because then there is nothing for a phone to connect to.
- `checkToken` accepts a device token wherever it accepts the hub token, except `/api/settings`
  writes of `mobile.*`, `/api/secrets`, `/api/providers/*/check`, `/api/devices/pair` and
  `DELETE /api/devices/:id`, which stay hub-token only. A device can only forget itself
  (`POST /api/devices/me/forget`).
- `GET /api/devices` and `DELETE /api/devices/:id` for Settings → Mobile on the desktop.
- Every WS `hello` to a device connection carries `device: { id, name }` so the UI can label itself.

### 3. Push (`services/PushService.ts`)

- On first use the hub mints a VAPID key pair into `<data>/vapid.json` (owner-only, like
  `secrets.json`). `web-push` is the one new dependency.
- `PUT /api/devices/me/push-subscription` stores the browser's subscription; `PUT
  /api/devices/me/notify` stores the four toggles from Settings.
- Sent on: `approval.request` (always, unless the device's own socket is open on that room);
  `message.new` from a bot when the device has no open socket (one per room, collapsed by `tag`);
  `turn.end` with an error; `routine.fired` when enabled. Payload by default is only
  `{ kind, roomId, roomName, botName, approvalId? }`; message text is included only when the device
  opted in. Expired or rejected subscriptions (410) are deleted.
- Outbound calls grow by one class: the push endpoints (Apple's and Google's for Web Push). It is
  opt-in per device and documented in SECURITY.md's outbound list.

### 4. Approval inbox

- `GET /api/approvals?status=pending` and `?status=recent&limit=50` over the existing approval
  messages, so the Approvals tab does not need every room loaded. `approval.request` and
  `approval.resolved` already exist on the socket for live updates.

### 5. Deep links

- `GET /` keeps serving the shell; the web client learns `#room=<id>` and `#approval=<id>`
  fragments (handled next to `#token=` in `lib/auth.ts`) so a notification opens the right room.

## Web UI changes

All in `packages/web`.

- **Layout mode.** `useLayout()` returns `'phone'` below 640 px on a coarse pointer, else the
  current behaviour. `App.tsx` renders `<PhoneShell>` in phone mode: a navigation stack
  (`chats` → `room` → optional sheet) held in the store next to `activeRoomId`, with browser
  history entries so the hardware back button and the swipe-back gesture work.
- **New components** (`components/phone/`): `ChatsScreen` (reuses `useBotGroups`, `Avatar`,
  `STATE_LABEL`), `RoomScreen` (reuses `Transcript`, `Composer`, `ApprovalCard`, `Trace` from
  `ChatPane.tsx`, which get exported), `ApprovalSheet`, `ApprovalsScreen`, `BotSheet` (wraps the
  `RightPanel` tabs), `PhoneSettings`, `TabBar`, `Sheet` (a bottom sheet built on the existing
  Radix `DialogShell`, so focus trapping and Escape keep working), `PairScreen`.
- **Composer**: `visualViewport` listener so the pill sits above the keyboard on iOS; 16 px text;
  `enterkeyhint="send"`; Enter inserts a newline on phones, the send button sends.
- **Token storage**: device tokens persist in `localStorage` under `pocketrocket.device`, unlike
  the session-only hub token. The pairing flow (`#pair=`) redeems the code, stores the device
  token, then offers "Add to Home Screen" with per-platform instructions.
- **PWA**: `public/manifest.webmanifest` (name, `display: standalone`, theme colours from the
  tokens, icons from the existing set), `sw.ts` that only handles `push` and `notificationclick`
  (no offline caching of the shell, so a new hub build is always picked up, matching the hub's
  `no-store` on `index.html`), `apple-mobile-web-app-*` meta tags, `viewport-fit=cover` and
  `env(safe-area-inset-*)` padding.
- **Reconnect**: when the app returns to the foreground, `reconnectWsNow()` immediately, then
  `refresh()`; iOS suspends sockets in the background within seconds, and push covers that gap.
- **Sounds and haptics**: `navigator.vibrate` on approval requests where available; the native
  shell swaps in its haptics plugin.
- **Desktop additions**: Settings → **Mobile** section: the allowed-hosts field with a
  "Detect Tailscale" helper (reads `tailscale status --json` through the hub, offers the hostname
  and the `tailscale serve --bg 7788` command), a **Pair a phone** button that shows the QR and the
  six-digit code with a two-minute countdown, and the list of paired phones with last-seen and
  **Revoke**.

## Native shell (`packages/mobile`)

Tauri 2, iOS and Android, one Rust crate reusing `ssh.rs`-style validation code from the desktop
where it applies. Scope for its first release:

- Loads the hub URL like the desktop does, with the device token from Keychain/Keystore
  (`tauri-plugin-stronghold` or the keyring plugin), presented to the UI the way the desktop does
  today (`#token=` on the navigation, moved to `sessionStorage` at once).
- Pairing: `tauri-plugin-barcode-scanner` for the QR; the `pocketrocket://pair?...` deep link as
  a fallback so the code can also arrive by message.
- Biometric lock (`tauri-plugin-biometric`), haptics, native share sheet for files bots produce.
- Local notifications from the socket while the app is running; background push waits for phase 3.
- Release: TestFlight and Play internal testing first; unsigned builds are not an option on
  mobile, so signing happens here before it happens on Windows.

## Security

Additions to the model in [SECURITY.md](../SECURITY.md), to be written there when this ships:

- The hub still never binds a non-loopback address. Reachability comes from a TLS proxy inside a
  private network; the hub only widens its `Host`/`Origin` allowlist, by exact name, for names the
  user typed.
- Device tokens are per phone, hashed at rest, revocable from the desktop, and cannot change
  settings that widen what bots may do, cannot read or set API keys, and cannot pair further
  devices. A stolen phone is handled by **Revoke** on the desktop; a locked phone is handled by
  the biometric lock in the native shell.
- The pairing code is short-lived and single use, rate-limited by the existing brute-force brake,
  and only redeemable through the allowed host, so it is never valid from the open internet.
- Push payloads carry identifiers, not content, unless the user opts in per device. Push endpoints
  are the only new outbound destination.
- Approvals from a phone are the same approvals: they resolve through the same
  `PermissionBroker`, with the same 10-minute timeout. Nothing about what bots may do changes.

## Phases

| Phase | Scope | Size |
|---|---|---|
| **0. Phone layout** | `useLayout`, `PhoneShell`, the screens above on the existing store, PWA manifest and meta, allowed hosts on the hub, desktop Settings → Mobile with the Tailscale helper | ~1 week |
| **1. Pairing and push** | Device tokens, pairing QR, redeem flow, Web Push from the hub, Approvals tab and its endpoints, notification deep links | ~1–2 weeks |
| **2. Native shell** | `packages/mobile` on Tauri 2, QR scanner, keychain, biometrics, TestFlight and Play internal builds, CI job | ~2–3 weeks, plus store accounts |
| **3. Relay** | Hosted relay behind the PocketRocket account, E2E-encrypted, APNs/FCM push, zero network setup | unscheduled; the paid-plan track |

Phase 0 alone already gives a usable phone client for anyone who runs Tailscale. Each phase is
shippable on its own and lands behind the same `CHANGELOG.md` and CI as everything else.

Acceptance for phase 1: on a fresh phone, scan the code from Settings → Mobile, land in Chats, add
to the home screen, lock the phone, have a bot hit an approval on the desktop, get a notification,
tap it, land on the approval sheet, allow it, see the bot continue on the desktop. Then revoke the
phone from the desktop and confirm it is signed out on the next request.

## Open questions and risks

- **Tailscale is a VPN profile on the phone**, and iOS runs one VPN at a time. Anyone on a
  corporate VPN would need to switch; the relay in phase 3 is the answer for them.
- **iOS home-screen push** needs iOS 16.4+ and the app added to the home screen; Safari alone gets
  no push. The pairing flow ends on the "Add to Home Screen" step for this reason.
- **Background sockets on iOS** are suspended within seconds, so state on return relies on
  `refresh()`, and approvals rely on push, never on the socket alone.
- **`tailscale serve` is one command but still a command.** The Settings → Mobile helper reduces
  it to a copy button; a future desktop release could run it for the user.
- **Emoji avatars** are the product's own avatar system and stay as they are on the phone.
- **Multiple hubs** (a PC and a VPS) are not covered by v1; the phone pairs with one hub. Switching
  is "forget, then pair again".
- **Bot state in the chats list** depends on `bot.state` and the latest tool message, which the
  store already tracks, but only for rooms it has loaded. The chats list needs a small
  `GET /api/rooms/summary` (last message per room) so previews are right before a room is opened.
