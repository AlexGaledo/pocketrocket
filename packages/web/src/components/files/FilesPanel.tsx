// The room's files, in the right panel: the chat's folder on the hub (its project's folder, the group's own folder,
// or a direct chat's bot's files/ folder). Browse, preview, download, upload, new folder, rename, delete.
// The hub's api/files.ts is the authority on paths and names; this checks names only to say what is wrong sooner.
import { memo, startTransition, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Download, Eye, FolderOpen, FolderPlus, FolderUp, LayoutGrid, List, Lock, MoreHorizontal, Pencil, Trash2, Upload, X } from 'lucide-react';
import {
  FOLDER_UPLOAD_CONFIRM_FILES, MAX_FILE_LIST_ENTRIES, MAX_FILE_UPLOAD_BYTES, MAX_FOLDER_UPLOAD_BYTES, MAX_FOLDER_UPLOAD_FILES, isValidFileName,
  type FileEntry, type FileListing, type Room,
} from '@pocketrocket/shared';
import { useStore, selectActiveRoom, botById, filesRevKey } from '../../store';
import { api, ApiError } from '../../lib/api';
import { Button, Dialog, DialogDescription, DialogShell, DialogTitle, Input, Menu, MenuContent, MenuItem, MenuSeparator, cn, confirmAction } from '../ui';
import { RowIcon, TileIcon } from './FileIcon';
import { FilePreview } from './FilePreview';
import { canPickFolder, emptyDirs, gatherFromDrop, gatherFromInput, splitRel, tooBig, type Gathered } from './folderUpload';
import { KIND_LABEL, baseName, fileKind, fmtBytes, fmtModified, fmtModifiedFull, joinPath, parentPath, resolveFileLink } from './fileKinds';

type View = 'grid' | 'list';
type SortKey = 'name' | 'size' | 'mtime';
interface Sort { key: SortKey; dir: 1 | -1 }

const VIEW_KEY = 'pocketrocket.files.view';
const SORT_KEY = 'pocketrocket.files.sort';

function readPref<T>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: it holds for this session */ }
}
const isView = (v: unknown): v is View => v === 'grid' || v === 'list';
const isSort = (v: unknown): v is Sort => !!v && typeof v === 'object' && ['name', 'size', 'mtime'].includes((v as Sort).key) && ((v as Sort).dir === 1 || (v as Sort).dir === -1);

/** A big folder paints this many at once; the rest follow in a transition, so the panel answers while they render. */
const FIRST_PAINT = 300;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first whatever the order, as the hub sends them. Name ascending is the hub's own order, so it is kept. */
function sortEntries(entries: FileEntry[], sort: Sort): FileEntry[] {
  if (sort.key === 'name' && sort.dir === 1) return entries;
  const by = sort.key === 'name' ? (a: FileEntry, b: FileEntry) => collator.compare(a.name, b.name)
    : sort.key === 'size' ? (a: FileEntry, b: FileEntry) => a.size - b.size || collator.compare(a.name, b.name)
    : (a: FileEntry, b: FileEntry) => a.mtime - b.mtime || collator.compare(a.name, b.name);
  return [...entries].sort((a, b) => (a.kind === b.kind ? by(a, b) * sort.dir : a.kind === 'dir' ? -1 : 1));
}

/**
 * Saves a fetched file the way a link with `download` would. Re-typed as octet-stream first, so the URL is only ever
 * something to save: were it opened as a page, a text/html or SVG type would run in the app's origin.
 */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // The click has started the download by now; a moment's grace for a slow browser, then the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

const message = (e: unknown) => (e as Error)?.message || 'Unknown error';
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : 0);

/**
 * The marker that ends the hub's path to this room's folder, to place an absolute path a bot wrote ("C:\…\projects\
 * equilife\docs\a.md") inside it. Null when the folder has no such name.
 */
function markerOf(l: FileListing): string | null {
  if (l.folder === 'project' && l.projectSlug) return '/projects/' + l.projectSlug + '/';
  if (l.folder === 'room') return '/rooms/' + l.roomId + '/';
  if (l.folder === 'dm') return '/files/';
  return null;
}

export function FilesPanel({ inline }: { inline: boolean }) {
  const room = useStore(selectActiveRoom);
  const device = useStore((s) => s.device);
  const ref = useRef<HTMLElement>(null);

  // Closing with focus inside (Escape, the X): back to the button that opened it rather than lost on <body>.
  useEffect(() => () => {
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('[data-files-toggle]')?.focus();
    });
  }, []);

  return (
    <aside ref={ref} aria-label="Files" className="@container panel flex min-h-0 w-full min-w-0 flex-col overflow-clip">
      {!room ? (
        <>
          <PanelHeader inline={inline} />
          <Notice icon={<FolderOpen size={28} aria-hidden />} title="No chat open">Open a chat to see its files.</Notice>
        </>
      ) : device ? (
        <>
          <PanelHeader inline={inline} />
          <PairedNotice />
        </>
      ) : (
        // Keyed: another chat is another folder, with its own place and selection.
        <Browser key={room.id} room={room} inline={inline} />
      )}
    </aside>
  );
}

function PanelHeader({ inline, subtitle, children }: { inline: boolean; subtitle?: ReactNode; children?: ReactNode }) {
  const closePanel = useStore((s) => s.closePanel);
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 px-3">
      <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-card2 text-muted"><FolderOpen size={15} /></span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-ui font-medium">Files</h2>
        {subtitle && <div className="truncate text-hint text-muted">{subtitle}</div>}
      </div>
      {children}
      <Button size="icon" variant="ghost" title={inline ? 'Close files' : 'Close files (Esc)'} aria-label="Close files" onClick={closePanel}><X size={16} /></Button>
    </div>
  );
}

function Notice({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 pb-10 text-center">
      <span className="mb-1 text-faint">{icon}</span>
      <p className="text-ui font-medium text-fg">{title}</p>
      {children && <p className="max-w-[38ch] text-ui leading-relaxed text-muted">{children}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** A paired phone is refused every file route (403), on purpose: files can hold anything, and phones get lost. */
function PairedNotice() {
  return (
    <Notice icon={<Lock size={28} aria-hidden />} title="Files open in the desktop app">
      This device is paired, so it can't see the hub's files. Open them in the PocketRocket app on the computer, or in a browser signed in with the hub token.
    </Notice>
  );
}

type Naming = { mode: 'mkdir' } | { mode: 'rename'; entry: FileEntry };

function Browser({ room, inline }: { room: Room; inline: boolean }) {
  const roomId = room.id;
  const toast = useStore((s) => s.toast);
  const target = useStore((s) => (s.filesTarget?.roomId === roomId ? s.filesTarget : null));
  const bots = useStore((s) => s.bots);
  const connected = useStore((s) => s.connected);

  const [path, setPath] = useState(() => target?.path ?? '');
  const rev = useStore((s) => s.filesRev[filesRevKey(roomId, path)] ?? 0);
  const [data, setData] = useState<{ path: string; listing: FileListing } | null>(null);
  const [error, setError] = useState<{ path: string; status: number; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const [view, setViewState] = useState<View>(() => readPref(VIEW_KEY, isView, 'grid'));
  // A transition: redrawing 2,000 items must not freeze the toggle that asked for it.
  const setView = (v: View) => { writePref(VIEW_KEY, v); startTransition(() => setViewState(v)); };
  const [sort, setSortState] = useState<Sort>(() => readPref(SORT_KEY, isSort, { key: 'name', dir: 1 }));
  const setSort = (key: SortKey) => {
    const next: Sort = { key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 };
    setSortState(next);
    writePref(SORT_KEY, next);
  };

  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);
  // The last menu stays rendered through its close, so its close handler still knows which item it was for.
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const shownMenu = menu ?? lastMenu.current;
  const afterMenu = useRef<(() => void) | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [uploading, setUploading] = useState<{ i: number; n: number; name: string; cancellable?: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const cancelled = useRef(false);
  const [report, setReport] = useState<{ where: string; skipped: Skipped[]; sent: number } | null>(null);
  const [asking, setAsking] = useState<{ clash: string[]; where: string; answer: (c: ExistingChoice) => void } | null>(null);
  const askExisting = useCallback((clash: string[], where: string) => new Promise<ExistingChoice>((resolve) => {
    setAsking({ clash, where, answer: (c) => { setAsking(null); resolve(c); } });
  }), []);

  const listRef = useRef<HTMLUListElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // React has no prop for it; set once the input is there.
  const folderInputRef = useCallback((el: HTMLInputElement | null) => {
    folderInput.current = el;
    if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); }
  }, []);
  /** What to focus once the next listing is in: a name, the first entry, or nothing (a background refresh). */
  const focusNext = useRef<string | null>('\u0000first');
  /** A file to preview (or an absolute path to place) once its folder has loaded, from a link. */
  const pendingFile = useRef<string | null>(target?.file ?? null);
  const busy = useRef(false);
  const hintId = useId();

  // ---- loading ----
  useEffect(() => {
    // Offline, the request would only fail; the reconnect asks again.
    if (!connected) return;
    let alive = true;
    api.files.list(roomId, path).then((listing) => {
      if (!alive) return;
      setData({ path, listing });
      setError(null);
    }).catch((e: unknown) => {
      if (alive) setError({ path, status: statusOf(e), message: message(e) });
    });
    return () => { alive = false; };
    // `connected`: a reconnect may have missed a files.changed, so the folder is asked again.
  }, [roomId, path, rev, nonce, connected]);

  const loading = !error && (!data || data.path !== path);
  const shownError = error?.path === path ? error : null;
  const listing = data?.path === path ? data.listing : null;
  const entries = useMemo(() => sortEntries(listing?.entries ?? [], sort), [listing, sort]);
  const files = useMemo(() => entries.filter((e) => e.kind === 'file'), [entries]);
  // Which folder has been drawn in full. Until then only the first FIRST_PAINT items are.
  const [allFor, setAllFor] = useState<string | null>(null);
  useEffect(() => {
    if (listing && allFor !== path) startTransition(() => setAllFor(path));
  }, [listing, path, allFor]);
  const shown = allFor === path || entries.length <= FIRST_PAINT ? entries : entries.slice(0, FIRST_PAINT);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pathRef = useRef(path);
  pathRef.current = path;

  const navigate = useCallback((p: string, focus: string | null = '\u0000first') => {
    setPath(p);
    setPreview(null);
    setMenu(null);
    setActive(null);
    focusNext.current = focus;
  }, []);
  const goUp = useCallback(() => { if (path) navigate(parentPath(path), baseName(path)); }, [path, navigate]);

  // A link clicked while the panel is open (or the one that opened it).
  const seq = target?.seq ?? 0;
  useEffect(() => {
    if (!seq || !target) return;
    pendingFile.current = target.file ?? null;
    if (target.path !== path) navigate(target.path);
    else setPreview(null);
    reload();
    // Only a new link counts; `path` moving on its own must not send the panel back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  const focusIndex = useCallback((i: number) => {
    const list = entriesRef.current;
    if (!list.length) return;
    const n = Math.max(0, Math.min(list.length - 1, i));
    setActive(list[n].name);
    const el = listRef.current?.querySelector<HTMLElement>('[data-idx="' + n + '"]');
    if (el) el.focus();
    // Past what is drawn yet (End, early on in a big folder): draw the rest now, then focus.
    else { setAllFor(pathRef.current); requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[data-idx="' + n + '"]')?.focus()); }
  }, []);
  const focusName = useCallback((name: string | null) => {
    const i = name ? entriesRef.current.findIndex((e) => e.name === name) : -1;
    requestAnimationFrame(() => (i >= 0 ? focusIndex(i) : listRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()));
  }, [focusIndex]);

  // After a listing comes in: focus where the user was headed, then any file a link pointed at.
  useLayoutEffect(() => {
    if (!listing) return;
    const want = focusNext.current;
    focusNext.current = null;
    if (want === '\u0000first') { if (entries.length) focusIndex(0); else listRef.current?.closest('aside')?.querySelector<HTMLElement>('[data-empty-action]')?.focus(); }
    else if (want) { const i = entries.findIndex((e) => e.name === want); if (i >= 0) focusIndex(i); }

    const file = pendingFile.current;
    if (!file) return;
    pendingFile.current = null;
    if (file.includes('/')) {
      const marker = markerOf(listing);
      const lower = file.toLowerCase();
      const at = marker ? lower.lastIndexOf(marker.toLowerCase()) : -1;
      const placed = at >= 0 ? resolveFileLink(file.slice(at + marker!.length)) : null;
      if (placed && 'path' in placed) {
        pendingFile.current = placed.file ?? null;
        if (placed.path !== path) navigate(placed.path, null);
        else reload();
      } else toast("That file is outside this chat's folder.");
      return;
    }
    const hit = entries.find((e) => e.name === file);
    if (!hit) toast("Couldn't find " + file + (path ? ' in ' + baseName(path) : " in this chat's folder") + '.');
    else if (hit.kind === 'dir') navigate(joinPath(path, hit.name));
    else { setActive(hit.name); setPreview(hit.name); }
  }, [listing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions ----
  const openEntry = useCallback((e: FileEntry) => {
    if (e.kind === 'dir') navigate(joinPath(path, e.name));
    else { setActive(e.name); setPreview(e.name); }
  }, [path, navigate]);

  const openMenu = useCallback((entry: FileEntry, at: { x: number; y: number }) => {
    setActive(entry.name);
    setMenu({ entry, ...at });
  }, []);

  const download = useCallback(async (e: FileEntry) => {
    try {
      saveBlob(await api.files.blob(roomId, joinPath(path, e.name), true), e.name);
    } catch (err) {
      toast(statusOf(err) === 413 ? e.name + ' is over 50 MB, too big to download from here.' : "Couldn't download " + e.name + ': ' + message(err), true);
    }
  }, [roomId, path, toast]);

  const remove = useCallback(async (e: FileEntry) => {
    const dir = e.kind === 'dir';
    const ok = await confirmAction({
      title: 'Delete ' + e.name + '?',
      body: dir ? "The folder and everything in it are deleted from the hub. Bots in this chat lose them too. This can't be undone." : "It's deleted from the hub, for the bots in this chat too. This can't be undone.",
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return focusName(e.name);
    try {
      await api.files.remove(roomId, joinPath(path, e.name), dir);
      const list = entriesRef.current;
      const i = list.findIndex((x) => x.name === e.name);
      focusNext.current = (list[i + 1] ?? list[i - 1])?.name ?? null;
      toast('Deleted ' + e.name);
      reload();
    } catch (err) {
      toast("Couldn't delete " + e.name + ': ' + message(err), true);
    }
  }, [roomId, path, toast, reload, focusName]);

  const submitName = async (name: string): Promise<string | null> => {
    if (!naming) return null;
    try {
      if (naming.mode === 'mkdir') await api.files.mkdir(roomId, path, name);
      else await api.files.rename(roomId, joinPath(path, naming.entry.name), joinPath(path, name));
    } catch (err) {
      return statusOf(err) === 409 ? 'Something here already has that name.' : message(err);
    }
    focusNext.current = name;
    setNaming(null);
    reload();
    return null;
  };

  const upload = useCallback(async (picked: File[]) => {
    if (!picked.length) return;
    if (busy.current) return toast('Wait for the upload in progress to finish.');
    busy.current = true;
    const into = path;
    const where = into ? baseName(into) : "this chat's folder";
    const done: string[] = [];
    try {
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i];
        if (!isValidFileName(f.name)) { toast('Skipped ' + f.name + ": the hub can't store a file by that name.", true); continue; }
        if (f.size > MAX_FILE_UPLOAD_BYTES) { toast(f.name + " is over 25 MB, so it wasn't uploaded.", true); continue; }
        setUploading({ i: i + 1, n: picked.length, name: f.name });
        try {
          await api.files.uploadFile(roomId, into, f);
          done.push(f.name);
        } catch (err) {
          if (statusOf(err) !== 409) { toast("Couldn't upload " + f.name + ': ' + message(err), true); continue; }
          const replace = await confirmAction({ title: 'Replace ' + f.name + '?', body: 'A file with that name is already in ' + where + '. Replacing it overwrites it.', confirmLabel: 'Replace', danger: true });
          if (!replace) continue;
          try {
            await api.files.uploadFile(roomId, into, f, true);
            done.push(f.name);
          } catch (err2) {
            toast("Couldn't upload " + f.name + ': ' + message(err2), true);
          }
        }
      }
    } finally {
      busy.current = false;
      setUploading(null);
    }
    if (!done.length) return;
    toast(done.length === 1 ? 'Uploaded ' + done[0] : 'Uploaded ' + done.length + ' files');
    focusNext.current = done.length === 1 ? done[0] : null;
    reload();
  }, [roomId, path, toast, reload]);

  /**
   * A folder (or a drop with folders in it): one question up front for anything already there, then each file in
   * turn with its folders made on the way, then the empty folders. Cancel stops before the next file.
   */
  const uploadTree = useCallback(async (gather: () => Gathered | Promise<Gathered>) => {
    if (busy.current) return toast('Wait for the upload in progress to finish.');
    busy.current = true;
    cancelled.current = false;
    const into = path;
    const where = into ? baseName(into) : "this chat's folder";
    const skipped: Skipped[] = [];
    let sent = 0;
    let made = 0;
    let top: string | null = null;
    try {
      setUploading({ i: 0, n: 0, name: 'Reading the folder', cancellable: true });
      let g: Gathered;
      try { g = await gather(); } catch (err) { return toast("Couldn't read that folder: " + message(err), true); }
      if (cancelled.current) return;
      if (g.secrets.length) {
        toast('Left out ' + g.secrets.length + (g.secrets.length === 1 ? ' file that looks' : ' files that look') + ' like keys or secrets: ' + listSome(g.secrets.map((s) => baseName(s)), 6) + '. Upload one on its own if the bots need it.', false, { warn: true, sticky: true, key: 'files:secrets-left-out' });
      }
      const empty = emptyDirs(g);
      for (const b of g.badNames) skipped.push({ rel: b, why: "the hub can't store a name like that" });
      if (g.overCap) return toast('That folder has more than ' + MAX_FOLDER_UPLOAD_FILES.toLocaleString() + " files to upload, so nothing was sent. Zip it, or upload the parts you need.", true);
      let fits = g.files.filter((f) => !tooBig(f));
      for (const f of g.files) if (tooBig(f)) skipped.push({ rel: f.rel, why: 'over 25 MB' });
      const bytes = fits.reduce((s, f) => s + f.file.size, 0);
      if (bytes > MAX_FOLDER_UPLOAD_BYTES) return toast('That folder is ' + fmtBytes(bytes) + ', over the 500 MB a folder upload can carry, so nothing was sent.', true);
      if (!fits.length && !empty.length) {
        if (skipped.length) setReport({ where, skipped, sent: 0 });
        else toast(g.secrets.length || g.junk ? 'Nothing left to upload once secrets and clutter were left out.' : 'Nothing to upload: the folder is empty.');
        return;
      }
      top = [...fits.map((f) => f.rel), ...empty][0].split('/')[0];
      if (fits.length > FOLDER_UPLOAD_CONFIRM_FILES) {
        const ok = await confirmAction({ title: 'Upload ' + fits.length.toLocaleString() + ' files?', body: fmtBytes(bytes) + ' into ' + where + '. You can cancel part way; what is sent by then stays.', confirmLabel: 'Upload' });
        if (!ok) return;
      }

      setUploading({ i: 0, n: fits.length, name: 'Checking what is already there', cancellable: true });
      const clash = await existingIn(roomId, into, fits.map((f) => f.rel), () => cancelled.current);
      if (cancelled.current) return;
      let replace = false;
      let kept = 0;
      if (clash.length) {
        const choice = await askExisting(clash, where);
        if (choice === 'cancel') return;
        replace = choice === 'replace';
        if (!replace) {
          const there = new Set(clash);
          fits = fits.filter((f) => !there.has(f.rel));
          kept = clash.length;
        }
      }

      for (let i = 0; i < fits.length; i++) {
        if (cancelled.current) break;
        const f = fits[i];
        setUploading({ i: i + 1, n: fits.length, name: f.rel, cancellable: true });
        const [dir, name] = splitRel(f.rel);
        try {
          await api.files.uploadFile(roomId, joinPath(into, dir), f.file, replace, true, name);
          sent++;
        } catch (err) {
          // Already there though the check missed it (another case, a race): what "skip" would have done.
          skipped.push({ rel: f.rel, why: statusOf(err) === 409 ? 'already there' : message(err) });
        }
      }
      for (const d of empty) {
        if (cancelled.current) break;
        const [parent, name] = splitRel(d);
        try { await api.files.mkdir(roomId, joinPath(into, parent), name, true); made++; } catch (err) { skipped.push({ rel: d + '/', why: message(err) }); }
      }
      const what = sent + ' of ' + fits.length + (fits.length === 1 ? ' file' : ' files');
      if (cancelled.current) toast('Upload cancelled. ' + what + ' went up before it stopped.');
      else if (sent || made) toast('Uploaded ' + (sent ? sent + (sent === 1 ? ' file' : ' files') : made + (made === 1 ? ' empty folder' : ' empty folders')) + ' to ' + where + (kept ? ', kept ' + kept + ' already there' : '') + '.');
      else if (kept) toast('Nothing uploaded: all ' + kept + ' files were already there.');
      if (skipped.length) setReport({ where, skipped, sent });
    } finally {
      busy.current = false;
      cancelled.current = false;
      setUploading(null);
      if (sent || made) {
        focusNext.current = top;
        reload();
      }
    }
  }, [roomId, path, toast, reload, askExisting]);

  // ---- keyboard ----
  const cols = () => {
    const items = listRef.current?.children;
    if (!items?.length || view === 'list') return 1;
    const top = (items[0] as HTMLElement).offsetTop;
    let n = 0;
    for (const el of Array.from(items)) {
      if ((el as HTMLElement).offsetTop !== top) break;
      n++;
    }
    return Math.max(1, n);
  };
  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const idx = Number((e.target as HTMLElement).dataset.idx);
    if (Number.isNaN(idx)) return;
    const entry = entries[idx];
    const len = entries.length;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      openMenu(entry, { x: r.left + 8, y: r.bottom - 4 });
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); setNaming({ mode: 'rename', entry }); return; }
    if (e.key === 'Delete') { e.preventDefault(); void remove(entry); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const c = cols();
    let next = -1;
    if (e.key === 'ArrowRight' && view === 'grid') next = idx + 1;
    else if (e.key === 'ArrowLeft' && view === 'grid') next = idx - 1;
    else if (e.key === 'ArrowDown') next = idx + c >= len && Math.floor(idx / c) < Math.floor((len - 1) / c) ? len - 1 : idx + c;
    else if (e.key === 'ArrowUp') next = idx - c;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = len - 1;
    else if (e.key === 'PageDown') next = Math.min(len - 1, idx + c * 5);
    else if (e.key === 'PageUp') next = Math.max(0, idx - c * 5);
    else return;
    e.preventDefault();
    if (next >= 0 && next < len) focusIndex(next);
  };
  // Backspace and Alt+Up go up a folder from anywhere in the panel, except a field (and a dialog in a portal).
  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!e.currentTarget.contains(t) || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
    if (e.key === 'Backspace' || (e.key === 'ArrowUp' && e.altKey)) {
      if (!path) return;
      e.preventDefault();
      goUp();
    }
  };

  // ---- drag and drop ----
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e) || shownError) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    if (shownError) return;
    // The entries have to be taken now: the drop's data is gone once this handler returns.
    const entries = Array.from(e.dataTransfer.items).filter((it) => it.kind === 'file').map((it) => it.webkitGetAsEntry?.() ?? null);
    if (entries.some((en) => en?.isDirectory)) {
      const all = entries.filter((en): en is FileSystemEntry => !!en);
      void uploadTree(() => gatherFromDrop(all));
    } else void upload(Array.from(e.dataTransfer.files));
  };

  // ---- view ----
  const rootLabel = room.kind === 'dm' ? (botById(bots, room.memberIds[0])?.name ?? room.name) : room.name;
  const kindLabel = !listing ? undefined
    : listing.folder === 'project' ? 'Project folder' + (listing.projectSlug ? ' · ' + listing.projectSlug : '')
    : listing.folder === 'dm' ? rootLabel + "'s folder" : "This group's folder";
  const here = path ? baseName(path) : rootLabel;
  const previewIndex = preview ? files.findIndex((f) => f.name === preview) : -1;

  if (shownError?.status === 403) {
    return (<><PanelHeader inline={inline} /><PairedNotice /></>);
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={onPanelKey}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}
    >
      <PanelHeader inline={inline} subtitle={kindLabel}>
        <div role="group" aria-label="View" className="flex shrink-0 rounded-md bg-card2 p-0.5">
          <ViewButton on={view === 'grid'} label="Grid" onClick={() => setView('grid')}><LayoutGrid size={14} /></ViewButton>
          <ViewButton on={view === 'list'} label="List" onClick={() => setView('list')}><List size={14} /></ViewButton>
        </div>
      </PanelHeader>

      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
        <Breadcrumbs rootLabel={rootLabel} path={path} onGo={navigate} />
        <Button size="sm" variant="ghost" className="shrink-0 text-fg" title="New folder" aria-label="New folder" disabled={!!shownError} onClick={() => setNaming({ mode: 'mkdir' })}>
          <FolderPlus size={15} aria-hidden /><span className="@max-[440px]:sr-only">New folder</span>
        </Button>
        {canPickFolder && (
          <Button size="sm" variant="ghost" className="shrink-0 text-fg" title={'Upload a folder to ' + here + ' (or drop one here)'} aria-label="Upload folder" disabled={!!shownError || !!uploading} onClick={() => folderInput.current?.click()}>
            <FolderUp size={15} aria-hidden /><span className="@max-[520px]:sr-only">Upload folder</span>
          </Button>
        )}
        <Button size="sm" className="shrink-0" title={'Upload to ' + here + ' (or drop files here)'} aria-label="Upload files" disabled={!!shownError || !!uploading} onClick={() => fileInput.current?.click()}>
          <Upload size={15} aria-hidden /><span className="@max-[440px]:sr-only">Upload</span>
        </Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        {canPickFolder && (
          <input ref={folderInputRef} type="file" multiple hidden onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; void uploadTree(() => gatherFromInput(picked)); }} />
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {shownError ? (
          shownError.status === 404 && path ? (
            <Notice icon={<FolderOpen size={28} aria-hidden />} title="This folder is gone" action={<Button onClick={() => navigate('')}>Go to {rootLabel}</Button>}>
              It may have been moved, renamed or deleted.
            </Notice>
          ) : (
            <Notice icon={<FolderOpen size={28} aria-hidden />} title="Couldn't load files" action={<Button onClick={reload}>Try again</Button>}>
              {shownError.message}
            </Notice>
          )
        ) : loading ? (
          <Skeleton view={view} />
        ) : !entries.length ? (
          <Notice
            icon={<FolderOpen size={28} aria-hidden />}
            title={path ? 'This folder is empty' : 'No files yet'}
            action={<>
              <Button data-empty-action onClick={() => fileInput.current?.click()}><Upload size={14} aria-hidden />Upload files</Button>
              {canPickFolder && <Button onClick={() => folderInput.current?.click()}><FolderUp size={14} aria-hidden />Upload folder</Button>}
            </>}
          >
            {path ? 'Drop files or folders here, or upload them.' : "Files the bots in this chat make show up here. Drop files or folders here to share them with the bots."}
          </Notice>
        ) : (
          <>
            {view === 'list' && <ListHeader sort={sort} onSort={setSort} />}
            <p id={hintId} className="sr-only">Arrow keys move between items. Enter opens. Backspace goes up a folder. F2 renames, Delete deletes, Shift+F10 shows more actions.</p>
            <ul
              ref={listRef}
              role="list"
              aria-label={'Contents of ' + here}
              aria-describedby={hintId}
              onKeyDown={onListKey}
              className={cn(view === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1 px-2 pb-3 pt-1' : 'flex flex-col px-2 pb-3')}
            >
              {shown.map((e, i) => (
                <Item key={e.name} entry={e} idx={i} view={view} tabbable={active ? e.name === active : i === 0} onOpen={openEntry} onMenu={openMenu} />
              ))}
            </ul>
          </>
        )}
      </div>

      {(listing || uploading) && (
        <div className="relative flex shrink-0 items-center gap-2 border-t border-line px-4 py-1.5 text-hint text-muted">
          {/* Still, no transition: it moves one file at a time. */}
          {uploading?.cancellable && uploading.n > 0 && (
            <span aria-hidden className="absolute left-0 top-[-1px] h-0.5 bg-accent" style={{ width: (uploading.i / uploading.n) * 100 + '%' }} />
          )}
          <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate">
            {uploading
              ? uploading.n === 0 ? uploading.name + '…' : 'Uploading ' + (uploading.n > 1 ? uploading.i + ' of ' + uploading.n + ': ' : '') + uploading.name + '…'
              : listing && countLabel(listing)}
          </span>
          {uploading?.cancellable && (
            <Button size="sm" variant="ghost" className="-my-1 -mr-2 h-6 shrink-0 text-fg" onClick={() => { cancelled.current = true; setUploading((u) => u && { ...u, name: 'Stopping after this file', n: 0, cancellable: false }); }}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {dragging && (
        <div aria-hidden className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-panel/90">
          <span className="flex items-center gap-2 text-ui font-medium text-fg"><Upload size={16} className="text-accent" />Drop to upload to {here}</span>
        </div>
      )}

      <Menu.Root open={!!menu} onOpenChange={(o) => { if (!o) setMenu(null); }}>
        <Menu.Trigger asChild>
          <span aria-hidden className="pointer-events-none fixed h-0 w-0" style={{ left: shownMenu?.x ?? 0, top: shownMenu?.y ?? 0 }} />
        </Menu.Trigger>
        {shownMenu && (
          <MenuContent
            align="start"
            aria-label={'Actions for ' + shownMenu.entry.name}
            // The chosen action runs once the menu has let go of focus, so a dialog it opens keeps the focus it
            // takes. With no action (Escape, a click outside), focus goes back to the item.
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const run = afterMenu.current;
              afterMenu.current = null;
              if (run) run();
              else focusName(shownMenu.entry.name);
            }}
          >
            <MenuItem onSelect={() => { afterMenu.current = () => openEntry(shownMenu.entry); }}>
              {shownMenu.entry.kind === 'dir' ? <FolderOpen size={14} aria-hidden /> : <Eye size={14} aria-hidden />}{shownMenu.entry.kind === 'dir' ? 'Open' : 'Preview'}
            </MenuItem>
            {shownMenu.entry.kind === 'file' && (
              <MenuItem onSelect={() => { afterMenu.current = () => { focusName(shownMenu.entry.name); void download(shownMenu.entry); }; }}><Download size={14} aria-hidden />Download</MenuItem>
            )}
            <MenuItem onSelect={() => { afterMenu.current = () => setNaming({ mode: 'rename', entry: shownMenu.entry }); }}><Pencil size={14} aria-hidden />Rename</MenuItem>
            <MenuSeparator />
            <MenuItem className="text-bad" onSelect={() => { afterMenu.current = () => void remove(shownMenu.entry); }}><Trash2 size={14} aria-hidden />Delete</MenuItem>
          </MenuContent>
        )}
      </Menu.Root>

      {naming && (
        <NameDialog
          naming={naming}
          taken={entries}
          onSubmit={submitName}
          onClose={() => { const was = naming.mode === 'rename' ? naming.entry.name : null; setNaming(null); focusName(was); }}
        />
      )}
      {previewIndex >= 0 && (
        <FilePreview
          roomId={roomId}
          folder={path}
          files={files}
          index={previewIndex}
          onIndex={(i) => { setPreview(files[i].name); setActive(files[i].name); }}
          onClose={() => { const was = preview; setPreview(null); focusName(was); }}
          onDownload={download}
        />
      )}
      {asking && <ExistingDialog clash={asking.clash} where={asking.where} onAnswer={asking.answer} />}
      {report && <SkippedDialog {...report} onClose={() => setReport(null)} />}
    </div>
  );
}

type ExistingChoice = 'replace' | 'skip' | 'cancel';
interface Skipped { rel: string; why: string }

/** "a, b, c and 4 more" */
function listSome(names: string[], n: number): string {
  return names.length <= n ? names.join(', ') : names.slice(0, n).join(', ') + ' and ' + (names.length - n) + ' more';
}

/**
 * Which of `rels` (relative to `into`) are already files there. Walks only the folders the upload shares with what
 * is on the hub: a folder that isn't there yet has nothing in it to clash with. A listing that fails counts as no
 * clash; the upload's own 409 is the backstop.
 */
async function existingIn(roomId: string, into: string, rels: string[], stop: () => boolean): Promise<string[]> {
  const tree = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  const node = (d: string) => {
    let n = tree.get(d);
    if (!n) tree.set(d, (n = { files: new Set(), dirs: new Set() }));
    return n;
  };
  for (const rel of rels) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length - 1; i++) node(parts.slice(0, i).join('/')).dirs.add(parts[i]);
    node(parts.slice(0, -1).join('/')).files.add(parts[parts.length - 1]);
  }
  const out: string[] = [];
  const queue = [''];
  while (queue.length && !stop()) {
    const d = queue.shift()!;
    const n = tree.get(d);
    if (!n) continue;
    let listing: FileListing;
    try { listing = await api.files.list(roomId, d ? joinPath(into, d) : into); } catch { continue; }
    for (const e of listing.entries) {
      const rel = d ? d + '/' + e.name : e.name;
      if (e.kind === 'file' && n.files.has(e.name)) out.push(rel);
      else if (e.kind === 'dir' && n.dirs.has(e.name)) queue.push(rel);
    }
  }
  return out;
}

/** Asked once for a whole folder upload, not once per file. Cancel comes first, so a stray Enter sends nothing. */
function ExistingDialog({ clash, where, onAnswer }: { clash: string[]; where: string; onAnswer: (c: ExistingChoice) => void }) {
  const one = clash.length === 1;
  return (
    <DialogShell open onOpenChange={(o) => { if (!o) onAnswer('cancel'); }} hasDescription role="alertdialog" className="w-[440px] p-6">
      <DialogTitle>{one ? '1 file is already there' : clash.length.toLocaleString() + ' files are already there'}</DialogTitle>
      <DialogDescription className="mt-2 text-ui leading-relaxed text-muted">
        {one ? clash[0] + ' is' : 'Files with the same names are'} already in {where}. Replace {one ? 'it' : 'them all'} with the uploaded {one ? 'copy' : 'copies'}, or keep what's there and upload the rest.
      </DialogDescription>
      {!one && (
        <ul className="mt-3 max-h-32 overflow-y-auto rounded-md bg-card2 px-3 py-2 font-mono text-hint text-muted">
          {clash.slice(0, 50).map((c) => <li key={c} className="truncate" title={c}>{c}</li>)}
          {clash.length > 50 && <li>and {clash.length - 50} more</li>}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button onClick={() => onAnswer('cancel')}>Cancel</Button>
        <Button onClick={() => onAnswer('skip')}>Skip existing</Button>
        <Button variant="danger" onClick={() => onAnswer('replace')}>{one ? 'Replace' : 'Replace all'}</Button>
      </div>
    </DialogShell>
  );
}

/** What a folder upload left behind, and why: over 25 MB, a name the hub can't store, a failure. */
function SkippedDialog({ where, skipped, sent, onClose }: { where: string; skipped: Skipped[]; sent: number; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={skipped.length === 1 ? "1 item wasn't uploaded" : skipped.length.toLocaleString() + " items weren't uploaded"}>
      <p className="text-ui leading-relaxed text-muted">
        {sent ? sent.toLocaleString() + (sent === 1 ? ' file' : ' files') + ' went up to ' + where + '. ' : ''}These were left out:
      </p>
      <ul className="mt-3 max-h-64 overflow-y-auto rounded-md bg-card2 px-3 py-2">
        {skipped.map((s) => (
          <li key={s.rel} className="flex items-baseline gap-3 py-0.5 text-hint">
            <span className="min-w-0 flex-1 truncate font-mono text-fg" title={s.rel}>{s.rel}</span>
            <span className="shrink-0 text-muted">{s.why}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" autoFocus onClick={onClose}>Done</Button>
      </div>
    </Dialog>
  );
}

function countLabel(l: FileListing): string {
  const folders = l.entries.filter((e) => e.kind === 'dir').length;
  const files = l.entries.length - folders;
  const parts = [folders && folders + (folders === 1 ? ' folder' : ' folders'), files && files + (files === 1 ? ' file' : ' files')].filter(Boolean);
  const said = parts.length ? parts.join(', ') : 'Empty';
  return l.truncated ? 'Showing the first ' + MAX_FILE_LIST_ENTRIES.toLocaleString() + ' items. ' + said + ' shown.' : said;
}

function ViewButton({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label + ' view'}
      title={label}
      onClick={onClick}
      className={cn('flex h-7 w-7 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', on ? 'bg-panel text-fg shadow-[var(--shadow-sm)]' : 'text-muted hover:text-fg')}
    >
      {children}
    </button>
  );
}

/** Room, then each folder. Deep paths keep the first and the last two, with the rest behind one "…". */
function Breadcrumbs({ rootLabel, path, onGo }: { rootLabel: string; path: string; onGo: (p: string, focus?: string | null) => void }) {
  const segs = path ? path.split('/') : [];
  const crumbs = [{ label: rootLabel, path: '' }, ...segs.map((s, i) => ({ label: s, path: segs.slice(0, i + 1).join('/') }))];
  const hidden = crumbs.length > 4 ? crumbs.slice(1, -2) : [];
  const shown = hidden.length ? [crumbs[0], null, ...crumbs.slice(-2)] : crumbs;
  // Going up lands on the folder you came out of.
  const childOf = (p: string) => { const rest = path.slice(p ? p.length + 1 : 0); return rest.split('/')[0] || null; };
  return (
    <nav aria-label="Folder path" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center">
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          return (
            <li key={c ? c.path || '\u0000root' : '\u0000more'} className={cn('flex items-center', last ? 'min-w-0 shrink' : 'min-w-0 shrink-[2]')}>
              {i > 0 && <ChevronRight size={13} aria-hidden className="shrink-0 text-faint" />}
              {c ? (
                <button
                  type="button"
                  aria-current={last ? 'location' : undefined}
                  title={c.label}
                  onClick={() => !last && onGo(c.path, childOf(c.path))}
                  className={cn('min-w-0 truncate rounded-sm px-1.5 py-1 text-left text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', last ? 'font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
                >
                  {c.label}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={'Up to ' + hidden[hidden.length - 1].label}
                  title={hidden.map((h) => h.label).join(' / ')}
                  onClick={() => onGo(hidden[hidden.length - 1].path, childOf(hidden[hidden.length - 1].path))}
                  className="shrink-0 rounded-sm px-1.5 py-1 text-ui text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  …
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ListHeader({ sort, onSort }: { sort: Sort; onSort: (k: SortKey) => void }) {
  const col = (key: SortKey, label: string, className: string) => {
    const on = sort.key === key;
    const Arrow = sort.dir === 1 ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        onClick={() => onSort(key)}
        aria-label={'Sort by ' + label.toLowerCase() + (on ? (sort.dir === 1 ? ', ascending' : ', descending') : '')}
        aria-pressed={on}
        className={cn('flex items-center gap-1 rounded-sm px-1 py-0.5 text-hint hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', on ? 'text-fg' : 'text-muted', className)}
      >
        {label}{on && <Arrow size={12} aria-hidden />}
      </button>
    );
  };
  return (
    <div className="sticky top-0 z-[1] mx-2 grid grid-cols-[minmax(0,1fr)_64px_84px_32px] items-center gap-2 border-b border-line bg-bg py-1 pl-2.5 @max-[360px]:grid-cols-[minmax(0,1fr)_84px_32px]">
      {col('name', 'Name', 'justify-self-start')}
      {col('size', 'Size', 'justify-self-end @max-[360px]:hidden')}
      {col('mtime', 'Modified', 'justify-self-end')}
      <span />
    </div>
  );
}

/**
 * One file or folder. Memoised, with stable handlers, so moving focus re-renders two items and not two thousand.
 * The tile itself is the roving tab stop; its "more" button is for the pointer (the keyboard has Shift+F10).
 */
const Item = memo(function Item({ entry, idx, view, tabbable, onOpen, onMenu }: {
  entry: FileEntry; idx: number; view: View; tabbable: boolean;
  onOpen: (e: FileEntry) => void; onMenu: (e: FileEntry, at: { x: number; y: number }) => void;
}) {
  const dir = entry.kind === 'dir';
  const label = entry.name + ', ' + KIND_LABEL[fileKind(entry)] + (dir ? '' : ', ' + fmtBytes(entry.size)) + ', modified ' + fmtModifiedFull(entry.mtime);
  const common = {
    'data-idx': idx,
    tabIndex: tabbable ? 0 : -1,
    'aria-label': label,
    onClick: () => onOpen(entry),
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onMenu(entry, { x: e.clientX, y: e.clientY }); },
  };
  const more = (
    <button
      type="button"
      tabIndex={-1}
      aria-label={'More actions for ' + entry.name}
      title="More"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(entry, { x: r.left, y: r.bottom }); }}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-active hover:text-fg',
        'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9',
      )}
    >
      <MoreHorizontal size={15} aria-hidden />
    </button>
  );
  if (view === 'grid') {
    return (
      <li className="file-tile group relative">
        <button
          type="button"
          {...common}
          title={entry.name}
          className="flex w-full flex-col items-center gap-2 rounded-lg px-1.5 pb-2.5 pt-3 text-center hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="flex h-[64px] items-end justify-center"><TileIcon entry={entry} /></span>
          <span className="line-clamp-2 w-full text-ui leading-[18px] [overflow-wrap:anywhere]">{entry.name}</span>
        </button>
        <div className="absolute right-0.5 top-0.5">{more}</div>
      </li>
    );
  }
  return (
    <li className="file-row group relative">
      <button
        type="button"
        {...common}
        title={entry.name}
        className="grid h-10 w-full grid-cols-[minmax(0,1fr)_64px_84px_32px] items-center gap-2 rounded-md pl-2.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent @max-[360px]:grid-cols-[minmax(0,1fr)_84px_32px]"
      >
        <span className="flex min-w-0 items-center gap-2.5"><RowIcon entry={entry} /><span className="min-w-0 truncate text-ui">{entry.name}</span></span>
        <span className="justify-self-end text-hint tabular-nums text-muted @max-[360px]:hidden">{dir ? '' : fmtBytes(entry.size)}</span>
        <span className="justify-self-end text-hint tabular-nums text-muted">{fmtModified(entry.mtime)}</span>
        <span />
      </button>
      <div className="absolute right-0.5 top-1/2 -translate-y-1/2">{more}</div>
    </li>
  );
});

function Skeleton({ view }: { view: View }) {
  // Still, not pulsing: motion here is kept to the app's three effects.
  return (
    <div role="status" aria-label="Loading files" className={cn(view === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1 px-2 pt-1' : 'flex flex-col gap-1 px-2 pt-1')}>
      {Array.from({ length: view === 'grid' ? 8 : 7 }, (_, i) => view === 'grid' ? (
        <div key={i} className="flex flex-col items-center gap-2 px-1.5 pb-2.5 pt-3">
          <div className="h-[56px] w-[48px] rounded-md bg-card2" />
          <div className="h-3 w-3/4 rounded-xs bg-card2" />
        </div>
      ) : (
        <div key={i} className="flex h-10 items-center gap-2.5 pl-2.5">
          <div className="h-[18px] w-[18px] rounded-xs bg-card2" />
          <div className="h-3 rounded-xs bg-card2" style={{ width: 40 + ((i * 37) % 45) + '%' }} />
        </div>
      ))}
    </div>
  );
}

/** New folder, or rename. The name is checked as it is typed; the hub has the last word (a race, a 409). */
function NameDialog({ naming, taken, onSubmit, onClose }: {
  naming: Naming;
  taken: FileEntry[];
  onSubmit: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const initial = naming.mode === 'rename' ? naming.entry.name : '';
  const [name, setName] = useState(initial);
  const [serverError, setServerError] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const trimmed = name.trim();
  const clash = trimmed.toLowerCase() !== initial.toLowerCase() && taken.some((e) => e.name.toLowerCase() === trimmed.toLowerCase());
  const problem = !trimmed ? ''
    : !isValidFileName(trimmed) ? (/[\\/]/.test(trimmed) ? "A name can't contain / or \\." : trimmed.endsWith('.') ? "A name can't end with a dot." : "That name isn't allowed.")
    : clash ? 'Something here already has that name.' : '';
  const shownError = problem || serverError;

  // A file's name is selected up to its extension, so typing replaces the name and keeps the type. On the first
  // focus, a frame later: the dialog's own autofocus selects the whole field right after focusing it.
  const selected = useRef(false);
  const preselect = () => {
    if (selected.current) return;
    selected.current = true;
    const dot = naming.mode === 'rename' && naming.entry.kind === 'file' ? initial.lastIndexOf('.') : -1;
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(0, dot > 0 ? dot : initial.length));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || problem || sending) return;
    if (trimmed === initial) return onClose();
    setSending(true);
    const err = await onSubmit(trimmed);
    setSending(false);
    if (err) setServerError(err);
  };

  const title = naming.mode === 'mkdir' ? 'New folder' : 'Rename ' + (naming.entry.kind === 'dir' ? 'folder' : 'file');
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={title}>
      <form onSubmit={submit}>
        <Input
          ref={inputRef}
          aria-label={naming.mode === 'mkdir' ? 'Folder name' : 'New name'}
          aria-invalid={!!shownError || undefined}
          aria-describedby={shownError ? errorId : undefined}
          placeholder={naming.mode === 'mkdir' ? 'Folder name' : undefined}
          value={name}
          maxLength={255}
          spellCheck={false}
          autoComplete="off"
          // Else the dialog focuses its first button, the close X in the title row.
          autoFocus
          onFocus={preselect}
          onChange={(e) => { setName(e.target.value); setServerError(''); }}
        />
        <p id={errorId} role={shownError ? 'alert' : undefined} className="mt-1.5 min-h-4 text-hint text-bad">{shownError}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!trimmed || !!problem || sending}>{naming.mode === 'mkdir' ? 'Create' : 'Rename'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
