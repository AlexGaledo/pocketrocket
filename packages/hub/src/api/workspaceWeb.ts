import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves the shared workspace read-only on loopback, so a bot's Browser tool (and the person on the Screen tab)
 * can open the HTML, images and PDFs bots write there. Playwright MCP blocks every file:// URL, and its only
 * opt-out (--allow-unrestricted-file-access) would let the browser read anything this user can, hub token and
 * secrets included. This exposes the workspace and nothing else:
 *  - binds 127.0.0.1 only, GET/HEAD only;
 *  - the Host header must be a loopback name, so a public page cannot reach it through DNS rebinding;
 *  - every path is resolved with symlinks followed and must stay inside the workspace.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function workspaceWebHandler(workspaceDir: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, body: string, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return send(403, 'Forbidden');

    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      return send(400, 'Bad path');
    }
    if (rel.includes('\0')) return send(400, 'Bad path');

    let root: string;
    let real: string;
    try {
      root = fs.realpathSync(workspaceDir);
      const target = path.resolve(root, '.' + rel);
      if (!inside(target, root)) return send(403, 'Forbidden');
      real = fs.realpathSync(target);
    } catch {
      return send(404, 'Not found');
    }
    // Symlinks are followed above, so a link pointing out of the workspace lands here.
    if (!inside(real, root)) return send(403, 'Forbidden');

    const st = fs.statSync(real);
    if (st.isDirectory()) {
      // Relative links in a page (and in the listing below) need the trailing slash.
      if (!rel.endsWith('/')) {
        res.writeHead(301, { location: encodeURI(rel + '/'), 'cache-control': 'no-store' });
        return res.end();
      }
      const index = path.join(real, 'index.html');
      if (fs.existsSync(index)) return sendFile(index);
      const entries = fs.readdirSync(real, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const items = entries
        .map((e) => { const n = e.name + (e.isDirectory() ? '/' : ''); return `<li><a href="${esc(encodeURIComponent(e.name))}${e.isDirectory() ? '/' : ''}">${esc(n)}</a></li>`; })
        .join('');
      return send(200, `<!doctype html><meta charset="utf-8"><title>${esc(rel)}</title><h1>Workspace ${esc(rel)}</h1>`
        + (rel === '/' ? '' : '<p><a href="../">..</a></p>') + `<ul>${items}</ul>`, 'text/html; charset=utf-8');
    }
    if (!st.isFile()) return send(404, 'Not found');
    return sendFile(real);

    function sendFile(file: string) {
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': fs.statSync(file).size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  };
}

/** Starts the loopback workspace server. A taken port only logs: the hub runs fine without it. */
export function startWorkspaceWeb(workspaceDir: string, port: number): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer(workspaceWebHandler(workspaceDir));
    server.once('error', (e) => {
      console.warn('[workspace-web] not serving the workspace on 127.0.0.1:' + port + ': ' + (e as Error).message);
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
