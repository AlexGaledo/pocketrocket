// One file, big. The bytes come with the hub token like any API call, so the token never rides a URL.
//
// Safety: a file here may be anything a bot or an upload put in the folder, including HTML or an SVG with script.
// A blob: URL runs in the app's own origin if it is ever opened as a page, so a blob URL is only made with a type
// from BLOB_TYPES (by extension, never the server's or the file's word), text is read as text, and SVG goes through
// a data: URL in an <img> (no script in an image; an opaque origin, and Chromium refuses it as a top-level page).
// Nothing here calls window.open. The hub's /raw route adds nosniff and a sandbox CSP for direct requests too.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import type { FileEntry } from '@pocketrocket/shared';
import { api, ApiError } from '../../lib/api';
import { Button, DialogCloseButton, DialogShell, DialogTitle } from '../ui';
import { Markdown, FileLinkBase } from '../Markdown';
import { RowIcon } from './FileIcon';
import { BLOB_TYPES, fmtBytes, fmtModifiedFull, joinPath, previewKind } from './fileKinds';

/** Text and code show this much; past it, a line says so and Download has the rest. */
const TEXT_PREVIEW_BYTES = 1024 * 1024;
/** An SVG past this is shown as its source instead: a data: URL that big is slow and pointless. */
const SVG_IMAGE_BYTES = 5 * 1024 * 1024;

/** The bytes as a data: URL of a fixed type. */
function dataUrl(blob: Blob, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(new Blob([blob], { type }));
  });
}

type Shown =
  | { kind: 'loading' }
  | { kind: 'url'; as: 'image' | 'pdf' | 'audio' | 'video'; url: string }
  | { kind: 'text'; text: string; markdown: boolean; cut: boolean }
  | { kind: 'none'; why: string };

export function FilePreview({ roomId, folder, files, index, onIndex, onClose, onDownload }: {
  roomId: string;
  folder: string;
  /** The folder's files (not folders), in the order shown, for previous and next. */
  files: FileEntry[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDownload: (e: FileEntry) => void;
}) {
  const entry = files[index];
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!entry) return;
    const kind = previewKind(entry);
    if (!kind) {
      setShown({ kind: 'none', why: 'No preview for ' + (entry.ext ? '.' + entry.ext + ' files' : 'this file') + '.' });
      return;
    }
    let alive = true;
    let url = '';
    setShown({ kind: 'loading' });
    api.files.blob(roomId, joinPath(folder, entry.name)).then(async (blob) => {
      if (!alive) return;
      if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') {
        const type = BLOB_TYPES[entry.ext];
        if (!type) { setShown({ kind: 'none', why: 'No preview for .' + entry.ext + ' files.' }); return; }
        url = URL.createObjectURL(new Blob([blob], { type }));
        setShown({ kind: 'url', as: kind, url });
        return;
      }
      if (kind === 'svg' && blob.size <= SVG_IMAGE_BYTES) {
        const src = await dataUrl(blob, 'image/svg+xml');
        if (alive) setShown({ kind: 'url', as: 'image', url: src });
        return;
      }
      const head = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
      if (!alive) return;
      // A file with no known extension is shown only if it reads as text.
      if (kind === 'maybe-text' && head.slice(0, 8000).includes('\u0000')) {
        setShown({ kind: 'none', why: 'No preview: this looks like a binary file.' });
        return;
      }
      setShown({ kind: 'text', text: head, markdown: kind === 'markdown', cut: blob.size > TEXT_PREVIEW_BYTES });
    }).catch((e: unknown) => {
      if (!alive) return;
      const status = e instanceof ApiError ? e.status : 0;
      setShown({ kind: 'none', why: status === 413 ? 'Over 50 MB, too big to open here.' : status === 404 ? 'This file is gone. It may have been moved or deleted.' : "Couldn't open it: " + (e as Error).message });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [roomId, folder, entry]);

  if (!entry) return null;
  const go = (step: number) => {
    const next = index + step;
    if (next >= 0 && next < files.length) onIndex(next);
  };

  return (
    <DialogShell
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      hasDescription
      className="flex h-[min(880px,calc(100dvh-1.5rem))] w-[min(1040px,calc(100vw-1.5rem))] flex-col overflow-hidden"
    >
      <div
        ref={contentRef}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col focus:outline-none"
        // Left and right step through the folder, except where they scroll or move a caret.
        onKeyDown={(e) => {
          if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
          const t = e.target as HTMLElement;
          if (t.closest('[data-own-arrows]') || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
          e.preventDefault();
          go(e.key === 'ArrowLeft' ? -1 : 1);
        }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line py-2.5 pl-4 pr-2.5">
          <RowIcon entry={entry} size={20} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-ui font-semibold">{entry.name}</DialogTitle>
            <DialogPrimitive.Description className="truncate text-hint text-muted">
              {fmtBytes(entry.size)} · {fmtModifiedFull(entry.mtime)}{files.length > 1 ? ' · ' + (index + 1) + ' of ' + files.length : ''}
            </DialogPrimitive.Description>
          </div>
          {files.length > 1 && (
            <>
              <Button size="icon" variant="ghost" aria-label="Previous file" title="Previous file (Left arrow)" disabled={index === 0} onClick={() => go(-1)}><ChevronLeft size={16} /></Button>
              <Button size="icon" variant="ghost" aria-label="Next file" title="Next file (Right arrow)" disabled={index === files.length - 1} onClick={() => go(1)}><ChevronRight size={16} /></Button>
            </>
          )}
          <Button size="icon" variant="ghost" aria-label={'Download ' + entry.name} title="Download" onClick={() => onDownload(entry)}><Download size={15} /></Button>
          <DialogCloseButton />
        </div>
        <div className="relative min-h-0 flex-1 bg-bg">
          <Body shown={shown} entry={entry} folder={folder} onDownload={() => onDownload(entry)} />
        </div>
      </div>
    </DialogShell>
  );
}

function Body({ shown, entry, folder, onDownload }: { shown: Shown; entry: FileEntry; folder: string; onDownload: () => void }) {
  if (shown.kind === 'loading') {
    return <Centered><span role="status">Opening…</span></Centered>;
  }
  if (shown.kind === 'none') {
    return (
      <Centered>
        <RowIcon entry={entry} size={32} />
        <p className="max-w-[40ch] text-ui text-muted">{shown.why}</p>
        <Button onClick={onDownload}><Download size={14} />Download</Button>
      </Centered>
    );
  }
  if (shown.kind === 'url') {
    if (shown.as === 'image') {
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-4">
          <img src={shown.url} alt={entry.name} draggable={false} className="max-h-full max-w-full rounded-sm object-contain shadow-[var(--shadow-sm)]" />
        </div>
      );
    }
    if (shown.as === 'pdf') {
      // data-own-arrows: the PDF viewer pages with the arrow keys itself. No `sandbox`: Chromium and WebView2 refuse
      // to show a PDF in any sandboxed frame (tried: every token set leaves it blank). The blob is always typed
      // application/pdf here, so it opens in the browser's PDF viewer, never as a page of ours.
      return <iframe data-own-arrows title={entry.name} src={shown.url} className="block h-full w-full border-0" />;
    }
    if (shown.as === 'audio') {
      return <Centered><audio data-own-arrows controls src={shown.url} className="w-[min(480px,100%)]" /></Centered>;
    }
    return <div className="flex h-full items-center justify-center bg-black"><video data-own-arrows controls src={shown.url} className="max-h-full max-w-full" /></div>;
  }
  return (
    <div data-own-arrows tabIndex={0} aria-label={entry.name + ' contents'} className="h-full overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
      {shown.cut && (
        <p className="sticky top-0 z-[1] border-b border-line bg-panel px-4 py-1.5 text-hint text-muted">Showing the first 1 MB of {fmtBytes(entry.size)}. Download it for the rest.</p>
      )}
      {shown.markdown ? (
        <div className="md mx-auto px-6 py-5 text-body">
          {/* Links in the file are relative to its folder, not to the room's. */}
          <FileLinkBase.Provider value={folder}><Markdown>{shown.text}</Markdown></FileLinkBase.Provider>
        </div>
      ) : (
        <pre className="min-w-max px-4 py-3 font-mono text-label font-normal leading-5 text-fg">{shown.text}</pre>
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-ui text-muted">{children}</div>;
}
