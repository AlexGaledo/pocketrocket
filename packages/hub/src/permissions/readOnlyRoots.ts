import { isInside, pathsFromInput } from './pathRules.js';

/**
 * P7: the knowledge repo is a read-only root. The Claude SDK gets it in `additionalDirectories` so reads are
 * free, but under `acceptEdits` that would also auto-accept edits there without ever asking canUseTool. This
 * is the PreToolUse decision that stops it: any file-writing tool aimed inside a read-only root is escalated
 * to `ask` (an approval card from the PermissionBroker), or denied outright when approvals are bypassed,
 * because then nothing would ask at all.
 */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

export function readOnlyWriteDecision(
  toolName: string,
  input: Record<string, unknown>,
  readOnlyRoots: string[],
  cwd: string,
  bypass: boolean,
): { decision: 'ask' | 'deny'; reason: string } | null {
  if (!readOnlyRoots.length || !(WRITE_TOOLS as readonly string[]).includes(toolName)) return null;
  const hits = pathsFromInput(toolName, input).filter((p) => isInside(p, readOnlyRoots, cwd));
  if (!hits.length) return null;
  return bypass
    ? { decision: 'deny', reason: 'The knowledge repo is read-only; ' + toolName + ' refused: ' + hits.join(', ') }
    : { decision: 'ask', reason: toolName + ' into the read-only knowledge repo: ' + hits.join(', ') };
}
