import path from 'node:path';
import fs from 'node:fs';

const isWin = process.platform === 'win32';

function canon(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
}
function real(p: string): string | null {
  try {
    return canon(fs.realpathSync.native(path.resolve(p)));
  } catch {
    return null;
  }
}

/** True when `target` resolves inside (or equal to) one of `roots`. Checks both raw-resolved and realpath forms. */
export function isInside(target: string, roots: string[], cwd?: string): boolean {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd ?? process.cwd(), target);
  const candidates = new Set<string>([canon(abs)]);
  const r = real(abs);
  if (r) candidates.add(r);
  for (const root of roots) {
    const rs = new Set<string>([canon(root)]);
    const rr = real(root);
    if (rr) rs.add(rr);
    for (const c of candidates) for (const x of rs) if (c === x || c.startsWith(x + path.sep)) return true;
  }
  return false;
}

/** Extract path-like fields from a tool input. */
export function pathsFromInput(toolName: string, input: Record<string, unknown>): string[] {
  const keys = ['file_path', 'path', 'notebook_path', 'directory', 'cwd'];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length) out.push(v);
  }
  if ((toolName === 'Glob' || toolName === 'Grep') && !out.length) out.push('.');
  return out;
}
