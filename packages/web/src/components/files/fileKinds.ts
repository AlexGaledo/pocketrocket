// What a file is, for its icon colour and its preview. Decided from the extension alone: the listing carries
// nothing else, and sniffing 2,000 files to draw a folder would cost far more than it tells.
import type { FileEntry } from '@pocketrocket/shared';

export type FileKind = 'folder' | 'doc' | 'pdf' | 'code' | 'image' | 'data' | 'archive' | 'media' | 'other';
export type PreviewKind = 'image' | 'pdf' | 'markdown' | 'text' | 'audio' | 'video' | 'maybe-text';

const KIND_EXTS: Record<Exclude<FileKind, 'folder' | 'other'>, string[]> = {
  doc: ['md', 'markdown', 'txt', 'rtf', 'doc', 'docx', 'odt', 'pages', 'log', 'tex'],
  pdf: ['pdf'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'html', 'htm', 'css', 'scss', 'sql', 'swift', 'lua', 'vue', 'svelte'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic', 'tif', 'tiff'],
  data: ['json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'xml', 'xls', 'xlsx', 'ods', 'env', 'lock', 'db', 'sqlite', 'parquet'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'],
  media: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov', 'mkv', 'avi'],
};
const KIND_OF = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(KIND_EXTS)) for (const e of exts) KIND_OF.set(e, kind as FileKind);

export function fileKind(e: Pick<FileEntry, 'kind' | 'ext'>): FileKind {
  return e.kind === 'dir' ? 'folder' : KIND_OF.get(e.ext) ?? 'other';
}

// What a browser shows itself. HEIC and TIFF do not decode in Chromium, so they are not here.
const IMAGE_PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
// The hub's own text list (api/files.ts), plus formats that are text whatever their content type.
const TEXT_PREVIEW = new Set([
  'txt', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'env', 'json',
  'jsonl', 'lock', 'tex', 'swift', 'lua', 'vue', 'svelte', 'rtf', 'gitignore',
]);

/** How to preview it, or null when nothing short of the app that made it can (a .docx, a .zip). */
export function previewKind(e: Pick<FileEntry, 'ext' | 'size'>): PreviewKind | null {
  const x = e.ext;
  if (IMAGE_PREVIEW.has(x)) return 'image';
  if (x === 'pdf') return 'pdf';
  if (x === 'md' || x === 'markdown') return 'markdown';
  if (TEXT_PREVIEW.has(x)) return 'text';
  if (x === 'mp3' || x === 'wav' || x === 'ogg' || x === 'm4a' || x === 'flac') return 'audio';
  if (x === 'mp4' || x === 'webm' || x === 'mov') return 'video';
  // README, LICENSE, Dockerfile and the like: tried as text, and refused if they turn out to be binary.
  if (!x || !KIND_OF.has(x)) return e.size <= 2 * 1024 * 1024 ? 'maybe-text' : null;
  return null;
}

/** The badge on a file tile: the extension, short enough to fit. */
export function badgeText(e: Pick<FileEntry, 'ext'>): string {
  return e.ext ? e.ext.slice(0, 4).toUpperCase() : 'FILE';
}

/** Name and type, for a screen reader: "report.pdf, PDF". The tile shows the same through its shape. */
export const KIND_LABEL: Record<FileKind, string> = {
  folder: 'folder', doc: 'document', pdf: 'PDF', code: 'code', image: 'image', data: 'data', archive: 'archive', media: 'media', other: 'file',
};

export function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATE = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "14:05" today, "Nov 3" this year, "Nov 3, 2025" before. */
export function fmtModified(ms: number, now = new Date()): string {
  const d = new Date(ms);
  if (sameDay(d, now)) return TIME.format(d);
  return d.getFullYear() === now.getFullYear() ? DAY.format(d) : DATE.format(d);
}
export const fmtModifiedFull = (ms: number) => FULL.format(new Date(ms));

export const joinPath = (folder: string, name: string) => (folder ? folder + '/' + name : name);
export const parentPath = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Where a link in a message or a previewed Markdown file points, inside the room's folder. `base` is the folder
 * the link was written in ('' for chat). Returns null for a link that leaves the folder or that this cannot place;
 * an absolute path is passed back in `abs`, for the panel to match against the room's folder once it knows it.
 */
export function resolveFileLink(href: string, base = ''): { path: string; file?: string } | { abs: string } | null {
  let h = href.split('#')[0].split('?')[0];
  try { h = decodeURIComponent(h); } catch { /* keep it as written */ }
  h = h.replace(/^file:\/\/\/?/i, '').replaceAll('\\', '/');
  if (!h) return null;
  if (h.startsWith('/') || /^[A-Za-z]:\//.test(h)) return { abs: h };
  const dir = h.endsWith('/');
  const parts = base ? base.split('/') : [];
  for (const seg of h.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (dir || !parts.length) return { path: parts.join('/') };
  const file = parts.pop()!;
  return { path: parts.join('/'), file };
}
