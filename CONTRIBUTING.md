# Contributing to PocketRocket

## Setup

```bash
pnpm install
pnpm dev      # hub (tsx watch) + Vite UI at http://127.0.0.1:5173
pnpm test     # vitest, run before every PR
```

Node ≥ 22.13 and pnpm are required (see the root [README](./README.md#install)).

## Where things live

```text
packages/shared     zod models + WS/REST schemas shared by hub and web
packages/hub         Node hub: db/, agent/, providers/, rooms/, permissions/, services/, api/
packages/web         Vite + React + Tailwind + Zustand UI
packages/desktop     Tauri desktop shell (Rust + WebView2)
packages/site        static landing page
scripts/             deploy.sh, smoke.mjs, group-smoke.mjs
deploy/              VPS provisioning scripts (systemd units, screen setup)
```

## Commit style

Short, imperative subject line ("fix approval card race", not "fixed" or "fixes"). Reference the area when useful (`hub:`, `web:`, `site:`, `desktop:`). Keep unrelated changes out of a commit.

## Providers

v1 ships **Claude only** — the Claude Agent SDK, driving your own Claude Code CLI and subscription
login, or an `ANTHROPIC_API_KEY`. Adapters for OpenAI Codex, OpenCode and Grok exist in
`packages/hub/src/providers/` but are not offered as a user-facing option; they sit behind a
dev-only flag, `POCKETROCKET_PROVIDERS`, meant for local development and testing, not for end
users. Don't document or promote them outside dev docs like this one.

**Open an issue first** before starting work on a new or changed provider adapter
(`packages/hub/src/providers/*`) — the adapter interface and permission model are still settling,
and duplicate or conflicting work is easy to avoid with a quick heads-up.

## Pull requests

- Run `pnpm test` and `pnpm build` before opening a PR.
- Describe what changed and why, not just what.
- Keep the diff scoped to one concern.
