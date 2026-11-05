import path from 'node:path';
import { pathsFromInput } from './pathRules.js';

/**
 * Keeps a bot out of project folders it is not a member of, and holds with approvals bypassed, which skip every
 * other path check. It reads tool inputs, so it stops honest mistakes and ordinary use, not a bot set on getting
 * around it: every bot is the same Linux user, so a shell command that hides the path still gets through.
 */
export function projectAccessDenied(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  projectsDir: string,
  allowed: readonly string[],
  known: readonly string[],
): string | null {
  const refuse = (what: string) => 'Project folder ' + what + ' is only open to its members. Ask the owner to add you to the project.';
  const root = path.resolve(projectsDir);

  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '').replaceAll('\\', '/');
    const rootText = root.replaceAll('\\', '/');
    const after = new RegExp('(?:' + rootText.replace(/[.*+?^${}()|[\]]/g, '\\$&') + '|\\.\\./projects)(?:/([\\w.*?-]*))?', 'g');
    for (const m of cmd.matchAll(after)) {
      if (!m[1] || !allowed.includes(m[1])) return refuse(m[1] || 'list');
    }
    // A plain relative path, after `cd ..`. Only names that are real projects, so `src/projects/x` is left alone.
    for (const m of cmd.matchAll(/\bprojects\/([\w-]+)/g)) {
      if (known.includes(m[1]) && !allowed.includes(m[1])) return refuse(m[1]);
    }
    return null;
  }

  for (const p of pathsFromInput(toolName, input)) {
    const abs = path.resolve(cwd, p);
    const rel = path.relative(root, abs);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) {
      const slug = rel.split(path.sep)[0];
      if (!slug || !allowed.includes(slug)) return refuse(slug || 'list');
      continue;
    }
    // A recursive search from above the folder would read every project.
    if (toolName === 'Grep' || toolName === 'Glob') {
      const up = path.relative(abs, root);
      if (up !== '' && !up.startsWith('..') && !path.isAbsolute(up)) return refuse('list');
    }
  }
  return null;
}
