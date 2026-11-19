import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.js';

/**
 * Who changed a shared file, and from where (spec: docs/specs/claude-code-bridge.md, 6.1 and 6.3).
 *
 * Every write the hub can see into a room or project folder becomes a row in `file_revisions`: the owner's uploads
 * and text saves, and a bot's Write/Edit tools (a PostToolUse hook in the Claude provider). A bot's Bash writes are
 * not seen here. Small text files keep their content so a later view can show a diff.
 *
 * `writeText` is the versioned write: the caller passes the hash it last read (`base`), and a file that changed since
 * is refused with its current text instead of overwritten. `decisions.md` is append-only: `appendDecision` is the only
 * way the hub writes it, and the provider hook refuses a bot's own edits to it.
 */

export type RootKind = 'room' | 'project' | 'dm';
/** A folder whose files are tracked. `key` is the project slug, the room id, or (for a direct chat) the bot id. */
export interface FileRoot {
  kind: RootKind;
  key: string;
  dir: string;
}

export type AuthorKind = 'owner' | 'owner-cc' | 'bot' | 'persona' | 'offload';
export interface RevisionAuthor {
  kind: AuthorKind;
  /** Bot id for bots; null for the owner. */
  id: string | null;
  /** Shown in history: a bot handle or "owner". */
  label: string;
  machine: 'vps' | 'pc';
  /** Turn id for a bot, Claude Code session id for a terminal session. */
  sessionId?: string | null;
  roomId?: string | null;
  sources?: string[];
  /** The tool that wrote it (Write, Edit, upload, write_text, log_decision). */
  tool?: string;
}

export interface Revision {
  rev: number;
  /** sha256 of the bytes, or null when the file was deleted. */
  hash: string | null;
  size: number;
  author: { kind: AuthorKind; id: string | null; label: string; machine: string; sessionId: string | null; roomId: string | null };
  sources: string[];
  tool: string | null;
  at: number;
}

export type WriteResult =
  | { ok: true; hash: string; rev: number }
  | { ok: false; current: { hash: string | null; text: string | null; rev: Revision | null } };

export const DECISIONS_FILE = 'decisions.md';
/** Text up to this size is kept with its revision, for diffs. */
const KEEP_CONTENT_BYTES = 256 * 1024;
const DECISION_HEADING = /^## (D-\d{4,})\b/gm;

export function hashBytes(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The file's path inside `root`, with forward slashes, or null when it is outside (or is the root itself). */
export function relIn(root: FileRoot, abs: string): string | null {
  const rel = path.relative(path.resolve(root.dir), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function readOrNull(abs: string): Buffer | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? fs.readFileSync(abs) : null;
  } catch {
    return null;
  }
}

function keepable(buf: Buffer): string | null {
  if (buf.length > KEEP_CONTENT_BYTES || buf.includes(0)) return null;
  return buf.toString('utf8');
}

export class FileRevisions {
  constructor(private db: Db, private now: () => number = Date.now) {}

  private toRevision(r: Record<string, unknown>): Revision {
    let sources: string[] = [];
    try { sources = r.sources ? (JSON.parse(r.sources as string) as string[]) : []; } catch { /* old or hand-edited row */ }
    return {
      rev: r.rev as number,
      hash: (r.hash as string) ?? null,
      size: (r.size as number) ?? 0,
      author: {
        kind: r.author_kind as AuthorKind,
        id: (r.author_id as string) ?? null,
        label: (r.author_label as string) ?? '',
        machine: r.machine as string,
        sessionId: (r.session_id as string) ?? null,
        roomId: (r.room_id as string) ?? null,
      },
      sources,
      tool: (r.tool as string) ?? null,
      at: r.created_at as number,
    };
  }

  latest(root: FileRoot, rel: string): Revision | null {
    const r = this.db.get<Record<string, unknown>>(
      'SELECT * FROM file_revisions WHERE root_kind = ? AND root_key = ? AND path = ? ORDER BY rev DESC LIMIT 1',
      root.kind, root.key, rel,
    );
    return r ? this.toRevision(r) : null;
  }

  /** Newest first. */
  history(root: FileRoot, rel: string, limit = 20): Revision[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM file_revisions WHERE root_kind = ? AND root_key = ? AND path = ? ORDER BY rev DESC LIMIT ?',
        root.kind, root.key, rel, Math.max(1, Math.min(200, limit)),
      )
      .map((r) => this.toRevision(r));
  }

  /** Text kept with a revision (null when the file was too big, binary, or deleted). */
  contentAt(root: FileRoot, rel: string, rev: number): string | null {
    const r = this.db.get<{ content: string | null }>(
      'SELECT content FROM file_revisions WHERE root_kind = ? AND root_key = ? AND path = ? AND rev = ?',
      root.kind, root.key, rel, rev,
    );
    return r?.content ?? null;
  }

  /**
   * Records the file as it is on disk now. Nothing is recorded when it matches the last revision (a no-op Edit, or a
   * write the hub already recorded itself). Returns the new revision, or null.
   */
  record(root: FileRoot, rel: string, author: RevisionAuthor): Revision | null {
    const buf = readOrNull(path.join(root.dir, rel));
    const hash = buf ? hashBytes(buf) : null;
    const last = this.latest(root, rel);
    if (last ? last.hash === hash : hash === null) return null;
    const rev = (last?.rev ?? 0) + 1;
    this.db.run(
      `INSERT INTO file_revisions (root_kind, root_key, path, rev, hash, size, content, author_kind, author_id, author_label,
         machine, session_id, room_id, sources, tool, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      root.kind, root.key, rel, rev, hash, buf?.length ?? 0, buf ? keepable(buf) : null,
      author.kind, author.id, author.label, author.machine, author.sessionId ?? null, author.roomId ?? null,
      author.sources?.length ? JSON.stringify(author.sources) : null, author.tool ?? null, this.now(),
    );
    return this.latest(root, rel);
  }

  /** The file's current text and hash, for a reader that will write it back with `writeText`. */
  readText(root: FileRoot, rel: string): { text: string | null; hash: string | null; rev: Revision | null } {
    const buf = readOrNull(path.join(root.dir, rel));
    return { text: buf ? buf.toString('utf8') : null, hash: buf ? hashBytes(buf) : null, rev: this.latest(root, rel) };
  }

  /**
   * Versioned write. `base` is the hash the writer last read, or null to say the file must not exist yet. When the
   * file on disk no longer matches, nothing is written and the current text comes back so the writer can merge.
   * `decisions.md` is refused: it changes only through `appendDecision`.
   */
  writeText(root: FileRoot, rel: string, text: string, base: string | null, author: RevisionAuthor): WriteResult {
    if (path.posix.basename(rel).toLowerCase() === DECISIONS_FILE) {
      throw new FileRevisionError(409, DECISIONS_FILE + ' is append-only. Add a decision with log_decision instead.');
    }
    const abs = path.join(root.dir, rel);
    const cur = readOrNull(abs);
    const curHash = cur ? hashBytes(cur) : null;
    if (curHash !== base) return { ok: false, current: { hash: curHash, text: cur ? cur.toString('utf8') : null, rev: this.latest(root, rel) } };
    // A file someone changed without the hub seeing it (a bot's Bash, an editor on the server) gets its own
    // revision first, so the history does not credit those bytes to this writer.
    if (cur && this.latest(root, rel)?.hash !== curHash) this.record(root, rel, { kind: 'owner', id: null, label: 'unknown', machine: 'vps', tool: 'outside the hub' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, abs);
    const r = this.record(root, rel, { ...author, tool: author.tool ?? 'write_text' });
    const hash = hashBytes(Buffer.from(text, 'utf8'));
    return { ok: true, hash, rev: r?.rev ?? this.latest(root, rel)?.rev ?? 0 };
  }

  /**
   * Appends one decision to `decisions.md` in the root and returns its id (D-0001, D-0002, ...). Earlier entries are
   * never touched: a changed decision is a new entry naming the one it supersedes.
   */
  appendDecision(root: FileRoot, a: { title: string; text: string; supersedes?: string[] }, author: RevisionAuthor): { id: string; rev: number } {
    const abs = path.join(root.dir, DECISIONS_FILE);
    const cur = readOrNull(abs)?.toString('utf8') ?? '';
    const known = new Set([...cur.matchAll(DECISION_HEADING)].map((m) => m[1]));
    for (const s of a.supersedes ?? []) {
      if (!known.has(s)) throw new FileRevisionError(400, 'No decision ' + s + ' in ' + DECISIONS_FILE + ' to supersede');
    }
    const n = [...known].reduce((max, id) => Math.max(max, Number(id.slice(2))), 0) + 1;
    const id = 'D-' + String(n).padStart(4, '0');
    const when = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const title = a.title.replace(/\s+/g, ' ').trim();
    const lines = [
      '## ' + id + ' · ' + title,
      '',
      '_' + when + ' · ' + author.label + ' (' + author.machine + ')' + (a.supersedes?.length ? ' · supersedes ' + a.supersedes.join(', ') : '') + '_',
      '',
      a.text.trim(),
    ];
    if (author.sources?.length) lines.push('', 'Sources: ' + author.sources.join(', '));
    const head = cur ? '' : '# Decisions\n\nAppend-only. Add one with `log_decision`; to change a decision, add a new one that supersedes it.\n\n';
    const sep = cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : '';
    // Outside edits since the last recorded revision are recorded first, as in writeText.
    const last = this.latest(root, DECISIONS_FILE);
    if (cur && last?.hash !== hashBytes(cur)) this.record(root, DECISIONS_FILE, { kind: 'owner', id: null, label: 'unknown', machine: 'vps', tool: 'outside the hub' });
    fs.mkdirSync(root.dir, { recursive: true });
    fs.appendFileSync(abs, head + sep + lines.join('\n') + '\n');
    const r = this.record(root, DECISIONS_FILE, { ...author, tool: 'log_decision' });
    return { id, rev: r?.rev ?? 0 };
  }
}

export class FileRevisionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** True for a write tool or shell command aimed at a root's `decisions.md` (which only log_decision may change). */
export function decisionsWriteDenied(toolName: string, input: Record<string, unknown>, cwd: string, roots: FileRoot[]): string | null {
  const why = DECISIONS_FILE + ' is append-only and keeps every decision as it was made. Use log_decision to add one; to change one, log a new decision that supersedes it.';
  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    if (!/decisions\.md/i.test(cmd)) return null;
    // Reading it is fine (cat, grep, head, less); anything that can write, move or delete it is not.
    const writes = [
      />>?\s*['"]?[^\s'"|;&]*decisions\.md/i,
      /\b(tee|mv|rm|cp|truncate|dd|ln)\b[^|;&]*decisions\.md/i,
      /\b(sed|perl)\b[^|;&]*\s-i[^|;&]*decisions\.md/i,
      /\b(Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item)\b[^|;&]*decisions\.md/i,
    ];
    return writes.some((re) => re.test(cmd)) ? why : null;
  }
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof p !== 'string' || !p) return null;
  const abs = path.resolve(cwd, p);
  if (path.basename(abs).toLowerCase() !== DECISIONS_FILE) return null;
  return roots.some((r) => relIn(r, abs) !== null) ? why : null;
}
