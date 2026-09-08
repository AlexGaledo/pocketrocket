# Security policy

## Reporting a vulnerability

Please report security issues via [GitHub private security advisories](https://github.com/AlexGaledo/pocketrocket/security/advisories/new) rather than a public issue. We'll respond as soon as we can.

## How PocketRocket is designed to be safe

- The hub binds to `127.0.0.1` only, on every platform and in every run mode (local, VPS, screen). It is never meant to be reachable from another host directly.
- **Never expose the hub's port (default `7788`) to the internet or a LAN.** Reach a remote hub over an SSH tunnel or a private overlay network (e.g. Tailscale) instead.
- The hub always requires a bearer token — there is no unauthenticated mode. `POCKETROCKET_TOKEN` wins when set; otherwise a fresh token is minted on every start, written to `<data>/hub-token` (0600), and printed at startup as `http://127.0.0.1:7788/#token=…`. The desktop app and web UI both pick the token up from that URL fragment automatically; `pnpm start` users read it from the printed line or the file.
- REST/WS requests with an `Origin` header that isn't `http://127.0.0.1:<port>` or `http://localhost:<port>` are rejected — including `Origin: null` (e.g. a sandboxed iframe) — to block CSRF from arbitrary sites and DNS-rebinding attacks. `/screen/*` (the noVNC desktop bridge) requires the same token as every other route.
- Provider credentials (CLI subscription logins, API keys) stay wherever the provider's own CLI stores them, or in `data/secrets.json` for keys PocketRocket manages directly; neither is transmitted anywhere except to that provider.
- The hub does not phone home. It talks to your provider (Claude, OpenAI, OpenCode's configured backends, or xAI) and nothing else.
- Bot management actions that widen what a bot can do (creating/editing a bot, changing its tool grants) show an approval card for a human to confirm, the same way a risky tool call does.

## Threat model

The workspace sandbox (path/bash rules) and the approval cards are built to catch a **cooperative model making an honest mistake** — a bot that wanders outside its workspace by accident, or runs a command it shouldn't because it didn't think it through. They are not a security boundary against a **hostile model**: one that has been prompt-injected by content it read (a fetched page, a file, another bot's message) or is otherwise deliberately trying to escape.

A sufficiently motivated or injected bot can still find gaps, including but not limited to:

- **Interpreters it's allowed to run** (`node`, `python`, `bun`, etc.) can execute arbitrary code that never goes through the bash/path rules at all.
- **Relative paths and path tricks** (`../`, junctions, not-yet-existing files) can land outside the intended workspace even when the rules look right on paper.
- **Symlinks** created inside the workspace can point anywhere the hub process can reach.
- **External CLIs bring their own sandboxing** (or lack of it) — a provider's CLI, an MCP server, or a tool it shells out to may not respect PocketRocket's rules at all.

Treat every bot — including one running a "trusted" model — like **a junior contractor who has a shell on your machine**: give it the least access it needs, review what it's about to do, and assume that anything it reads (web pages, files, other bots' messages) could be an attempt to redirect it.

**Never grant the Browser or Desktop tools to a bot that reads untrusted content** (web pages, emails, files from someone else, other bots' output). Those tools give it a real GUI session — enough to exfiltrate data, click through prompts, or drive whatever is logged into that session.

## Scope

This covers the hub, web UI, desktop app, and the deploy/screen scripts in this repository. Vulnerabilities in a provider's own CLI or service are out of scope here — report those upstream.
