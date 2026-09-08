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
- Landing site (`packages/site`).

### Changed

- Renamed the project from Claudebot to **PocketRocket** across packages, env vars, data paths, systemd units, and the desktop app identifier.
- Permission enforcement generalized per provider: full hook-based interception for Claude, native permission API for OpenCode, best-effort workspace sandbox + `request_approval` tool for Codex and Grok.

## [0.1.0]

- Initial internal version (Claudebot): Claude-only hub, DMs and group chats, memory, skills, routines, VPS deploy scripts with a shared virtual desktop.
