import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
import { connectWs } from './lib/ws';
import { pairFromHash } from './lib/auth';
import { currentPopout } from './lib/popout';
import { PopoutShell } from './components/PopoutShell';
import { initLayout } from './lib/layout';
import '@fontsource-variable/google-sans/wght.css';
import '@fontsource-variable/figtree/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './index.css';

// P9: a phone that opened `#pair=<code>` from the QR trades it for a device token before the first connect.
// U1: a bot pop-out window shows one bot's chat instead of the whole app.
const popout = currentPopout();
// The "New layout" toggle: picks up `?layout=preview` and keeps <html data-layout> in step (lib/layout.ts).
initLayout();

void pairFromHash().finally(() => {
  connectWs();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {popout ? <PopoutShell route={popout} /> : <App />}
    </React.StrictMode>,
  );
});

// P9: installable PWA. The worker caches the app shell only (see public/sw.js) — never messages or API data.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}
