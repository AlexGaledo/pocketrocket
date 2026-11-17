# OpenBot recon (2026-11-17)

Source: public pages of https://openbot.run (home, pricing, download, launch post, changelog 0.72.0 only)
and the README of https://github.com/nightly-labs/openbot. Raw HTML, older changelog entries and
/teams, /providers, /marketplace pages were not read.

## Ground rules for this work (owner decisions, 2026-11-17)

- **Clean room: read source, never copy.** Agents may read OpenBot's code to understand behaviour.
  No OpenBot code, identifiers, strings, UI copy or assets go into PocketRocket. Write our own.
  OpenBot is **PolyForm Noncommercial 1.0.0** (Apache-2.0 up to 0.1.11, unverified); PocketRocket is MIT.
- **Commercial stance: free MIT tool for now, maybe paid later.** Check provider terms for personal
  use of the user's own logins, and flag anything that would block selling, hosting or team seats later.
- Plans go in `docs/specs/openbot-gaps/`. A summary page comes at the end.

## What OpenBot is

Electron desktop app (SolidJS renderer, Bun 1.4, Node 24, SQLite `openbot.db`, Biome, Vitest) by
Synthetify Labs (Poland). "Persistent AI teammates on your own computer. Run Codex, Claude, Gemini,
Grok, Muse Code, Pi or your own model with the plans you already pay for." Positions itself as a
local-first alternative to Grok Bot. 0.1.0 on 2026-08-13 to 0.72.0 on 2026-11-16 (126 releases).
8.4k stars. Free for personal or noncommercial use; hosted servers EUR 24-80/mo; team licence
EUR 7.20-18/seat/mo; enterprise on request.

## Features PocketRocket lacks (the gaps)

1. **Providers + failover.** Provider per agent; "Change the provider, keep the agent" (workspace and
   conversation kept). When a plan hits its limit or a provider is down, the agent moves to a backup
   model on another provider, with a note in chat. Providers: Codex (Codex App Server, stdio JSONL),
   Claude (Agent SDK), Gemini (Google Antigravity CLI, downloaded at runtime; OpenBot says Google's licence
   does not allow redistribution, which we have not verified against a licence text), Grok CLI, OpenCode, Cursor (`cursor-agent acp`), Cline (`cline --acp`),
   Kimi (`kimi acp`), Devin (`devin acp`), Copilot (`copilot --acp`), Mistral (`vibe-acp`), Hermes
   (`hermes acp`), any ACP agent (Goose, Qwen Code), OpenAI-compatible endpoints, Ollama, LM Studio.
   CLIs downloaded and version-pinned by the app; `OPENBOT_*_PATH` overrides; "uses the existing local
   CLI login, does not copy provider credentials"; API keys encrypted on device. Pooled accounts and
   "add account with code". Per-agent context monitor with auto compaction. Proxy env
   (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`).
2. **Steering + workflows.** "Steer" busy-message mode: a message sent mid-turn redirects the agent
   (Claude, Codex, OpenCode, Devin, ACP). FIFO queue with pause/resume/cancel, crash-safe.
   Workflows canvas: trigger (e.g. Monday 09:00) -> agent steps -> Approval step -> post. Image and
   video steps via Higgsfield models.
3. **Chat channels.** WhatsApp linked number (messages of allowed chats kept 90 days locally, status
   reactions). Discord: agents read channels. Slack dev setup. No Telegram seen.
4. **Distribution + money.** Signed Windows (Synthetify), notarized macOS DMG, Linux AppImage
   (AppArmor profile needed on Ubuntu 23.10+), native iOS and Android apps that connect to a host,
   web client, Docker (GHCR, amd64/arm64, seccomp), Nix flake, Umbrel store, AWS ECS guide,
   `curl | sudo bash` server install. Multiplayer: humans and agents in shared channels, team API over
   WebRTC, accounts via Cloudflare Workers + D1 + R2 (one-time email codes). Hosted server plans.
   Also: experimental CRM (agents propose, human approves; read-only Stripe), voice conversation,
   backdrops, theme JSON, in-app bug reports with redaction.

Security posture: agents run `danger-full-access` / `approvalPolicy: never` after first-launch consent;
"Ask first" vs "Full access" modes.

## PocketRocket today (origin/main, 2026-11-16)

Hub: Node, SQLite (`node:sqlite`), REST + WS, React UI, Tauri/WebView2 Windows shell (NSIS, unsigned,
no updater), server mode on Linux over SSH tunnel. Claude Agent SDK is the only user-facing provider;
Codex, OpenCode, Grok adapters exist in `packages/hub/src/providers/` behind `POCKETROCKET_PROVIDERS`,
marked `maturity: 'untested'` (owner has no Codex or Grok account). Provider is a **global** setting,
model per bot; Auto model router (`agent/ModelRouter.ts`). Interrupt exists (`BotRunner.interrupt`),
no steering. Routines + triggers (GitHub, Gmail, Slack), integrations (GitHub, Google, Slack incl.
Socket Mode, ClickUp, Teams), per-bot computers on the server, teach-by-demo, skill versions, training
loops, PWA + Web Push + phone pairing, Needs-you inbox, forms in chat, project folders, approval rules,
optional Supabase account (`profiles.plan`, nothing behind it). Single owner per hub. See
`docs/specs/grok-bot-parity.md` for the previous parity work and `docs/specs/decisions.md`.
