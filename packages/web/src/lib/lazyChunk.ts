import { getItem, removeItem, setItem } from './persist';

const KEY = 'pocketrocket.chunk-reloaded';

/**
 * Loads a lazy chunk. After a hub update the hashed file a tab asks for can be gone (the service worker caches
 * /assets/*), so the import fails. The first failure reloads the page once to pick up the new build; if that does not
 * fix it, or `canReload()` says unsaved work would be lost, the error is thrown for an error boundary to show.
 */
export function importChunk<T>(load: () => Promise<T>, canReload: () => boolean = () => true, reload: () => void = () => location.reload()): Promise<T> {
  return load().then(
    (m) => { removeItem(KEY, 'session'); return m; },
    (err: unknown) => {
      if (canReload() && getItem(KEY, 'session') !== '1') {
        setItem(KEY, '1', 'session');
        reload();
        return new Promise<T>(() => undefined); // the page is going away: keep the placeholder up meanwhile
      }
      throw err;
    },
  );
}
