# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Multi-provider hub: bots can run on Claude, OpenAI Codex, OpenCode, or Grok, chosen globally with a model picked per bot.
- Desktop app (Windows) that bundles its own Node runtime, so it runs without a system Node install.
- Sound cues (send, reply, approval request, approve/deny, turn done/error, desktop connected), on by default, respecting `prefers-reduced-motion`.
- First-run onboarding wizard: pick a provider, detect its CLI and login, name yourself, create a first bot.
- Settings dialog: provider selection with live install/login checks, default model, API key fields, sounds toggle, theme.
- Landing site (`packages/site`), live at <https://pocketrocket-chi.vercel.app>, with real screenshots of the app in the hero.

### Changed

- Renamed the project from Claudebot to **PocketRocket** across packages, env vars, data paths, systemd units, and the desktop app identifier.
- Permission enforcement generalized per provider: full hook-based interception for Claude, native permission API for OpenCode, best-effort workspace sandbox + `request_approval` tool for Codex and Grok.
- Much smaller download: the hub bundle went from 271 MB to 62 MB (Windows installer ~30 MB) by dropping the Claude Agent SDK's vendored copy of the Claude CLI, which PocketRocket never runs — it always drives your own `claude.exe`.
- The installed executable is `PocketRocket.exe` (it was `pocketrocket-desktop.exe`); the Start menu and desktop shortcuts were already named PocketRocket.

### Fixed

- Quitting the hub with Ctrl+C while OpenCode was the active provider hung for eight seconds and left an `opencode serve` process running in the background. It now shuts down in about a second with nothing left behind.
- The bundled hub reported version 0.1.0 whatever the real version was, and could not find the Browser tool's Playwright CLI, because it looked for its own files in the source layout rather than the installed one.
- The desktop app always ran the hub on its own bundled Node and reported it as "system node", because Windows resolves a bare `node` to the copy sitting next to the app before looking at your PATH. If you have Node 22.13+ installed, the app now uses it, as documented.

## [0.1.0]

- Initial internal version (Claudebot): Claude-only hub, DMs and group chats, memory, skills, routines, VPS deploy scripts with a shared virtual desktop.
