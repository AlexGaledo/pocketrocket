import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeStatus } from '@pocketrocket/shared';
import { DATA_DIR, KNOWLEDGE_DIR } from '../config.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { isInside } from '../permissions/pathRules.js';
import { parseGitSource, runGit, type GitRunner } from './git.js';

/**
 * The knowledge repo (P7, 7.1): one folder every bot can read and none can write.
 *
 * `settings.knowledgeRepo` is either a git URL, cloned (shallow) into `data/knowledge` and refreshed with
 * `git pull --ff-only` on a timer and on "Sync now", or an absolute local folder, linked there (a junction on
 * Windows) so edits the user makes show up at once. Bots get the folder as a read-only root: reads pass,
 * every write raises an approval card (PermissionBroker) or is denied outright (Claude hook, under bypass).
 */

/** Why `raw` cannot be the knowledge source, or null when it can ('' = off is fine). */
export function knowledgeSourceError(raw: string): string | null {
  if (!raw.trim()) return null;
  const src = parseGitSource(raw);
  if (typeof src === 'string') return src;
  // Linking the data folder (or a parent of it) would let every bot read secrets.json and the hub token.
  if (src.kind === 'path' && (isInside(src.value, [DATA_DIR]) || isInside(DATA_DIR, [src.value]))) {
    return 'The knowledge folder may not contain, or sit inside, the app\'s data folder';
  }
  return null;
}

export interface KnowledgeDeps {
  repos: Repos;
  /** settings.knowledgeRepo, read live. */
  source: () => string;
  /** Defaults to KNOWLEDGE_DIR; tests point it at a temp folder. */
  dir?: string;
  git?: GitRunner;
}

interface Row { source: string; mode: KnowledgeStatus['mode']; last_synced_at: number | null; head: string | null; last_error: string | null }

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
const sameDir = (a: string, b: string) => {
  const c = (p: string) => path.resolve(fs.realpathSync.native(p));
  try {
    return process.platform === 'win32' ? c(a).toLowerCase() === c(b).toLowerCase() : c(a) === c(b);
  } catch {
    return false;
  }
};

export class KnowledgeRepo {
  readonly dir: string;
  private git: GitRunner;
  private syncing: Promise<KnowledgeStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private off: (() => void) | null = null;

  constructor(private deps: KnowledgeDeps) {
    this.dir = deps.dir ?? KNOWLEDGE_DIR;
    this.git = deps.git ?? runGit;
  }

  status(): KnowledgeStatus {
    const r = this.deps.repos.db.get<Row>('SELECT * FROM knowledge_sync WHERE id=1');
    const mode = r?.mode ?? 'off';
    return {
      source: r?.source ?? '',
      mode,
      dir: mode !== 'off' && exists(this.dir) ? this.dir : null,
      syncing: this.syncing !== null,
      lastSyncedAt: r?.last_synced_at ?? null,
      head: r?.head ?? null,
      lastError: r?.last_error ?? null,
    };
  }

  /** The folder bots read, or null when no repo is configured or the last sync left nothing usable. */
  activeDir(): string | null {
    const s = this.status();
    return s.source && s.source === this.deps.source().trim() ? s.dir : null;
  }

  private save(p: Partial<Row>) {
    const cur = this.deps.repos.db.get<Row>('SELECT * FROM knowledge_sync WHERE id=1');
    const next: Row = { source: '', mode: 'off', last_synced_at: null, head: null, last_error: null, ...cur, ...p };
    this.deps.repos.db.run(
      'INSERT INTO knowledge_sync (id, source, mode, last_synced_at, head, last_error) VALUES (1, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET source=excluded.source, mode=excluded.mode, last_synced_at=excluded.last_synced_at, ' +
        'head=excluded.head, last_error=excluded.last_error',
      next.source, next.mode, next.last_synced_at, next.head, next.last_error,
    );
  }

  private emit() {
    events.emitEvent({ type: 'knowledge.status', status: this.status() });
  }

  /**
   * Remove what is at `dir`, but only what this service put there: a link (removed, never followed) or a git
   * clone. Anything else is left alone and reported, so a hand-made folder is never deleted.
   */
  private clear(): string | null {
    if (!exists(this.dir)) return null;
    if (isLink(this.dir)) {
      try {
        fs.unlinkSync(this.dir);
      } catch {
        fs.rmdirSync(this.dir); // a Windows junction can need rmdir rather than unlink
      }
      return null;
    }
    if (!fs.readdirSync(this.dir).length) {
      fs.rmdirSync(this.dir);
      return null;
    }
    if (!fs.existsSync(path.join(this.dir, '.git'))) return this.dir + ' exists and is not a knowledge clone; move it away first';
    fs.rmSync(this.dir, { recursive: true, force: true });
    return null;
  }

  /** One sync at a time; a call while one runs gets the same promise. */
  sync(): Promise<KnowledgeStatus> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null;
        this.emit();
      });
      this.emit();
    }
    return this.syncing;
  }

  private async doSync(): Promise<KnowledgeStatus> {
    const raw = this.deps.source().trim();
    const fail = (error: string, extra: Partial<Row> = {}) => {
      this.save({ source: raw, last_error: error.slice(0, 500), ...extra });
      return this.status();
    };
    try {
      if (!raw) {
        const err = this.clear();
        this.save({ source: '', mode: 'off', head: null, last_error: err, last_synced_at: null });
        return this.status();
      }
      const bad = knowledgeSourceError(raw);
      if (bad) return fail(bad, { mode: 'off' });
      const src = parseGitSource(raw);
      if (typeof src === 'string') return fail(src, { mode: 'off' });
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });

      if (src.kind === 'path') {
        if (!(isLink(this.dir) && sameDir(this.dir, src.value))) {
          const err = this.clear();
          if (err) return fail(err, { mode: 'off' });
          fs.symlinkSync(src.value, this.dir, 'junction');
        }
        this.save({ source: raw, mode: 'link', head: null, last_error: null, last_synced_at: Date.now() });
        return this.status();
      }

      // A git URL: reuse the clone while its origin still matches, else start over.
      if (exists(this.dir)) {
        let origin = '';
        if (!isLink(this.dir) && fs.existsSync(path.join(this.dir, '.git'))) {
          origin = (await this.git(['-C', this.dir, 'remote', 'get-url', 'origin']).catch(() => '')).trim();
        }
        if (origin !== src.value) {
          const err = this.clear();
          if (err) return fail(err, { mode: 'off' });
        }
      }
      if (!exists(this.dir)) {
        await this.git(['clone', '--depth', '1', '--single-branch', '--no-tags', '--', src.value, this.dir], { cwd: path.dirname(this.dir) });
      } else {
        await this.git(['-C', this.dir, 'pull', '--ff-only', '--no-tags']);
      }
      const head = (await this.git(['-C', this.dir, 'rev-parse', '--short', 'HEAD']).catch(() => '')).trim() || null;
      this.save({ source: raw, mode: 'clone', head, last_error: null, last_synced_at: Date.now() });
      return this.status();
    } catch (e) {
      // The last good clone stays readable; only the reason this sync failed is recorded.
      return fail(String((e as Error).message ?? e));
    }
  }

  /**
   * Syncs now when the configured source differs from what was last synced (startup, a Settings change), then
   * pulls every `minutes` while the source is a clone. A linked local folder is live and needs no pulling.
   */
  start(minutes: number) {
    this.stop();
    const maybe = () => {
      const want = this.deps.source().trim();
      if (want !== this.status().source) void this.sync();
    };
    maybe();
    this.off = events.onEvent((ev) => {
      if (ev.type === 'settings.changed') maybe();
    });
    if (minutes > 0) {
      this.timer = setInterval(() => {
        if (this.status().mode === 'clone') void this.sync();
      }, minutes * 60_000);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }
}
