import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Db, Row } from './db.js';

export interface ContextMeta {
  id: string;
  project: string;
  title: string;
  bytes: number;
  createdAt: number;
}
export interface ContextItem extends ContextMeta { body: string }

/** The public connector can only ever queue this many unreviewed items, so a leaked URL cannot fill the disk. */
export const MAX_PENDING_CONTEXT = 200;
const COLUMNS = 'id,project,title,length(body) AS bytes,created_at';

const meta = (r: Row): ContextMeta => ({ id: r.id as string, project: r.project as string, title: r.title as string, bytes: Number(r.bytes), createdAt: Number(r.created_at) });
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** What the Claude connector has sent and the owner has not reviewed. Approved text becomes a file in the project. */
export class ContextRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  queue(input: { project: string; title: string; body: string }): ContextMeta {
    const id = nanoid(10);
    this.db.run('INSERT INTO context_queue (id,project,title,body,created_at) VALUES (?,?,?,?,?)', id, input.project, input.title, input.body, this.now());
    return meta(this.db.get('SELECT ' + COLUMNS + ' FROM context_queue WHERE id=?', id)!);
  }
  get(id: string): ContextItem | undefined {
    const r = this.db.get('SELECT ' + COLUMNS + ',body FROM context_queue WHERE id=?', id);
    return r ? { ...meta(r), body: r.body as string } : undefined;
  }
  list(): ContextMeta[] {
    return this.db.all('SELECT ' + COLUMNS + ' FROM context_queue ORDER BY created_at DESC').map(meta);
  }
  pendingCount(): number {
    return Number(this.db.get('SELECT COUNT(*) AS n FROM context_queue')?.n ?? 0);
  }
  remove(id: string) {
    this.db.run('DELETE FROM context_queue WHERE id=?', id);
  }

  /** Mints the connector URL's secret. Only its hash is kept, because every bot's Linux user can read the database. */
  mintConnectorToken(): string {
    const token = randomBytes(32).toString('base64url');
    this.db.run('DELETE FROM context_connector');
    this.db.run('INSERT INTO context_connector (token_hash,created_at) VALUES (?,?)', hash(token), this.now());
    return token;
  }
  revokeConnectorToken() {
    this.db.run('DELETE FROM context_connector');
  }
  connectorEnabled(): boolean {
    return !!this.db.get('SELECT token_hash FROM context_connector');
  }
  connectorTokenMatches(token: string): boolean {
    return !!this.db.get('SELECT token_hash FROM context_connector WHERE token_hash=?', hash(token));
  }
}
