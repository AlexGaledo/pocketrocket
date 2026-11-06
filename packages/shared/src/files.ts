import { z } from 'zod';

// Room files: `/api/rooms/:id/files*` (hub/src/api/files.ts). Hub token only; a paired device is refused.

/** Which folder a room uses: its project's folder, its own folder under data/rooms, or the DM bot's files/ folder. */
export type RoomFolderKind = 'project' | 'room' | 'dm';

export interface FileEntry {
  name: string;
  kind: 'dir' | 'file';
  /** Bytes; 0 for a folder. */
  size: number;
  /** Last modified, epoch ms. */
  mtime: number;
  /** Lower-case extension without the dot ('md'), or '' for a folder or a file without one. */
  ext: string;
}

/** GET /api/rooms/:id/files?path= */
export interface FileListing {
  roomId: string;
  folder: RoomFolderKind;
  /** The linked project's slug, for folder 'project'. */
  projectSlug: string | null;
  /** The listed folder, relative to the room's folder, with '/' separators; '' is the room's folder itself. */
  path: string;
  /** Folders first, then files, each by name (natural, case-insensitive). `.git` is left out. */
  entries: FileEntry[];
  /** True when the folder held more than MAX_FILE_LIST_ENTRIES entries and the rest were left out. */
  truncated: boolean;
}

/** Most entries one listing returns. */
export const MAX_FILE_LIST_ENTRIES = 2000;
/** Biggest file GET /api/rooms/:id/files/raw sends, for previews and downloads alike. */
export const MAX_FILE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** Biggest file one upload may carry. It travels as base64 in JSON, so the route's body cap is about 4/3 of this. */
export const MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Longest file or folder name accepted. */
export const MAX_FILE_NAME_CHARS = 255;

/** A relative path inside the room's folder, '/' separated. The hub checks it again against the disk. */
const RelPath = z.string().max(4096);
/**
 * One file or folder name: no separators or control characters, not `.` or `..`, and no leading or trailing
 * space or trailing dot (Windows drops those silently, so the file would land under another name).
 */
export function isValidFileName(n: string): boolean {
  return (
    n.length > 0 && n.length <= MAX_FILE_NAME_CHARS && !/[\\/\u0000-\u001f]/.test(n) &&
    n !== '.' && n !== '..' && n.trim() === n && !n.endsWith('.')
  );
}
export const FileNameSchema = z.string().refine(isValidFileName, 'not a valid file name');

/**
 * POST /api/rooms/:id/files/upload. `path` is the folder to put it in. Refuses to overwrite unless `overwrite`.
 * With `parents`, any missing folder in `path` is made first (a folder upload), each name checked like a file name.
 */
export const FileUploadSchema = z.object({
  path: RelPath.default(''),
  name: FileNameSchema,
  dataBase64: z.string().max(Math.ceil(MAX_FILE_UPLOAD_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64'),
  overwrite: z.boolean().optional(),
  parents: z.boolean().optional(),
});
export type FileUploadInput = z.input<typeof FileUploadSchema>;

/**
 * POST /api/rooms/:id/files/folder. Makes `name` inside the folder `path`. With `parents` it works like `mkdir -p`:
 * missing folders in `path` are made too, and a folder already called `name` is fine.
 */
export const FileFolderSchema = z.object({ path: RelPath.default(''), name: FileNameSchema, parents: z.boolean().optional() });
export type FileFolderInput = z.input<typeof FileFolderSchema>;

/**
 * PATCH /api/rooms/:id/files. Renames or moves `from` to `to` (both relative to the room's folder). The target
 * must not exist, and the room's folder itself cannot be moved.
 */
export const FileRenameSchema = z.object({ from: RelPath.min(1), to: RelPath.min(1) });
export type FileRenameInput = z.input<typeof FileRenameSchema>;

/** Most files one folder upload sends. */
export const MAX_FOLDER_UPLOAD_FILES = 1000;
/** Most bytes, all files together, one folder upload sends. */
export const MAX_FOLDER_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Past this many files the app asks before a folder upload starts. */
export const FOLDER_UPLOAD_CONFIRM_FILES = 200;

const JUNK_DIRS = new Set(['.git', 'node_modules']);
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db']);
/** Names that usually hold keys. `.env.example` and friends are templates, not keys. */
const SECRET_RE = /^(\.env.*|id_(rsa|dsa|ecdsa|ed25519).*|service-account.*\.json|.+\.(pem|key|p8|p12|pfx))$/i;
const SECRET_OK_RE = /^\.env\.(example|sample|template)(\..*)?$/i;

/**
 * Why a folder upload leaves a file or folder out: 'junk' (version control, dependencies, OS litter, left out
 * quietly; a junk folder is not walked at all) or 'secret' (looks like a key file: left out, and the user told).
 * Null to keep it.
 */
export function folderUploadSkip(name: string, isDir: boolean): 'junk' | 'secret' | null {
  const lower = name.toLowerCase();
  if (isDir) return JUNK_DIRS.has(lower) ? 'junk' : null;
  if (JUNK_FILES.has(lower)) return 'junk';
  if (SECRET_RE.test(name) && !SECRET_OK_RE.test(name)) return 'secret';
  return null;
}

/** What every successful change answers: the path that changed, relative to the room's folder. */
export interface FileChangeResult {
  ok: true;
  path: string;
}
