import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * Outside MCP servers the owner gives to named bots, e.g. the Wika dashboard for the Wika bots.
 *
 * Owner-edited JSON at <DATA_DIR>/mcp-servers.json (0600, beside secrets.json), read on every turn so an
 * edit takes effect on the next turn without a restart. No UI and no bot tool writes it:
 *
 *   {
 *     "wika": {
 *       "url": "https://dashboard.wikaph.com/api/mcp",
 *       "token": "<key>",
 *       "rooms": ["Wika"],
 *       "bots": ["wika-backend"]
 *     }
 *   }
 *
 * `rooms` lists room ids or names: every bot gets the server while it works in that room. `bots` lists
 * handles that get it in every room. An entry needs at least one of the two. Tools from these servers are never pre-approved: outside bypass mode every call goes
 * through the approval broker like any other unlisted tool. Give a bot a read-only key.
 * Claude provider only; other adapters ignore it.
 */
export const OUTSIDE_MCP_PATH = path.join(DATA_DIR, 'mcp-servers.json');

/** Names the hub uses itself; an outside server may not take them. */
const RESERVED = new Set(['pocketrocket', 'browser']);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface OutsideMcpServer {
  name: string;
  url: string;
  token: string | null;
}

/** The servers configured for this bot handle. A missing or broken file means none. */
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
    const s = v as { url?: unknown; token?: unknown; bots?: unknown; rooms?: unknown };
    const byBot = Array.isArray(s.bots) && s.bots.includes(handle);
    const byRoom = !!room && Array.isArray(s.rooms) && (s.rooms.includes(room.id) || s.rooms.includes(room.name));
    if (!byBot && !byRoom) continue;
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
    out.push({ name, url: url.toString(), token: typeof s.token === 'string' && s.token ? s.token : null });
  }
  return out;
}
