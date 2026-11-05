#!/usr/bin/env node
// Brings Claude project context into PocketRocket, from the PC. See docs/context-import.md.
//
// Nothing leaves this machine without --upload. Without it, the command writes a preview file to read first.
// Needs POCKETROCKET_TOKEN (data/hub-token on the server) and a tunnel for anything that talks to the hub:
//   ssh -N -L 7788:127.0.0.1:7788 crm-agency
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 190_000;
const TEXT_FILES = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.xml', '.log']);

// Same rules as packages/hub/src/providers/redact.ts and services/contextScrub.ts; contextImport.test.ts checks them.
const SHAPES = [
  /\b(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|xai|ghp|gho)-?[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[usr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bpk_\d+_[A-Za-z0-9]{16,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const LABELLED = /\b(pass(?:word|wd|code|phrase)?|pwd|secret|api[_ -]?key|(?:access|auth|refresh)[_ -]?token|client[_ -]?secret|private[_ -]?key)\b(["']?\s*(?:[:=]|\bis\b)\s*["']?)([^\s"',;]{4,})/gi;
// Not secrets, but nothing a bot needs: people's addresses and numbers, and identifiers issued by government.
const PERSONAL = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi, '[redacted]'],
  [/\b([A-Z][A-Z0-9]*_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|DSN))\s*=\s*\S+/g, '$1=[redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/(?:\+63[ -]?\d{3}|\b09\d{2})[ -]?\d{3}[ -]?\d{4}\b/g, '[phone]'],
  [/\b(TIN|SSS|PhilHealth|Pag-?IBIG)\b([^\n\d]{0,20})\d[\d -]{6,}\d/gi, '$1$2[id]'],
];
// Left in on purpose, but worth a human look: the words around a credential the rules could not recognise.
const LOOK_AT = /\b(password|passwd|credential|login|api key|secret|ssn|credit card)\b/gi;

/** Removes what it recognises. A bare password with no label stays, which is why the preview exists. */
export function scrub(text) {
  let hits = 0;
  let out = text;
  for (const re of SHAPES) out = out.replace(re, () => { hits++; return '[redacted]'; });
  out = out.replace(LABELLED, (_, name, sep) => { hits++; return name + sep + '[redacted]'; });
  for (const [re, to] of PERSONAL) {
    hits += (out.match(re) ?? []).length;
    out = out.replace(re, to);
  }
  return { text: out, hits };
}

/** What was said. Thinking, tool calls and tool results are left out: tool output is where stray secrets live. */
function textOf(message) {
  if (Array.isArray(message.content)) {
    const said = message.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (said) return said;
  }
  return typeof message.text === 'string' ? message.text : '';
}

/**
 * Reads a folder holding the unzipped parts of a Claude export (seen November 2026; the format is not documented):
 * conversations.json, projects/<uuid>.json, memories/<uuid>.json. A part that is missing just comes back empty.
 * Chats carry no link to their project, so they can only be picked by name.
 */
export function readExport(dir) {
  const read = (name) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const readDir = (name) => {
    const d = path.join(dir, name);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
  };
  const memoryByProject = Object.assign({}, ...readDir('memories').map((m) => m.project_memories ?? {}));
  const day = (s) => (typeof s === 'string' ? s.slice(0, 10) : '');
  const chats = (read('conversations.json') ?? []).map((c) => {
    const said = (c.chat_messages ?? c.messages ?? [])
      .map((m) => ({ who: m.sender ?? m.role ?? 'unknown', text: textOf(m), date: day(m.created_at) }))
      .filter((m) => m.text);
    return {
      name: String(c.name || c.title || c.uuid || 'Untitled chat'),
      date: said.at(-1)?.date || day(c.updated_at),
      body: said.map((m) => '**' + m.who + (m.date ? ' (' + m.date + ')' : '') + ':** ' + m.text).join('\n\n'),
    };
  });
  const projects = readDir('projects').filter((p) => p.name).map((p) => ({
    name: String(p.name),
    date: day(p.updated_at),
    description: String(p.description ?? ''),
    instructions: String(p.prompt_template ?? ''),
    memory: typeof memoryByProject[p.uuid] === 'string' ? memoryByProject[p.uuid] : '',
    docs: (p.docs ?? []).map((d) => ({ name: String(d.filename ?? 'Untitled file'), date: day(d.created_at), body: String(d.content ?? '') })),
  }));
  return { chats, projects };
}

/** Text files under `dir`, and the rest by name so a skipped PDF is never a silent gap. */
export function readDropFolder(dir) {
  const files = [];
  const skipped = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (TEXT_FILES.has(path.extname(e.name).toLowerCase())) files.push({ title: path.relative(dir, full).replaceAll('\\', '/'), date: fs.statSync(full).mtime.toISOString().slice(0, 10), body: fs.readFileSync(full, 'utf8') });
      else skipped.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return { files, skipped };
}

function flag(args, name) {
  const i = args.indexOf('--' + name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

async function api(method, p, body) {
  const base = process.env.POCKETROCKET_URL || 'http://127.0.0.1:7788';
  const token = process.env.POCKETROCKET_TOKEN;
  if (!token) throw new Error('Set POCKETROCKET_TOKEN to the hub token first.');
  let res;
  try {
    res = await fetch(base + p, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach ' + base + '. Is the tunnel open? ssh -N -L 7788:127.0.0.1:7788 crm-agency');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(method + ' ' + p + ': ' + (json?.error ?? res.status));
  return json;
}

/** Scrubs, previews, and uploads only when asked. Text over the size limit is cut and says so. */
async function run(items, { source, project, upload, previewFile }) {
  const seen = new Map();
  const prepared = items.filter((i) => i.body.trim()).map((i) => {
    // Two projects can share a name, and a re-import replaces by title, so each title must be unique.
    const n = (seen.get(i.title) ?? 0) + 1;
    seen.set(i.title, n);
    if (n > 1) i = { ...i, title: i.title + ' (' + n + ')' };
    const { text, hits } = scrub(i.body);
    const cut = text.length > MAX_BODY;
    return { title: i.title.slice(0, 200), date: i.date, dateApproximate: i.dateApproximate, body: cut ? text.slice(0, MAX_BODY) + '\n\n[cut: original was ' + text.length + ' characters]' : text, hits, cut };
  });
  if (!prepared.length) return console.log('Nothing to import.');

  const preview = previewFile || path.join(os.tmpdir(), 'pocketrocket-context-preview.md');
  fs.writeFileSync(preview, prepared.map((i) => '# ' + i.title + '\n\n' + i.body).join('\n\n---\n\n'), { mode: 0o600 });
  for (const i of prepared) {
    const looks = (i.body.match(LOOK_AT) ?? []).length;
    console.log('- ' + i.title + ': ' + i.body.length + ' chars, ' + i.hits + ' redacted' + (looks ? ', ' + looks + ' sensitive word(s) left, check these' : '') + (i.cut ? ', CUT to the size limit' : ''));
  }
  console.log('\nProject: ' + project + '\nPreview: ' + preview);
  if (!upload) return console.log('\nNothing uploaded. Read the preview, then run this again with --upload.\nA password with no label cannot be detected, so look for it yourself.');

  for (const i of prepared) await api('POST', '/api/context', { source, project, title: i.title, body: i.body, date: i.date || undefined, dateApproximate: i.dateApproximate || undefined });
  console.log('\nUploaded ' + prepared.length + ' item(s) to the project folder. Its members can read them now.');
}

const HELP = `Usage: node scripts/context-import.mjs <command>

  drop <folder> --project <name> [--upload]
      Import the text files in a folder.

  export <unzipped export folder> --project <name> --match <text> [--exclude a,b,c] [--preview <file>] [--upload]
  export <unzipped export folder> --list
      Import chats and project files whose name contains <text>. --match all takes everything.
      --exclude leaves out anything whose name contains one of those words. It stays on this PC.

  project list | create <name> [--team]   Projects. --team clones the development team.
  project members <slug> [handle...]      Exactly which bots work in a project. No handles: none.
  search <slug> <words>                   Search a project, with no AI turn
  lint <slug>                             What has gone stale or messy
  pending                        What the connector sent, waiting for review
  show <id>                      Read one waiting item
  approve <id> | reject <id>     Into the project's folder, or delete it
  connector on|off|status        The Claude connector. "on" prints a new URL; any older one stops working.`;

export async function main(argv) {
  const [cmd, ...args] = argv;
  const upload = flag(args, 'upload') === true;
  const project = flag(args, 'project');
  const need = (cond, msg) => { if (!cond) throw new Error(msg + '\n\n' + HELP); };

  if (cmd === 'drop') {
    need(args[0] && !args[0].startsWith('--') && typeof project === 'string', 'drop needs a folder and --project.');
    const { files, skipped } = readDropFolder(args[0]);
    if (skipped.length) console.log('Skipped, not plain text (save as .md or .txt to include):\n  ' + skipped.join('\n  ') + '\n');
    return run(files, { source: 'drop-folder', project, upload });
  }
  if (cmd === 'export') {
    need(args[0] && !args[0].startsWith('--'), 'export needs the unzipped export folder.');
    if (args[0].toLowerCase().endsWith('.zip')) throw new Error('Unzip the export first, then pass the folder.');
    const { chats, projects } = readExport(args[0]);
    console.log('Found ' + chats.length + ' chat(s), ' + projects.length + ' named project(s).');
    if (flag(args, 'list')) {
      for (const p of projects) console.log('  project: ' + p.name + ' (' + p.docs.length + ' files, instructions ' + p.instructions.length + ' chars, memory ' + p.memory.length + ' chars)');
      for (const c of chats) console.log('  chat: ' + c.name);
      return undefined;
    }
    const match = flag(args, 'match');
    need(typeof project === 'string' && typeof match === 'string', 'export needs --project and --match (or --list).');
    const exclude = typeof flag(args, 'exclude') === 'string' ? flag(args, 'exclude').toLowerCase().split(',').map((w) => w.trim()).filter(Boolean) : [];
    const left = [];
    const hit = (name) => {
      if (match !== 'all' && !name.toLowerCase().includes(match.toLowerCase())) return false;
      if (!exclude.some((w) => name.toLowerCase().includes(w))) return true;
      left.push(name);
      return false;
    };
    const items = [
      ...projects.filter((p) => hit(p.name)).flatMap((p) => [
        { title: p.name + ': description', date: p.date, body: p.description },
        { title: p.name + ': instructions', date: p.date, body: p.instructions },
        // The export dates the project, not its memory, so this may be newer than what the memory says.
        { title: p.name + ': Claude memory', date: p.date, dateApproximate: true, body: p.memory },
        ...p.docs.map((d) => ({ title: p.name + ': ' + d.name, date: d.date || p.date, body: d.body })),
      ]),
      ...chats.filter((c) => hit(c.name)).map((c) => ({ title: 'Chat: ' + c.name, date: c.date, body: c.body })),
    ];
    if (left.length) console.log('Left out by --exclude (' + left.length + '):\n  ' + left.join('\n  ') + '\n');
    const previewFile = typeof flag(args, 'preview') === 'string' ? flag(args, 'preview') : undefined;
    return run(items, { source: 'export', project, upload, previewFile });
  }
  if (cmd === 'pending') {
    const rows = await api('GET', '/api/context');
    if (!rows.length) console.log('(none)');
    for (const r of rows) console.log(r.id + '  [' + r.project + '] ' + r.title + ' (' + r.bytes + ' chars)');
    return undefined;
  }
  if (cmd === 'show') { const r = await api('GET', '/api/context/' + encodeURIComponent(args[0])); return console.log('[' + r.project + '] ' + r.title + '\n\n' + r.body); }
  if (cmd === 'approve') { const r = await api('POST', '/api/context/' + encodeURIComponent(args[0]) + '/approve', {}); return console.log('Saved to ' + r.project + '/' + r.path); }
  if (cmd === 'search') {
    need(args[0] && args[1], 'search needs a project and some words.');
    const hits = await api('GET', '/api/projects/' + encodeURIComponent(args[0]) + '/search?q=' + encodeURIComponent(args.slice(1).join(' ')));
    if (!hits.length) console.log('(nothing found)');
    for (const h of hits) console.log('[' + h.path + ' | ' + h.status + ' | updated ' + (h.updated ?? 'unknown') + (h.reviewExpired ? ' | review overdue' : '') + ']\n' + h.snippet + '\n');
    return undefined;
  }
  if (cmd === 'lint') {
    need(args[0], 'lint needs a project.');
    const r = await api('GET', '/api/projects/' + encodeURIComponent(args[0]) + '/lint');
    if (!r.issues.length) console.log('Nothing to flag.');
    for (const i of r.issues) console.log(i.kind + '  ' + i.path + ': ' + i.detail);
    if (r.recentMisses.length) console.log('\nSearches that found nothing:\n  ' + r.recentMisses.join('\n  '));
    return undefined;
  }
  if (cmd === 'project' && args[0] === 'list') {
    const bots = await api('GET', '/api/bots');
    const handle = (id) => bots.find((b) => b.id === id)?.handle ?? id;
    for (const p of await api('GET', '/api/projects')) console.log(p.slug + '  ' + p.dir + '\n  members: ' + (p.memberIds.map(handle).join(', ') || '(none)'));
    return undefined;
  }
  if (cmd === 'project' && args[0] === 'create') {
    need(args[1], 'project create needs a name.');
    const r = await api('POST', '/api/projects', { name: args[1], team: flag(args, 'team') === true });
    return console.log('Created ' + r.project.slug + ' at ' + r.project.dir + (r.bots.length ? '\nTeam: ' + r.bots.map((b) => '@' + b.handle).join(', ') : ''));
  }
  if (cmd === 'project' && args[0] === 'members') {
    need(args[1], 'project members needs a project.');
    const bots = await api('GET', '/api/bots');
    const ids = args.slice(2).map((h) => {
      const b = bots.find((x) => x.handle.toLowerCase() === h.replace(/^@/, '').toLowerCase());
      if (!b) throw new Error('No bot with handle ' + h);
      return b.id;
    });
    await api('PUT', '/api/projects/' + encodeURIComponent(args[1]) + '/members', { memberIds: ids });
    return console.log(ids.length ? 'Only these work in ' + args[1] + ': ' + args.slice(2).join(', ') : 'No bot works in ' + args[1] + ' now.');
  }
  if (cmd === 'reject') { await api('DELETE', '/api/context/' + encodeURIComponent(args[0])); return console.log('Deleted.'); }
  if (cmd === 'connector') {
    if (args[0] === 'on') {
      const r = await api('POST', '/api/context/connector', {});
      return console.log('Connector path, shown once. Treat it like a password:\n' + r.path + '\n\nFull URL: https://<connector host>' + r.path);
    }
    if (args[0] === 'off') { await api('DELETE', '/api/context/connector'); return console.log('Connector off.'); }
    const r = await api('GET', '/api/context/connector');
    return console.log(r.enabled ? 'Connector on.' : 'Connector off.');
  }
  return console.log(HELP);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
