import type { Settings } from '@pocketrocket/shared';

export type ThemeMode = Settings['theme'];

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemPrefersDark();
}

/** Applies the theme to <html> and mirrors it to localStorage so first paint (before settings load) can use it. */
export function applyTheme(mode: ThemeMode) {
  document.documentElement.classList.toggle('dark', resolveDark(mode));
  try {
    localStorage.setItem('prcrew.theme', mode);
  } catch {
    /* ignore */
  }
}

/** Sets the app font, and mirrors it to localStorage so first paint uses it too. */
export function applyFont(font: Settings['font']) {
  document.documentElement.dataset.font = font;
  try {
    localStorage.setItem('prcrew.font', font);
  } catch {
    /* ignore */
  }
}

let mediaListenerAttached = false;
/** Keeps the DOM in sync when the OS theme flips while settings.theme === 'system'. */
export function watchSystemTheme(getMode: () => ThemeMode) {
  if (mediaListenerAttached) return;
  mediaListenerAttached = true;
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getMode() === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
  } catch {
    /* ignore */
  }
}
