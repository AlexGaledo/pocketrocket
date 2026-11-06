// The shapes in the Files panel: a folder, or a page with its corner folded and the extension on a badge. Colour
// says the type (doc, code, image...) through the --ft-* tokens; the badge says it in words, so colour is never
// the only cue.
import { memo } from 'react';
import {
  AlignLeft, Archive, Braces, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, Film, Folder, Image, Table,
  type LucideIcon,
} from 'lucide-react';
import type { FileEntry } from '@pocketrocket/shared';
import { cn } from '../ui';
import { badgeText, fileKind, type FileKind } from './fileKinds';

const TEXT: Record<FileKind, string> = {
  folder: 'text-ft-folder', doc: 'text-ft-doc', pdf: 'text-ft-pdf', code: 'text-ft-code', image: 'text-ft-image',
  data: 'text-ft-data', archive: 'text-ft-archive', media: 'text-ft-media', other: 'text-ft-other',
};
const FILL: Record<FileKind, string> = {
  folder: 'bg-ft-folder', doc: 'bg-ft-doc', pdf: 'bg-ft-pdf', code: 'bg-ft-code', image: 'bg-ft-image',
  data: 'bg-ft-data', archive: 'bg-ft-archive', media: 'bg-ft-media', other: 'bg-ft-other',
};
/** Inside the page on a tile. */
const GLYPH: Record<FileKind, LucideIcon> = {
  folder: Folder, doc: AlignLeft, pdf: FileText, code: Braces, image: Image, data: Table, archive: Archive, media: Film, other: File,
};
/** One small icon for a list row. */
const ROW_ICON: Record<FileKind, LucideIcon> = {
  folder: Folder, doc: FileText, pdf: FileText, code: FileCode, image: FileImage, data: FileSpreadsheet, archive: FileArchive, media: FileAudio, other: File,
};

/** The big shape on a grid tile, in a 72px-tall box. */
export const TileIcon = memo(function TileIcon({ entry }: { entry: Pick<FileEntry, 'kind' | 'ext'> }) {
  const kind = fileKind(entry);
  if (kind === 'folder') {
    return (
      <svg aria-hidden width="64" height="50" viewBox="0 0 64 50" className="drop-shadow-[0_1px_0_var(--line)]">
        <path d="M4 6a4 4 0 0 1 4-4h14.3a4 4 0 0 1 3 1.35L29 7.5h27a4 4 0 0 1 4 4V44a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" style={{ fill: 'color-mix(in oklab, var(--ft-folder) 78%, var(--fg))' }} />
        <rect x="4" y="13" width="56" height="35" rx="4" style={{ fill: 'var(--ft-folder)' }} />
      </svg>
    );
  }
  const Glyph = GLYPH[kind];
  return (
    <span aria-hidden className="relative block h-[60px] w-[48px]">
      <svg width="48" height="60" viewBox="0 0 48 60" className="absolute inset-0">
        <path d="M6 1.5h24.4L46.5 17.6V54A4.5 4.5 0 0 1 42 58.5H6A4.5 4.5 0 0 1 1.5 54V6A4.5 4.5 0 0 1 6 1.5z" style={{ fill: 'var(--card)', stroke: 'var(--line2)' }} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M30.4 1.5V13.6a4 4 0 0 0 4 4h12.1" style={{ fill: 'var(--card2)', stroke: 'var(--line2)' }} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <Glyph size={18} strokeWidth={2} className={cn('absolute left-[13px] top-[19px]', TEXT[kind])} />
      <span className={cn('absolute -left-2 bottom-1.5 min-w-7 rounded-xs px-1 text-center text-hint font-semibold tracking-wide text-on-fill', FILL[kind])}>
        {badgeText(entry)}
      </span>
    </span>
  );
});

/** The small icon at the start of a list row. */
export function RowIcon({ entry, size = 18 }: { entry: Pick<FileEntry, 'kind' | 'ext'>; size?: number }) {
  const kind = fileKind(entry);
  const Icon = kind === 'media' && /^(mp4|webm|mov|mkv|avi)$/.test(entry.ext) ? Film : ROW_ICON[kind];
  return <Icon aria-hidden size={size} strokeWidth={1.75} className={cn('shrink-0', TEXT[kind])} style={kind === 'folder' ? { fill: 'color-mix(in oklab, var(--ft-folder) 35%, transparent)' } : undefined} />;
}
