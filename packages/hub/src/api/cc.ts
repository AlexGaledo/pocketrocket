import type { IncomingMessage, ServerResponse } from 'node:http';
import { events } from '../events.js';
import { readBody, MAX_BODY_BYTES } from './body.js';
import { principalOf } from './guard.js';
import { FilesError, folderIn, parentOf, resolveIn, statOrNull } from './files.js';
import type { Repos } from '../db/repos.js';
import { fileRootOf, type RoomFiles } from '../rooms/roomFiles.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import type { ProjectService } from '../services/ProjectService.js';
import { recordAudit } from '../services/AuditLog.js';
import { DECISIONS_FILE, FileRevisionError, type FileRevisions, type FileRoot, type RevisionAuthor } from '../services/FileRevisions.js';
import { CURRENT_FILE, parseDecisions } from '../services/StateHeader.js';
import { quoteTags } from '../rooms/transcript.js';
import { redact, logError } from '../providers/redact.js';
import { settings } from '../services/SettingsStore.js';

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

const MAX_POST_CHARS = 8000;
const MAX_REPO_CHARS = 80;
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HANDLE = /^[a-z0-9_-]{2,24}$/;

/** A repo name from a header: printable text only, no brackets (it goes into a chat line), at most 80 characters. */
export function cleanRepo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\u0000-\u001f\u007f[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REPO_CHARS);
  return s || null;
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * `/api/cc/*`: the owner's Claude Code terminal sessions on the PC, reaching rooms through the PC runner's MCP server
 * (spec: docs/specs/claude-code-bridge.md, 3.2). Runner principal only: the hub token and every other caller get 403,
 * and guard.ts's runner allowlist keeps the runner out of everything but these routes and its own polling.
 *
 * Headers, both optional: `x-cc-session` (the Claude Code session id) and `x-cc-repo` (repo name, 80 characters).
 *
 *   GET  /api/cc/rooms                                  group and project rooms (no direct chats)
 *   GET  /api/cc/rooms/:id/messages?limit=30&before=    { messages: [{ seq, at, author, text }] }, newest last
 *   POST /api/cc/rooms/:id/messages                     { text } posts as the owner, labelled "[via Claude Code · repo]"
 *   GET  /api/cc/rooms/:id/state                        current.md, the latest decisions
 *   GET  /api/cc/rooms/:id/files/text?path=             as /api/rooms/:id/files/text
 *   POST /api/cc/rooms/:id/files/text                   { path, text, base, sources? }, 409 with the current text when stale
 *   POST /api/cc/rooms/:id/decision                     { title, text, supersedes?, sources? }
 *   POST /api/cc/rooms/:id/handoff                      { to, task, context? } posts an @mention of a member bot
 */
export function createCcApi(deps: { repos: Repos; roomFiles: RoomFiles; revisions: FileRevisions; router: RoomRouter; projects?: ProjectService }) {
  const { repos, roomFiles, revisions, router, projects } = deps;

  const project = (slug: string | null) => {
    if (!slug) return null;
    return { slug, name: projects?.get(slug)?.name ?? slug };
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/cc' && !url.pathname.startsWith('/api/cc/')) return false;
    if (principalOf(req)?.kind !== 'runner') return send(res, 403, { error: 'Only the PC runner can do this' });
    const method = req.method ?? 'GET';
    const pathname = url.pathname.replace(/\/+$/, '');

    const sessionId = (() => { const v = header(req, 'x-cc-session'); return v && SESSION_ID.test(v) ? v : null; })();
    const repo = cleanRepo(header(req, 'x-cc-repo'));
    const ownerName = () => settings.get().userName;

    try {
      if (pathname === '/api/cc/rooms' && method === 'GET') {
        const rooms = repos.listRooms().filter((r) => r.kind !== 'dm').map((r) => {
          const folder = roomFiles.folderOf(r);
          return { id: r.id, name: r.name, kind: r.kind, project: project(folder?.projectSlug ?? null), hasFolder: !!folder };
        });
        return send(res, 200, rooms);
      }

      const m = /^\/api\/cc\/rooms\/([^/]+)\/(messages|state|files\/text|decision|handoff)$/.exec(pathname);
      if (!m) return send(res, 404, { error: 'Not found' });
      let roomId: string;
      try { roomId = decodeURIComponent(m[1]); } catch { return send(res, 404, { error: 'No room with that id' }); }
      const action = m[2];
      const room = repos.getRoom(roomId);
      if (!room || room.kind === 'dm') return send(res, 404, { error: 'No room with that id' });
      const folder = roomFiles.folderOf(room);

      let body: Record<string, unknown> = {};
      if (method === 'POST') {
        const buf = await readBody(req, MAX_BODY_BYTES);
        if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
        try {
          const parsed: unknown = buf.length ? JSON.parse(buf.toString('utf8')) : {};
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return send(res, 400, { error: 'A JSON object is needed' });
          body = parsed as Record<string, unknown>;
        } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      }

      /** What a post says about where it came from. The label is text, so bots and the app need nothing new to show it. */
      const via = '[via Claude Code' + (repo ? ' · ' + repo : '') + ']';
      const post = (text: string) => {
        const msg = router.onUserMessage(room.id, via + ' ' + text);
        return send(res, 200, { ok: true, id: msg.id });
      };

      if (action === 'messages' && method === 'GET') {
        const limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get('limit') ?? 30)) || 30));
        const bq = url.searchParams.get('before');
        const before = bq ? Number(bq) : undefined;
        if (before !== undefined && !Number.isFinite(before)) return send(res, 400, { error: 'before must be a message number' });
        const handles = new Map(repos.listBots().map((b) => [b.id, b.handle]));
        const messages = repos
          .listMessages(room.id, { before, limit })
          .filter((x) => x.kind === 'text' || x.kind === 'handoff' || x.kind === 'routine' || x.kind === 'trigger')
          .map((x) => ({
            seq: x.seq,
            at: x.createdAt,
            author: x.authorType === 'user' ? ownerName() : x.authorType === 'system' ? 'system' : '@' + (handles.get(x.authorId ?? '') ?? 'bot'),
            text: quoteTags(redact(x.text)),
          }));
        return send(res, 200, { messages });
      }

      if (action === 'messages' && method === 'POST') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_POST_CHARS) {
          return send(res, 400, { error: 'text: 1 to ' + MAX_POST_CHARS + ' characters' });
        }
        return post(body.text);
      }

      if (action === 'handoff' && method === 'POST') {
        const to = typeof body.to === 'string' ? body.to.replace(/^@/, '').trim().toLowerCase() : '';
        if (!HANDLE.test(to)) return send(res, 400, { error: 'to: the handle of a bot in this room' });
        if (typeof body.task !== 'string' || !body.task.trim() || body.task.length > 4000) return send(res, 400, { error: 'task: 1 to 4000 characters' });
        if (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 3000)) return send(res, 400, { error: 'context: up to 3000 characters' });
        const bot = room.memberIds.map((id) => repos.getBot(id)).find((b) => b?.handle.toLowerCase() === to);
        if (!bot) return send(res, 400, { error: '@' + to + ' is not in this room' });
        const context = typeof body.context === 'string' ? body.context.trim() : '';
        return post('@' + bot.handle + ' handoff from a Claude Code session: ' + body.task.trim() + (context ? '\n\nContext:\n' + context : ''));
      }

      // The rest work on the room's folder.
      if (!folder) return send(res, 404, { error: 'No room with that id' });
      const dir = roomFiles.ensure(folder);
      const root: FileRoot = fileRootOf(room, { ...folder, dir });
      const author: RevisionAuthor = {
        kind: 'owner-cc', id: null, label: ownerName() + ' via Claude Code (' + (repo ?? 'terminal') + ')', machine: 'pc', sessionId, roomId: room.id,
      };
      const changed = (what: string, detail: string, folders: string[]) => {
        recordAudit(repos.db, { kind: 'anonymous', id: 'claude-code' + (sessionId ? ':' + sessionId : '') }, 'cc.files.' + what, room.id, detail);
        for (const f of new Set(folders)) events.emitEvent({ type: 'files.changed', roomId: room.id, path: f });
      };

      if (action === 'state' && method === 'GET') {
        const cur = revisions.readText(root, CURRENT_FILE);
        const dec = revisions.readText(root, DECISIONS_FILE);
        return send(res, 200, {
          room: { id: room.id, name: room.name },
          project: project(folder.projectSlug),
          current: cur.text === null ? null : { path: CURRENT_FILE, text: cur.text, hash: cur.hash, rev: cur.rev },
          decisions: dec.text ? parseDecisions(dec.text).slice(-10) : [],
        });
      }

      if (action === 'files/text' && method === 'GET') {
        const { abs, rel } = resolveIn(dir, url.searchParams.get('path') ?? '');
        if (!rel) throw new FilesError(400, 'A file path is needed');
        const st = statOrNull(abs);
        if (st && !st.isFile()) throw new FilesError(400, 'Not a file');
        if (st && st.size > MAX_BODY_BYTES) throw new FilesError(413, 'File too large to edit as text (max 1 MB)');
        const r = revisions.readText(root, rel);
        return send(res, 200, { path: rel, text: r.text, hash: r.hash, rev: r.rev });
      }

      if (action === 'files/text' && method === 'POST') {
        if (typeof body.path !== 'string' || typeof body.text !== 'string') throw new FilesError(400, 'path and text are needed');
        if (!(body.base === null || (typeof body.base === 'string' && /^[0-9a-f]{64}$/.test(body.base)))) {
          throw new FilesError(400, 'base: the hash from the last read of this file, or null for a new file');
        }
        const sources = Array.isArray(body.sources) ? body.sources.filter((x): x is string => typeof x === 'string').slice(0, 10) : undefined;
        const { rel } = resolveIn(dir, body.path);
        if (!rel) throw new FilesError(400, 'A file path is needed');
        const made = folderIn(dir, parentOf(rel), true);
        const r = revisions.writeText(root, rel, body.text, body.base, { ...author, sources });
        if (!r.ok) return send(res, 409, { error: 'The file changed since it was read. Merge with the current text and send its hash as base.', current: r.current });
        changed('written', rel, [made.rel, ...made.made.map(parentOf)]);
        return send(res, 200, { ok: true, path: rel, hash: r.hash, rev: r.rev });
      }

      if (action === 'decision' && method === 'POST') {
        if (typeof body.title !== 'string' || !body.title.trim() || typeof body.text !== 'string' || !body.text.trim()) throw new FilesError(400, 'title and text are needed');
        const supersedes = Array.isArray(body.supersedes) ? body.supersedes.filter((x): x is string => typeof x === 'string' && /^D-\d{4,}$/.test(x)) : undefined;
        const sources = Array.isArray(body.sources) ? body.sources.filter((x): x is string => typeof x === 'string').slice(0, 10) : undefined;
        const r = revisions.appendDecision(root, { title: body.title.slice(0, 120), text: body.text.slice(0, 4000), supersedes }, { ...author, sources });
        changed('decision_logged', DECISIONS_FILE, ['']);
        return send(res, 200, { ok: true, id: r.id, rev: r.rev });
      }

      return send(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      if (e instanceof FilesError || e instanceof FileRevisionError) return send(res, e.status, { error: e.message });
      logError('[cc api]', e);
      return send(res, 500, { error: 'Something went wrong' });
    }
  };
}
