import type { ApprovalPayload } from '@pocketrocket/shared';

/**
 * A hand-off or routing card reads as words: the whole task, or the exact line. Anything unexpected is null and
 * the caller shows the raw input. Same rule as `cardWords` in ChatPane's ApprovalCard, kept here so the inbox
 * can use it without importing the chat.
 */
export function cardWords(p: Pick<ApprovalPayload, 'toolName' | 'toolInput'>): { main: string; more?: string } | null {
  const input = (p.toolInput ?? {}) as Record<string, unknown>;
  const [main, more] = p.toolName === 'handoff' ? [input.task, input.context] : [input.line, input.reason];
  if (typeof main !== 'string' || !main) return null;
  return { main, more: typeof more === 'string' && more ? more : undefined };
}
