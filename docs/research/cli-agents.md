# Research: Codex CLI and OpenCode CLI for headless use (2026-09-08)

Sub-agent research report, condensed. Verify flagged items empirically before relying on them.

## A. OpenAI Codex CLI (`@openai/codex`, 0.153.x)

- Headless: `codex exec [FLAGS] [PROMPT]` (`-` reads prompt from stdin). Reference: https://developers.openai.com/codex/cli/reference
- `--json`: JSONL events. Confirmed types: `thread.started {thread_id}`, `turn.started`, `turn.completed {usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}`, `turn.failed`, `item.started` / `item.completed` (item types: `agent_message`, `reasoning`, `command_execution`, file changes, MCP tool calls, web search, plan updates), `error`. https://learn.chatgpt.com/docs/non-interactive-mode
- Flags: `-C/--cd <dir>`, `-m/--model`, `-s/--sandbox read-only|workspace-write|danger-full-access`, `-a/--ask-for-approval untrusted|on-request|never`, `-o/--output-last-message <file>`, `--output-schema <json-schema>`, `-c key=value` config overrides (repeatable, dotted keys), `--full-auto` (deprecated; prefer `--sandbox workspace-write`), `--yolo` (no sandbox, avoid).
- Resume: `codex exec resume <SESSION_ID> [PROMPT]` (`--last`, `--all`). Session id = `thread_id` from `thread.started`.
- Auth: `codex login` (ChatGPT subscription OAuth), `codex login --with-api-key` (reads `OPENAI_API_KEY` from stdin), `codex login --device-auth`, `codex login status`. Store: `~/.codex/auth.json` or keyring. `CODEX_HOME` relocates config dir. No official `CODEX_API_KEY`.
- MCP: `~/.codex/config.toml` `[mcp_servers.<name>]` with either `command/args/env` (stdio) or `url = "..."` + `bearer_token_env_var = "VAR"` (Streamable HTTP). CLI: `codex mcp add <name> --url <url>`. Per-run injection via `-c mcp_servers.<name>.url=...` is plausible (generic dotted overrides) but NOT demonstrated officially: verify.
- Instructions: `AGENTS.md` discovery (home, then project root → cwd, 32 KiB cap). `model_instructions_file` REPLACES base instructions (avoid). For per-bot system prompts prefer prepending to the prompt text.
- Usage: token counts only, no cost field. Compute cost from a rate card.
- Windows: native support described as experimental in third-party sources; WSL2 more mature. Verify.

## B. OpenCode (`opencode-ai`, 1.17.x; repo github.com/anomalyco/opencode; docs opencode.ai/docs)

- Headless CLI: `opencode run [--format json] [-m provider/model] [-s <session>] [-c] [--agent] [--dir] [--attach <url>] [--auto] "<prompt>"`. JSONL types (third-party cheatsheet, verify): `step_start`, `text`, `tool_use {tool,state:{status,input,output}}`, `step_finish {reason,cost,tokens:{input,output,reasoning,cache:{read,write}}}`, `error`.
- Server mode (recommended for tight integration): `opencode serve --port <n> --hostname 127.0.0.1`; auth `OPENCODE_SERVER_PASSWORD`/`_USERNAME`. Endpoints: `POST /session`, `GET /session`, `POST /session/:id/message` (sync), `POST /session/:id/prompt_async`, `GET /event` (SSE; first event `server.connected`), `POST /session/:id/permissions/:permissionID {response, remember?}`. Permission asks surface on the SSE bus (`permission.asked`, verify exact string) and block until replied. SDK: `@opencode-ai/sdk` (~1.18.x, pin after checking npm). https://opencode.ai/docs/server/ https://opencode.ai/docs/sdk/
- Config merge: global `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` path → project `opencode.json` → `OPENCODE_CONFIG_CONTENT` env (inline JSON). Use `OPENCODE_CONFIG_CONTENT` to inject per-hub config without touching user files.
- MCP block: `{"mcp":{"name":{"type":"local","command":[...],"environment":{}},"remote":{"type":"remote","url":"...","headers":{"Authorization":"Bearer ..."}}}}` (verify `local` vs `stdio`). https://opencode.ai/docs/mcp-servers/
- Permission block keys: `read, edit, glob, grep, bash, task, skill, lsp, question, webfetch, websearch, external_directory, doom_loop` → `allow|ask|deny`; bash supports glob patterns. `external_directory` scopes filesystem access to the project root. https://opencode.ai/docs/permissions/
- `instructions: [paths]`, `agent: {name:{description,model,prompt,tools:{write:false}}}`.
- Providers/auth: OAuth subscription logins for ChatGPT Plus/Pro, GitHub Copilot, Claude Pro/Max, SuperGrok (`opencode auth login`); API keys for the rest. xAI: `XAI_API_KEY` or SuperGrok OAuth; model ids `xai/<model>` — resolve via `opencode models`, do not hardcode.
- Cost: per-step `cost` + tokens in `step_finish`; no aggregate endpoint.
- Windows: native builds exist; docs recommend WSL "for best experience".

## Open items to verify empirically

1. Codex `-c mcp_servers.x.url=` per-run injection.
2. OpenCode SSE permission event names and reply payload.
3. OpenCode MCP `type` value.
4. Current xAI model slugs in OpenCode (`opencode models`).
