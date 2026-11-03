/*
 * PocketRocket service worker (P9).
 *
 * Caches the APP SHELL only: index.html, the hashed /assets/* bundles, icons and the manifest, so the app
 * opens instantly and installs as a PWA. It never caches what the hub says: /api/*, /ws, /screen/*, /auth/*,
 * /oauth/*, /mcp and every non-GET go straight to the network, untouched. No message, approval or
 * transcript is ever kept on the phone by this worker.
 *
 * Pushes are content-free: the payload is {"kind":"approval"|"routine"|"test"} and the wording below is fixed.
 */
const CACHE = 'pocketrocket-shell-v1';
const SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.svg'];
const NEVER = [/^\/api\//, /^\/ws(\/|$)/, /^\/screen(\/|$)/, /^\/auth\//, /^\/oauth\//, /^\/mcp(\/|$)/, /^\/sw\.js$/];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pocketrocket-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;

  // Navigations: network first (a new build shows up at once), the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed bundles, icons, fonts served by the hub: cache on first use.
  const shellAsset = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || SHELL.includes(url.pathname);
  if (!shellAsset) return;
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});

const TEXT = {
  approval: { title: 'A bot needs your approval', body: 'Open PocketRocket to review it.' },
  routine: { title: 'Routine finished', body: 'Open PocketRocket to see the result.' },
  test: { title: 'Test notification from PocketRocket', body: 'Notifications work on this device.' },
};

self.addEventListener('push', (event) => {
  let kind = 'approval';
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data.kind === 'string' && Object.prototype.hasOwnProperty.call(TEXT, data.kind)) kind = data.kind;
  } catch (e) {
    /* not JSON: fall back to the generic wording */
  }
  const t = TEXT[kind];
  event.waitUntil(self.registration.showNotification(t.title, {
    body: t.body,
    tag: 'pocketrocket-' + kind,
    renotify: kind === 'approval',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
