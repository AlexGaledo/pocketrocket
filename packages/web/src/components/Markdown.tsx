/**
 * The one place the app renders markdown. Bots and provider checks write links freely, and a plain <a>
 * would take the whole app with it: in a browser tab the click replaces Toki, and in the desktop
 * window a relative link like `report.md` stays in-window on a 404 with no back button. So every link
 * goes through `MdLink`, which opens real web links in a new tab (the desktop shell hands those to the
 * system browser) and never lets anything else navigate the app window. A link to a file opens the chat's
 * Files panel there instead.
 *
 * A click on a web link or a file link asks where to open it: on this device, or in the server's virtual browser
 * (the Screen panel, where the bots' logins are). A file can also be saved to this PC and opened there.
 */
import { createContext, useContext, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Download, ExternalLink, Eye, Laptop, Monitor } from 'lucide-react';
import { useStore } from '../store';
import { api, ApiError } from '../lib/api';
import { desktopCan } from '../lib/auth';
import { saveBlob } from '../lib/saveBlob';
import { Menu, MenuContent, MenuItem, MenuSeparator } from './ui';
import { resolveFileLink } from './files/fileKinds';

/**
 * The folder, inside the room's folder, that relative file links start from: '' in chat, the file's own folder in
 * a Markdown file previewed in Files.
 */
export const FileLinkBase = createContext('');

/** The bot that wrote the text being shown, if any: "Open in server browser" uses its computer first. */
export const LinkBot = createContext<string | undefined>(undefined);

type LinkKind = 'external' | 'file' | 'internal';

/** Sorts an href by where following it would take the app window. */
function classifyLink(href: string): LinkKind {
  // No scheme and not protocol-relative: a path relative to wherever the bot was, almost always a
  // workspace file ("report.md", "./out/notes.txt"). Opening it would only hit the hub's 404.
  // An absolute path is a file too (a bot on the server writes /home/…/rooms/<id>/report.md), unless it is one
  // of the hub's own routes; Files places it inside the room's folder or says it is outside.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) return href.startsWith('#') || /^\/(api|ws|screen)(\/|$)/.test(href) ? 'internal' : 'file';
  let url: URL;
  try {
    url = new URL(href, location.href);
  } catch {
    return 'internal';
  }
  if (url.protocol === 'mailto:') return 'external';
  // A link back to the hub itself (the desktop window keeps those in-window) is treated like a relative one.
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin) return 'external';
  return 'internal';
}

type FileTarget = { roomId: string; path: string; name: string };

/** The file a link names, as a path in the active chat's folder; null (after saying why) when it is not one. */
async function placeFile(href: string, base: string): Promise<FileTarget | null> {
  const s = useStore.getState();
  const roomId = s.activeRoomId;
  if (!roomId) { s.toast('Open a chat to see its files.'); return null; }
  const at = resolveFileLink(href, base);
  let rel: string | null = null;
  if (at && 'abs' in at) {
    try {
      const w = await api.files.where(roomId, at.abs);
      rel = w.kind === 'file' ? w.path : null;
    } catch (e) {
      failed(e);
      return null;
    }
  } else if (at?.file) {
    rel = at.path ? at.path + '/' + at.file : at.file;
  }
  if (!rel) { s.toast('That link is to a folder, not a file.'); return null; }
  return { roomId, path: rel, name: rel.slice(rel.lastIndexOf('/') + 1) };
}

function failed(e: unknown) {
  useStore.getState().toast(e instanceof ApiError ? e.message : 'The hub could not be reached.');
}

/** In a bot's server browser, then the Screen panel on that bot's screen. */
async function openInServer(open: () => Promise<{ botId: string | null }>) {
  try {
    const { botId } = await open();
    useStore.getState().openScreen(botId);
  } catch (e) {
    failed(e);
  }
}

/** "Open on this PC" in the desktop app; a plain download in a browser tab. */
async function openFileHere(href: string, base: string) {
  const f = await placeFile(href, base);
  if (!f) return;
  if (desktopCan('localcopy')) {
    // The desktop app catches this window request, saves the file under Documents\PocketRocket and opens it.
    const room = useStore.getState().rooms.find((r) => r.id === f.roomId);
    const q = new URLSearchParams({ localcopy: f.roomId, path: f.path, folder: room?.name ?? '' });
    window.open(location.origin + '/?' + q.toString(), '_blank');
    return;
  }
  try {
    saveBlob(await api.files.blob(f.roomId, f.path, true), f.name);
  } catch (e) {
    failed(e);
  }
}

function LinkMenu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <MenuContent align="start" onClick={(e) => e.stopPropagation()}>{children}</MenuContent>
    </Menu.Root>
  );
}

function MdLink({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const toast = useStore((s) => s.toast);
  const base = useContext(FileLinkBase);
  const botId = useContext(LinkBot);
  const kind = href ? classifyLink(href) : 'internal';
  if (href && kind === 'external') {
    // A real <a>: Ctrl/Cmd-click and middle-click still open it in a new tab, without the menu.
    const plainClick = (e: MouseEvent) => {
      e.stopPropagation();
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) e.preventDefault();
    };
    const web = /^https?:/i.test(href);
    return (
      <LinkMenu trigger={<a {...rest} href={href} target="_blank" rel="noopener noreferrer" onClick={plainClick}>{children}</a>}>
        <MenuItem onSelect={() => { window.open(href, '_blank', 'noopener,noreferrer'); }}><ExternalLink size={14} aria-hidden />Open in my browser</MenuItem>
        {web && <MenuItem onSelect={() => { void openInServer(() => api.screenOpen(href, useStore.getState().activeRoomId, botId)); }}><Monitor size={14} aria-hidden />Open in server browser</MenuItem>}
        <MenuSeparator />
        <MenuItem onSelect={() => { void navigator.clipboard?.writeText(href).then(() => toast('Link copied'), () => toast("Couldn't copy the link")); }}><Copy size={14} aria-hidden />Copy link</MenuItem>
      </LinkMenu>
    );
  }
  // No href at all, so middle-click or "open in new tab" cannot reach a dead page either.
  const hint = kind === 'file'
    ? 'Opens in Files'
    : "That link points inside Toki and can't be opened from here";
  const preview = () => {
    const s = useStore.getState();
    if (kind !== 'file' || !href || !s.activeRoomId) return toast(kind === 'file' ? 'Open a chat to see its files.' : hint);
    const at = resolveFileLink(href, base);
    // Somewhere this cannot place (outside the room's folder): the folder itself, rather than nothing.
    s.openFiles(at && 'path' in at ? at : at ? { path: '', file: at.abs } : { path: '' });
  };
  const button = (onClick?: () => void) => (
    <button
      type="button"
      className="cursor-pointer text-accent underline underline-offset-2"
      title={href ? href + ' · ' + hint : hint}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(); }}
    >
      {children}
    </button>
  );
  // A folder, or a link that is not a file: straight to Files (or the hint), as before.
  const at = kind === 'file' && href ? resolveFileLink(href, base) : null;
  if (!href || !at || ('path' in at && !at.file)) return button(preview);
  const local = desktopCan('localcopy');
  return (
    <LinkMenu trigger={button()}>
      <MenuItem onSelect={preview}><Eye size={14} aria-hidden />Preview in Files</MenuItem>
      <MenuItem onSelect={() => { void openFileHere(href, base); }}>{local ? <Laptop size={14} aria-hidden /> : <Download size={14} aria-hidden />}{local ? 'Open on this PC' : 'Download'}</MenuItem>
      <MenuItem onSelect={() => { void placeFile(href, base).then((f) => f && openInServer(() => api.files.browse(f.roomId, f.path, botId))); }}><Monitor size={14} aria-hidden />Open in server browser</MenuItem>
    </LinkMenu>
  );
}

/** A wide table scrolls inside its own box instead of pushing the whole transcript sideways. */
function MdTable({ node: _node, ...rest }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return <div className="md-table"><table {...rest} /></div>;
}

// Module-level so ReactMarkdown sees the same object every render.
const COMPONENTS: Components = { a: MdLink, table: MdTable };
const PLUGINS = [remarkGfm];

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{children}</ReactMarkdown>;
}
