import { pathToFileURL } from 'node:url';
import type { Repos } from '../db/repos.js';
import type { ComputerManager } from './ComputerManager.js';

/** Why the server browser could not open something. `status` is the HTTP status the route answers with. */
export class ScreenOpenError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Only real web pages: no javascript:, data:, chrome:, file: (files come in as a checked path, not a URL). */
export function webUrlOrNull(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

/**
 * Opens a page in the server's virtual browser, in a new tab, so the person sees it in the Screen window. Used
 * when a link in chat is opened "in the server browser": a web link, or a file in the room's folder (as file://,
 * which works because every screen's Chromium runs as the hub's own user).
 *
 * Which browser: with per-bot computers, the given bot's computer if it has a browser, otherwise the first bot
 * in the room that has one, otherwise any bot with one (an awake one first); it is woken if asleep. Without
 * per-bot computers, the one shared screen.
 * Answers the bot whose computer it used (null for the shared screen), for the Screen window to open on.
 */
export function createScreenOpener(deps: {
  repos: Repos;
  computers: ComputerManager;
  usesComputer: (botId: string) => boolean;
  fetchFn?: typeof fetch;
}) {
  const { repos, computers, usesComputer } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  function pickBot(roomId?: string, botId?: string): string | null {
    const room = roomId ? repos.getRoom(roomId) : undefined;
    if (botId && usesComputer(botId) && (!room || room.memberIds.includes(botId))) return botId;
    const here = room?.memberIds.find((id) => usesComputer(id));
    if (here) return here;
    // Nobody in this chat has a browser (a files-only bot, say): any bot that has one, one already awake first,
    // so a link still opens without starting another computer.
    const others = repos.listBots().map((b) => b.id).filter((id) => usesComputer(id));
    return others.find((id) => computers.status(id).state === 'live') ?? others[0] ?? null;
  }

  async function open(target: { url: string } | { file: string }, o: { roomId?: string; botId?: string } = {}): Promise<{ botId: string | null }> {
    const url = 'file' in target ? pathToFileURL(target.file).href : webUrlOrNull(target.url);
    if (!url) throw new ScreenOpenError(400, 'Only http and https links open in the server browser');
    let cdpUrl: string;
    let usedBot: string | null = null;
    if (computers.enabled) {
      const botId = pickBot(o.roomId, o.botId);
      if (!botId) throw new ScreenOpenError(409, 'No bot has a browser. Turn on Browser for one in its settings.');
      const woke = await computers.wakeFocused(botId);
      if (!woke.ok) throw new ScreenOpenError(409, woke.reason);
      cdpUrl = woke.endpoint.cdpUrl;
      usedBot = botId;
    } else {
      cdpUrl = computers.legacyEndpoint().cdpUrl;
    }
    // Chromium's DevTools HTTP endpoint: PUT /json/new?<url> opens a new, focused tab. The query is the whole URL,
    // percent-encoded; Chromium unescapes it.
    let res: Response;
    try {
      res = await fetchFn(cdpUrl + '/json/new?' + encodeURIComponent(url), { method: 'PUT', signal: AbortSignal.timeout(5000) });
    } catch {
      throw new ScreenOpenError(503, 'The server browser is not responding. Open Screen and try again.');
    }
    if (!res.ok) throw new ScreenOpenError(502, 'The server browser refused to open it (' + res.status + ')');
    return { botId: usedBot };
  }

  return { open };
}

export type ScreenOpener = ReturnType<typeof createScreenOpener>;
