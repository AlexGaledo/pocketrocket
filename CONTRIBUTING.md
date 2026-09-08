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

## Provider adapters

**Open an issue first** before starting work on a new or changed provider adapter (`packages/hub/src/providers/*`) — the adapter interface and permission model are still settling, and duplicate or conflicting work is easy to avoid with a quick heads-up.

## Pull requests

- Run `pnpm test` and `pnpm build` before opening a PR.
- Describe what changed and why, not just what.
- Keep the diff scoped to one concern.
