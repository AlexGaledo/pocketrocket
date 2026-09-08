# Research: Grok Build CLI for the P2C adapter (2026-09-08)

Verified against the real binary: `grok 1.0.13 (5e9a58528b76)`, downloaded to a scratch dir from
`https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.13-windows-x86_64.exe`
(the public artifact the installer at <https://x.ai/cli/install.ps1> pulls; auth is optional for the
download, `GROK_BIN_DIR` picks the target). **Not installed on Alex's machine** — `where grok` is empty.
The binary unpacks its own docs into `$GROK_HOME/docs/user-guide/*.md`; everything below is from
`grok --help`, those files, and <https://docs.x.ai/build/overview>.

## Decision: **CLI path**

`grok -p` has structured output, MCP over streamable HTTP with custom headers, session resume, model
selection, tool gating and a config-dir env var. No reason to take the API fallback, so no `ai` /
`@ai-sdk/xai` dependency was added.

## Flags used (`grok --help`, `14-headless-mode.md`)

| Need | Flag |
| --- | --- |
| headless | `-p, --single <PROMPT>` (exit 0 ok, 1 error, 130 SIGINT, 143 SIGTERM) |
| structured output | `--output-format streaming-json` — NDJSON, one `type`-tagged object per line. Also `plain`, `json`, `streaming-messages-json` (Anthropic Messages wire format) |
| resume | `-r, --resume <ID>`; `-c, --continue`; `-s, --session-id <UUID>` creates only. `sessionId` comes back on the `end` event |
| model | `-m, --model` |
| cwd | `--cwd` |
| system prompt | `--rules <TEXT>` appends to the system prompt (`--system-prompt-override` *replaces* it and would drop grok's tool instructions) |
| approvals | `--always-approve` (alias `--yolo`, = `--permission-mode bypassPermissions`); `--allow`/`--deny` rules still apply on top |
| tool gating | `--deny "Bash"`, `"Read"`, `"Edit"`, `"Write"`, `"Grep"`, `"WebFetch"`, `"WebSearch"`, `"MCPTool"` — documented stable rule classes, `deny` > `ask` > `allow` and deny survives always-approve. (`--tools`/`--disallowed-tools` take *internal* ids like `read_file`, `run_terminal_cmd`, which the docs spell inconsistently — avoided.) |
| turn cap | `--max-turns <N>` |
| sandbox | `--sandbox off\|workspace\|devbox\|read-only\|strict` (`workspace` = writes limited to cwd + `~/.grok` + `/tmp`). Enforced via Seatbelt/Landlock; **no Windows FS sandbox**, so the adapter only passes it off-Windows |
| quiet | `--no-auto-update` + `GROK_DISABLE_AUTOUPDATER=1` (update chatter goes to stderr anyway) |

## MCP (`07-mcp-servers.md`)

`[mcp_servers.<name>]` in `$GROK_HOME/config.toml` supports stdio **and** streamable HTTP/SSE:

```toml
[mcp_servers.pocketrocket]
url = "${POCKETROCKET_MCP_URL}"
headers = { "Authorization" = "Bearer ${POCKETROCKET_MCP_TOKEN}" }
```

`${VAR}` / `${VAR:-default}` are expanded in `url`, `command`, `args`, `env` and `headers` **at load
time**, so the file is written once and the per-turn bearer token rides the child's env — no
per-turn rewrite, no race between concurrent turns. Tools appear to the model as `<server>__<tool>`
(no `mcp__` prefix). Results are truncated at 20 000 bytes (`GROK_MAX_MCP_OUTPUT_BYTES`).

## Config / auth (`26-config-reference.md`, `02-authentication.md`)

`GROK_HOME` (default `~/.grok`) holds config, `auth.json`, sessions, logs — so the adapter gets a
private home at `<DATA_DIR>/grok-home` and mirrors the user's `~/.grok/auth.json` into it when one
exists. Auth precedence: session token → cached OAuth (`grok login`, `--device-auth` for headless) →
`XAI_API_KEY` (keys from <https://console.x.ai>). Other vars read: `GROK_SANDBOX`,
`GROK_DEFAULT_MODEL`, `GROK_MCP_STARTUP_TIMEOUT_SECS`, `GROK_LOG_FILE`, `RUST_LOG`.

## `streaming-json` events

`{"type":"text","data":…}`, `thought`, `tool_call` (`toolCallId`,`toolName`,`kind`,`status`,`rawInput`),
`tool_call_update` (`status`,`rawOutput`,`content`), `usage` (per model response), `plan`,
`available_commands`, `error`, and a final `end` carrying `sessionId`, `stopReason`, `usage`,
`num_turns`, `modelUsage`, `total_cost_usd` (+ `_ticks`). Treat the list as non-exhaustive.
`usage.input_tokens` is **uncached only**; cache buckets are separate. `total_cost_usd` is omitted
(not zero) when cost is partial/unreported — it is stamped for API-key traffic, often absent on
OAuth/pool traffic, which is why `grok/pricing.ts` exists.

## Models and pricing (<https://docs.x.ai/docs/models>, `grok models`)

`grok models` works unauthenticated and prints `You are not authenticated.` plus a fallback list
(`grok-4.6` default, `grok-4.5`) — used for both the model list and auth detection.
Per 1M tokens, `<200k` context tier: **grok-4.6** $2 / $0.50 cached / $6 (500k ctx),
**grok-4.5** $2 / $0.30 / $6, **grok-4.3** $1.25 / $0.20 / $2.50 (1M ctx),
**grok-build-0.1** $1 / $0.20 / $2 (256k, the cheap coder). `grok-code-fast-1` and `grok-4-fast` are
gone from the docs list; kept as legacy rates only. Rates are approximate — the `≥200k` tier doubles
them and the adapter does not model that.

## Not taken (deliberately)

`PreToolUse` hooks accept an **HTTP** handler (`{"type":"http","url":…}`) and can return
`{"decision":"deny","reason":…}`; the binary's own log string `could not parse HTTP hook response
JSON, treating as allow` confirms the response body is parsed as the decision. A loopback hook
endpoint would give Grok real PocketRocket approval cards (`permissions: 'full'`). Out of scope for
P2C — the plan pins Grok at `best-effort`, and `registry.test.ts` asserts it. Worth a follow-up.

## Unverified

No xAI credentials on this machine, so nothing below was executed end to end: the exact
`streaming-json` line shapes (fixtures are transcribed from `14-headless-mode.md`), whether a
SuperGrok/X Premium subscription entitles the CLI's OAuth login (API keys are a separate purchase),
whether `grok models` lists more ids once authenticated, and MCP handshake behaviour against the
hub's `/mcp` endpoint.

## Sources

- `grok --help`, `grok mcp add --help`, `grok models` (v1.0.13)
- `$GROK_HOME/docs/user-guide/{14-headless-mode,07-mcp-servers,10-hooks,22-permissions-and-safety,18-sandbox,17-sessions,02-authentication,26-config-reference}.md`
- <https://docs.x.ai/build/overview>, <https://docs.x.ai/build/cli/reference>,
  <https://docs.x.ai/build/cli/headless-scripting>, <https://docs.x.ai/build/features/mcp-servers>,
  <https://docs.x.ai/build/features/permissions>, <https://docs.x.ai/build/settings/reference>,
  <https://docs.x.ai/docs/models>, <https://x.ai/cli/install.ps1>
