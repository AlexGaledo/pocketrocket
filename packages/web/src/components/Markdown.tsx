/**
 * The one place the app renders markdown. Bots and provider checks write links freely, and a plain <a>
 * would take the whole app with it: in a browser tab the click replaces PocketRocket, and in the desktop
 * window a relative link like `report.md` stays in-window on a 404 with no back button. So every link
 * goes through `MdLink`, which opens real web links in a new tab (the desktop shell hands those to the
 * system browser) and never lets anything else navigate the app window. A link to a file opens the chat's
 * Files panel there instead.
 */
import { createContext, useContext, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../store';
import { resolveFileLink } from './files/fileKinds';

/**
 * The folder, inside the room's folder, that relative file links start from: '' in chat, the file's own folder in
 * a Markdown file previewed in Files.
 */
export const FileLinkBase = createContext('');

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

function MdLink({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const toast = useStore((s) => s.toast);
  const base = useContext(FileLinkBase);
  const kind = href ? classifyLink(href) : 'internal';
  if (href && kind === 'external') {
    return (
      // stopPropagation: a link inside a clickable card (a provider card, say) should not also select it.
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        {children}
      </a>
    );
  }
  // No href at all, so middle-click or "open in new tab" cannot reach a dead page either.
  const hint = kind === 'file'
    ? 'Opens in Files'
    : "That link points inside PocketRocket and can't be opened from here";
  const open = () => {
    const s = useStore.getState();
    if (kind !== 'file' || !href || !s.activeRoomId) return toast(kind === 'file' ? 'Open a chat to see its files.' : hint);
    const at = resolveFileLink(href, base);
    // Somewhere this cannot place (outside the room's folder): the folder itself, rather than nothing.
    s.openFiles(at && 'path' in at ? at : at ? { path: '', file: at.abs } : { path: '' });
  };
  return (
    <button
      type="button"
      className="cursor-pointer text-accent underline underline-offset-2"
      title={href ? href + ' · ' + hint : hint}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}
    >
      {children}
    </button>
  );
}

// Module-level so ReactMarkdown sees the same object every render.
const COMPONENTS: Components = { a: MdLink };
const PLUGINS = [remarkGfm];

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>{children}</ReactMarkdown>;
}
