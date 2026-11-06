// Folder uploads: turning a picked folder (<input webkitdirectory>) or a drop with folders in it into a flat list of
// files, each with its path relative to where it lands, plus the empty folders. Junk is left out quietly and files
// that look like keys are left out loudly (folderUploadSkip, shared with the hub's tests). The hub makes the
// folders on the way (`parents`) and is the authority on names and paths; this only sorts what to send.
import { MAX_FILE_UPLOAD_BYTES, MAX_FOLDER_UPLOAD_FILES, folderUploadSkip, isValidFileName } from '@pocketrocket/shared';

export interface PickedFile {
  /** '/' separated, relative to the folder being uploaded into: 'site/src/app.ts'. */
  rel: string;
  file: File;
}

export interface Gathered {
  files: PickedFile[];
  /** Every folder seen, relative like `rel`. The ones with no file under them are made empty. */
  dirs: string[];
  /** .git, node_modules, .DS_Store, Thumbs.db: left out without a word, beyond a count. */
  junk: number;
  /** Look like keys (.env, *.pem, id_rsa...): left out, and listed for the user. */
  secrets: string[];
  /** Names the hub can't store (a trailing dot, a control character). */
  badNames: string[];
  /** More than MAX_FOLDER_UPLOAD_FILES files to send; the walk stopped there. */
  overCap: boolean;
  /** Folders with anything under them, kept or left out: one holding only a .env or node_modules isn't made empty. */
  full: Set<string>;
}

/**
 * Whether this browser can pick a folder. iOS and Android show the attribute but pick files (or nothing), so the
 * option is hidden there; a drop works wherever the browser hands over folder entries.
 */
export const canPickFolder: boolean = (() => {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('webkitdirectory' in document.createElement('input'))) return false;
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return !/iPhone|iPad|iPod|Android/i.test(ua) && !iPadOS;
})();

class Collector {
  readonly g: Gathered = { files: [], dirs: [], junk: 0, secrets: [], badNames: [], overCap: false, full: new Set() };

  private mark(rel: string) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) this.g.full.add(parts.slice(0, i).join('/'));
  }

  /** False when the folder is left out (and so not walked). */
  dir(rel: string, name: string): boolean {
    if (folderUploadSkip(name, true)) { this.g.junk++; this.mark(rel); return false; }
    if (!isValidFileName(name)) { this.g.badNames.push(rel + '/'); this.mark(rel); return false; }
    this.g.dirs.push(rel);
    return true;
  }

  /** False once the cap is passed, to stop the walk. */
  file(rel: string, name: string, file: () => File | Promise<File>): boolean | Promise<boolean> {
    this.mark(rel);
    const skip = folderUploadSkip(name, false);
    if (skip === 'junk') { this.g.junk++; return true; }
    if (skip === 'secret') { this.g.secrets.push(rel); return true; }
    if (!isValidFileName(name)) { this.g.badNames.push(rel); return true; }
    if (this.g.files.length >= MAX_FOLDER_UPLOAD_FILES) { this.g.overCap = true; return false; }
    const f = file();
    if (f instanceof Promise) return f.then((got) => { this.g.files.push({ rel, file: got }); return true; });
    this.g.files.push({ rel, file: f });
    return true;
  }
}

/** From <input webkitdirectory>: each File knows its path ('site/src/app.ts'). Empty folders don't come through. */
export function gatherFromInput(picked: File[]): Gathered {
  const c = new Collector();
  const kept = new Set<string>();
  const dropped = new Set<string>();
  outer: for (const f of picked) {
    const parts = (f.webkitRelativePath || f.name).split('/').filter(Boolean);
    // Each folder on the way is judged once; a junk or badly named one leaves out everything under it.
    for (let i = 0; i < parts.length - 1; i++) {
      const rel = parts.slice(0, i + 1).join('/');
      if (dropped.has(rel)) continue outer;
      if (kept.has(rel)) continue;
      if (!c.dir(rel, parts[i])) { dropped.add(rel); continue outer; }
      kept.add(rel);
    }
    if (c.file(parts.join('/'), parts[parts.length - 1], () => f) === false) break;
  }
  return c.g;
}

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  // readEntries hands them over in batches (100 in Chrome) until an empty one.
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(out);
      out.push(...batch);
      next();
    }, reject);
    next();
  });
}
const fileOf = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

/**
 * From a drop: the entries (`DataTransferItem.webkitGetAsEntry()`, taken while the drop event was running) walked
 * depth first. Loose files in the drop land at the top, beside the folders.
 */
export async function gatherFromDrop(entries: FileSystemEntry[]): Promise<Gathered> {
  const c = new Collector();
  const walk = async (entry: FileSystemEntry, rel: string): Promise<boolean> => {
    if (entry.isDirectory) {
      if (!c.dir(rel, entry.name)) return true;
      const children = await readAll(entry as FileSystemDirectoryEntry);
      for (const child of children) if (!(await walk(child, rel + '/' + child.name))) return false;
      return true;
    }
    if (entry.isFile) return c.file(rel, entry.name, () => fileOf(entry as FileSystemFileEntry));
    return true;
  };
  for (const e of entries) if (!(await walk(e, e.name))) break;
  return c.g;
}

/** Folders with nothing at all under them: the ones the upload has to make on their own. */
export function emptyDirs(g: Gathered): string[] {
  const empty = g.dirs.filter((d) => !g.full.has(d));
  // Only the deepest: making a/b/c makes a and a/b too.
  return empty.filter((d) => !empty.some((o) => o.startsWith(d + '/')));
}

export const tooBig = (f: PickedFile) => f.file.size > MAX_FILE_UPLOAD_BYTES;

/** 'a/b/c.txt' to ['a/b', 'c.txt']. */
export function splitRel(rel: string): [string, string] {
  const i = rel.lastIndexOf('/');
  return i < 0 ? ['', rel] : [rel.slice(0, i), rel.slice(i + 1)];
}
