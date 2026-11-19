import { getItem, removeItem, setItem, versionedKey } from './persist';

/** What a composer is saving after this long without typing. Short enough to survive a closed tab. */
export const DRAFT_SAVE_MS = 400;

/** One key per room, `pocketrocket.draft.v1.<roomId>`. */
const draftKey = (roomId: string) => versionedKey('draft', 1) + '.' + roomId;

export function readDraft(roomId: string): string {
  return getItem(draftKey(roomId)) ?? '';
}

/** An empty or blank draft removes the key instead of storing nothing. */
export function writeDraft(roomId: string, text: string): void {
  if (text.trim()) setItem(draftKey(roomId), text);
  else removeItem(draftKey(roomId));
}
