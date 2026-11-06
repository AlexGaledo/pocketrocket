import path from 'node:path';
import { pathsFromInput } from './pathRules.js';

/**
 * One parent folder whose subfolders belong to different rooms: the projects folder (one subfolder per project
 * slug) or the rooms folder (one per room id). `allowed` is the subfolder this turn may use, `known` every
 * subfolder name that really exists, so a relative path that merely looks similar is left alone.
 */
export interface FolderScope {
  root: string;
  allowed: readonly string[];
  known: readonly string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]]/g, '\\$&');

/**
 * Keeps a bot in the file folder of the room it is replying in: out of other projects' folders and other rooms'
 * folders. It holds with approvals bypassed, which skip every other path check. It reads tool inputs, so it stops
 * honest mistakes and ordinary use, not a bot set on getting around it: every bot is the same Linux user, so a
 * shell command that hides the path still gets through.
 */
export function folderAccessDenied(toolName: string, input: Record<string, unknown>, cwd: string, scopes: readonly FolderScope[]): string | null {
  for (const scope of scopes) {
    const why = scopeDenied(toolName, input, cwd, scope);
    if (why) return why;
  }
  return null;
}

function scopeDenied(toolName: string, input: Record<string, unknown>, cwd: string, scope: FolderScope): string | null {
  const { allowed, known } = scope;
  const refuse = (what: string) =>
    'Folder ' + what + ' belongs to another room. You can only use the file folder of the room you are replying in; ask the owner to share what you need there.';
  const root = path.resolve(scope.root);
  const base = path.basename(root);

  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '').replaceAll('\\', '/');
    const rootText = root.replaceAll('\\', '/');
    const after = new RegExp('(?:' + escapeRe(rootText) + '|\\.\\./' + escapeRe(base) + ')(?:/([\\w.*?-]*))?', 'gi');
    for (const m of cmd.matchAll(after)) {
      if (!m[1] || !allowed.includes(m[1])) return refuse(m[1] || 'list');
    }
    // A plain relative path, after `cd ..`. Only names that are real, so `src/projects/x` is left alone.
    for (const m of cmd.matchAll(new RegExp('\\b' + escapeRe(base) + '/([\\w-]+)', 'g'))) {
      if (known.includes(m[1]) && !allowed.includes(m[1])) return refuse(m[1]);
    }
    return null;
  }

  for (const p of pathsFromInput(toolName, input)) {
    const abs = path.resolve(cwd, p);
    const rel = path.relative(root, abs);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) {
      const name = rel.split(path.sep)[0];
      if (!name || !allowed.includes(name)) return refuse(name || 'list');
      continue;
    }
    // A recursive search from above the folder would read every room's files.
    if (toolName === 'Grep' || toolName === 'Glob') {
      const up = path.relative(abs, root);
      if (up !== '' && !up.startsWith('..') && !path.isAbsolute(up)) return refuse('list');
    }
  }
  return null;
}
