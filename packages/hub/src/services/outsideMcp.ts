import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { addSecret } from '../providers/redact.js';

/**
 * Outside MCP servers the owner gives to named bots, e.g. the Wika dashboard for the Wika bots.
 *
 * Owner-edited JSON at <DATA_DIR>/mcp-servers.json (0600, beside secrets.json), read on every turn so an
 * edit takes effect on the next turn without a restart. No UI and no bot tool writes it, and a bot's file and
 * shell tools are refused it (permissions/secretFiles.ts):
 *
 *   {
 *     "wika": {
 *       "url": "https://dashboard.wikaph.com/api/mcp",
 *       "token": "<key>",
 *       "rooms": ["Wika"],
 *       "bots": ["wika-backend"]
 *     },
 *     "firecrawl": {
 *       "command": "npx",
 *       "args": ["-y", "firecrawl-mcp"],
 *       "env": { "FIRECRAWL_API_KEY": "<key>" },
 *       "bots": ["researcher"],
 *       "approve": "writes",
 *       "readTools": ["firecrawl_search"]
 *     }
 *   }
 *
 * An entry is either remote (`url`, optional bearer `token`; https, or http to this machine only) or a local
 * stdio process (`command`, optional `args` and `env`), never both. `command` must be `npx`, `node` or an
 * absolute path. Every `env` value and every `token` is registered for redaction (`registerOutsideMcpSecrets`),
 * so a key the server echoes back is scrubbed from the chat and the logs.
 *
 * `rooms` lists room ids or names: every bot gets the server while it works in that room. `bots` lists
 * handles that get it in every room. An entry needs at least one of the two.
 *
 * `approve` decides when the owner sees a card for a call. The card shows under approvals bypass too, and no
 * "always" answer or approval rule covers it:
 * - `every-call`: every call. The default for stdio entries, which carry the owner's own keys.
 * - `writes`: every call except the bare tool names listed in `readTools`.
 * - `none`: no card of its own. The default for url entries. Outside bypass mode such a call still reaches
 *   the approval broker like any other unlisted tool; under bypass it runs.
 * An unknown `approve` value means `every-call`. Give a bot a read-only key where the service offers one.
 * Claude provider only; other adapters ignore this file.
 */
export const OUTSIDE_MCP_PATH = path.join(DATA_DIR, 'mcp-servers.json');

/** Names the hub uses itself; an outside server may not take them. */
const RESERVED = new Set(['pocketrocket', 'browser']);
/** No `__` in a name: the SDK names tools `mcp__<server>__<tool>`, and the approval guard splits on it. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Launchers a stdio entry may name without a full path. Anything else must be an absolute path. */
const BARE_COMMANDS = new Set(['npx', 'node']);

export type OutsideMcpApprove = 'every-call' | 'writes' | 'none';

interface OutsideMcpBase {
  name: string;
  approve: OutsideMcpApprove;
  /** Bare tool names that skip the card when `approve` is 'writes'. */
  readTools: string[];
}
export interface OutsideMcpHttp extends OutsideMcpBase {
  kind: 'http';
  url: string;
  token: string | null;
}
export interface OutsideMcpStdio extends OutsideMcpBase {
  kind: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}
export type OutsideMcpServer = OutsideMcpHttp | OutsideMcpStdio;

/** Does this call need the owner's card? `tool` is the bare tool name, without `mcp__<server>__`. */
export function outsideMcpNeedsCard(server: Pick<OutsideMcpServer, 'approve' | 'readTools'>, tool: string): boolean {
  if (server.approve === 'none') return false;
  if (server.approve === 'writes') return !server.readTools.includes(tool);
  return true;
}

/** Registers every key an outside server carries (bearer token, env values) for redaction. */
export function registerOutsideMcpSecrets(servers: readonly OutsideMcpServer[]): void {
  for (const s of servers) {
    if (s.kind === 'http') addSecret(s.token);
    else for (const v of Object.values(s.env)) addSecret(v);
  }
}

function stdioCommand(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v !== v.trim()) return null;
  if (BARE_COMMANDS.has(v)) return v;
  return path.isAbsolute(v) ? v : null;
}

/** A list of strings; absent means empty, anything else is null. */
function strings(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

function approveOf(v: unknown, fallback: OutsideMcpApprove): OutsideMcpApprove {
  if (v === undefined) return fallback;
  return v === 'writes' || v === 'none' ? v : 'every-call';
}

/** The servers configured for this bot handle. A missing or broken file means none; a broken entry is skipped. */
export function outsideMcpFor(handle: string, room: { id: string; name: string } | null, file: string = OUTSIDE_MCP_PATH): OutsideMcpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: OutsideMcpServer[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || RESERVED.has(name) || !v || typeof v !== 'object') continue;
    const s = v as {
      url?: unknown; token?: unknown; command?: unknown; args?: unknown; env?: unknown;
      bots?: unknown; rooms?: unknown; approve?: unknown; readTools?: unknown;
    };
    const byBot = Array.isArray(s.bots) && s.bots.includes(handle);
    const byRoom = !!room && Array.isArray(s.rooms) && (s.rooms.includes(room.id) || s.rooms.includes(room.name));
    if (!byBot && !byRoom) continue;
    const readTools = strings(s.readTools) ?? [];

    if (s.command !== undefined) {
      if (s.url !== undefined) continue;
      const command = stdioCommand(s.command);
      const args = strings(s.args);
      if (!command || !args) continue;
      const rawEnv = s.env ?? {};
      if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) continue;
      const entries = Object.entries(rawEnv as Record<string, unknown>);
      if (!entries.every(([k, val]) => ENV_KEY_RE.test(k) && typeof val === 'string')) continue;
      const env = Object.fromEntries(entries) as Record<string, string>;
      out.push({ kind: 'stdio', name, command, args, env, approve: approveOf(s.approve, 'every-call'), readTools });
      continue;
    }

    if (typeof s.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(s.url);
    } catch {
      continue;
    }
    // A key only ever travels over TLS, or to this machine.
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) continue;
    out.push({
      kind: 'http', name, url: url.toString(), token: typeof s.token === 'string' && s.token ? s.token : null,
      approve: approveOf(s.approve, 'none'), readTools,
    });
  }
  return out;
}
