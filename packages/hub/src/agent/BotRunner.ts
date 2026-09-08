import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { isInside, pathsFromInput } from '../permissions/pathRules.js';
import type { Bot, BotState, Room, ToolPayload } from '@claudebot/shared';
import { CDP_URL, CLAUDE_EXE, DESKTOP_AVAILABLE, MAX_TURNS_PER_QUERY, PLAYWRIGHT_MCP_CLI, WORKSPACE_DIR, botHome } from '../config.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from '../services/MemoryService.js';
import type { SkillService } from '../services/SkillService.js';
import type { UsageTracker } from '../services/UsageTracker.js';
import type { PermissionBroker } from '../permissions/PermissionBroker.js';
import { buildSystemPrompt } from './PromptBuilder.js';
import { createBotToolServer } from './botTools.js';

export interface TurnRequest {
  bot: Bot;
  room: Room;
  members: Bot[];
  hop: number;
  causeId: string;
  injected: string;
}
export interface TurnResult {
  ok: boolean;
  turnId: string;
  finalText: string;
  costUsd: number;
  error?: string;
}
export interface RunnerHooks {
  /** Route mentions produced mid-turn (send_message / handoff tools). Returns handles dispatched. */
  dispatchFromBot: (req: TurnRequest, targets: Bot[]) => string[];
  setState: (botId: string, roomId: string, state: BotState, note?: string) => void;
}

// Only these may be pre-approved via allowedTools. A bare allowedTools entry auto-approves the tool
// EVERYWHERE and bypasses canUseTool, so file/shell tools must never appear there: reads inside
// cwd/additionalDirectories are already free, edits inside are covered by acceptEdits, and anything
// outside (plus every Bash call) then falls through to the PermissionBroker.
const AUTO_OK = new Set(['WebSearch', 'WebFetch']);
const ALL_BUILTINS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit'];

export class BotRunner {
  private active = new Map<string, Query>();
  lastInit: { apiKeySource?: string; model?: string; version?: string; tools?: string[]; skills?: string[] } = {};

  constructor(
    private repos: Repos,
    private memory: MemoryService,
    private skills: SkillService,
    private broker: PermissionBroker,
    private usage: UsageTracker,
    private hooks: RunnerHooks,
  ) {}

  interrupt(turnId: string) {
    const q = this.active.get(turnId);
    if (!q) return false;
    void q.interrupt().catch(() => undefined);
    return true;
  }
  isActive(turnId: string) {
    return this.active.has(turnId);
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const { bot, room } = req;
    const turnId = nanoid(10);
    const session = this.repos.getSession(bot.id, room.id);
    this.memory.ensureHome(bot.id);
    const memoryText = this.memory.read(bot.id);
    const identity = this.memory.readIdentity(bot.id) || bot.description;
    const pluginDir = this.skills.materialize(bot.id, bot.handle);
    const setState = (s: BotState, note?: string) => this.hooks.setState(bot.id, room.id, s, note);

    const desktopOn = bot.allowedTools.includes('Desktop') && DESKTOP_AVAILABLE;
    const toolServer = createBotToolServer({
      bot, room, members: req.members, turnId, hop: req.hop, causeId: req.causeId,
      repos: this.repos, memory: this.memory, skills: this.skills,
      dispatchFromBot: (targets) => this.hooks.dispatchFromBot(req, targets),
      setState: (s) => setState(s),
      desktop: desktopOn,
    });

    const allowed = bot.allowedTools.filter((t) => AUTO_OK.has(t));
    const disallowed = ALL_BUILTINS.filter((t) => !bot.allowedTools.includes(t));
    // "Browser" = Playwright MCP attached over CDP to the Chromium on the screen (shared, logged-in profile).
    const browserOn = bot.allowedTools.includes('Browser') && fs.existsSync(PLAYWRIGHT_MCP_CLI);
    const mcpServers: NonNullable<Options['mcpServers']> = { claudebot: toolServer };
    if (browserOn) mcpServers.browser = { type: 'stdio', command: process.execPath, args: [PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', CDP_URL, '--caps', 'vision'] };

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => (resolveDone = r));
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: req.injected }, parent_tool_use_id: null };
      await done;
    }

    const options: Options = {
      pathToClaudeCodeExecutable: CLAUDE_EXE,
      spawnClaudeCodeProcess: (o) => spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as never,
      cwd: WORKSPACE_DIR,
      additionalDirectories: [botHome(bot.id)],
      resume: session.sdkSessionId ?? undefined,
      model: bot.model,
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: buildSystemPrompt({ bot, room, members: req.members, hop: req.hop, memory: memoryText, identity, browser: browserOn, desktop: desktopOn }),
      },
      settingSources: [],
      plugins: pluginDir ? [{ type: 'local', path: pluginDir }] : undefined,
      skills: pluginDir ? 'all' : [],
      permissionMode: 'acceptEdits',
      // Availability: only the bot's built-ins (+ Skill when a plugin is attached) exist in context.
      // Keeps Task/cron/plan-mode etc. out of the prompt and trims the cached system prompt.
      tools: [...bot.allowedTools.filter((t) => ALL_BUILTINS.includes(t)), ...(pluginDir ? ['Skill'] : [])],
      allowedTools: [...allowed, 'mcp__claudebot__*', ...(browserOn ? ['mcp__browser__*'] : [])],
      disallowedTools: disallowed,
      mcpServers,
      strictMcpConfig: true,
      canUseTool: (name, input, o) =>
        this.broker.decide({ bot, room, turnId, hop: req.hop, causeId: req.causeId, setState: (s) => setState(s) }, name, input, o),
      // Read/Glob/Grep never prompt in Claude Code, so canUseTool would never see them. This hook
      // escalates out-of-workspace paths to "ask", which routes them into canUseTool -> PermissionBroker.
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read|Glob|Grep|NotebookEdit',
            hooks: [
              async (input) => {
                const i = input as PreToolUseHookInput;
                const roots = [WORKSPACE_DIR, botHome(bot.id)];
                const paths = pathsFromInput(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>);
                const outside = paths.filter((p) => !isInside(p, roots, WORKSPACE_DIR));
                if (process.env.CLAUDEBOT_DEBUG) console.log('[hook PreToolUse]', i.tool_name, paths, outside.length ? 'ASK' : 'ok');
                if (!outside.length) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: i.tool_name + ' outside workspace: ' + outside.join(', '),
                  },
                };
              },
            ],
          },
        ],
      },
      includePartialMessages: true,
      maxTurns: MAX_TURNS_PER_QUERY,
      maxBudgetUsd: bot.maxBudgetUsd,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'claudebot/0.1' },
      stderr: (d) => { if (process.env.CLAUDEBOT_DEBUG) process.stderr.write('[claude ' + bot.handle + '] ' + d); },
    };

    events.emitEvent({ type: 'turn.start', turnId, botId: bot.id, roomId: room.id, causeId: req.causeId, hop: req.hop });
    setState('thinking');

    const texts: string[] = [];
    const toolMsgIds = new Map<string, string>();
    let costUsd = 0;
    let ok = false;
    let error: string | undefined;
    let lastMessageId: string | undefined;

    const q = query({ prompt: prompt(), options });
    this.active.set(turnId, q);
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'system' && m.subtype === 'init') {
          this.lastInit = { apiKeySource: m.apiKeySource, model: m.model, version: m.claude_code_version, tools: m.tools, skills: m.skills };
          if (m.session_id && m.session_id !== session.sdkSessionId) this.repos.saveSession(bot.id, room.id, { sdkSessionId: m.session_id });
          continue;
        }
        if (m.type === 'stream_event') {
          if (m.parent_tool_use_id) continue;
          const ev = m.event as { type: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            events.emitEvent({ type: 'turn.delta', turnId, roomId: room.id, botId: bot.id, text: ev.delta.text });
          }
          continue;
        }
        if (m.type === 'assistant') {
          if (m.parent_tool_use_id) continue;
          for (const block of m.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              if (/^\W*NO_REPLY\W*$/.test(block.text.trim())) {
                events.emitEvent({ type: 'bot.state', botId: bot.id, state: 'done', roomId: room.id, note: 'no reply' });
                continue;
              }
              texts.push(block.text);
              const msg = this.repos.insertMessage({
                roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'text', text: block.text, payload: null,
                causeId: req.causeId, hop: req.hop, turnId,
              });
              lastMessageId = msg.id;
              events.emitEvent({ type: 'message.new', message: msg });
            } else if (block.type === 'tool_use') {
              const payload: ToolPayload = { toolUseId: block.id, name: block.name, input: block.input, done: false };
              const msg = this.repos.insertMessage({
                roomId: room.id, authorType: 'bot', authorId: bot.id, kind: 'tool', text: block.name, payload,
                causeId: req.causeId, hop: req.hop, turnId,
              });
              toolMsgIds.set(block.id, msg.id);
              events.emitEvent({ type: 'message.new', message: msg });
              setState('working');
            }
          }
          continue;
        }
        if (m.type === 'user') {
          if (m.parent_tool_use_id) continue;
          const content = m.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const msgId = toolMsgIds.get(block.tool_use_id);
            if (!msgId) continue;
            const cur = this.repos.getMessage(msgId);
            if (!cur || !cur.payload) continue;
            const output = typeof block.content === 'string'
              ? block.content
              : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
            const payload: ToolPayload = { ...(cur.payload as ToolPayload), output: output.slice(0, 20000), isError: !!block.is_error, done: true };
            this.repos.updateMessage(msgId, { payload });
            events.emitEvent({ type: 'message.update', id: msgId, roomId: room.id, patch: { payload } });
          }
          setState('thinking');
          continue;
        }
        if (m.type === 'result') {
          costUsd = m.total_cost_usd ?? 0;
          ok = m.subtype === 'success';
          if (!ok) error = m.subtype + ((m as { errors?: string[] }).errors?.length ? ': ' + (m as { errors?: string[] }).errors!.join('; ') : '');
          const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          this.usage.record(bot.id, room.id, turnId, req.causeId, {
            costUsd, inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0,
            cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
            modelUsage: (m as { modelUsage?: unknown }).modelUsage, durationMs: m.duration_ms,
          });
          resolveDone();
          break;
        }
      }
    } catch (e) {
      error = error ?? String((e as Error).message ?? e);
    } finally {
      resolveDone();
      this.active.delete(turnId);
    }

    if (!ok && !error) error = 'Turn ended without a result';
    if (error) {
      const msg = this.repos.insertMessage({
        roomId: room.id, authorType: 'system', authorId: bot.id, kind: 'system', text: bot.name + ' turn ended: ' + error, payload: null,
        causeId: req.causeId, hop: req.hop, turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
    }
    events.emitEvent({ type: 'turn.end', turnId, roomId: room.id, botId: bot.id, messageId: lastMessageId, costUsd, error });
    setState(error ? 'error' : 'done');
    return { ok, turnId, finalText: texts.join('\n\n'), costUsd, error };
  }

  static checkExe(): { ok: boolean; error?: string } {
    return fs.existsSync(CLAUDE_EXE) ? { ok: true } : { ok: false, error: 'claude executable not found at ' + CLAUDE_EXE };
  }
}
