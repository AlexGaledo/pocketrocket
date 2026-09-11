import { useSyncExternalStore } from 'react';

/**
 * True while a CSS media query matches, re-rendering when it flips (window resized, OS setting changed).
 * useSyncExternalStore is React's built-in way to read a browser value that changes outside React
 * without tearing; it replaces the older useState + useEffect + listener pattern.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
