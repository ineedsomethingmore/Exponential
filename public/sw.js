/* Exponential PWA service worker v2: Web Push + always-fresh navigations.
   Navigations bypass the HTTP cache (revalidated fetch), so a killed-and-reopened
   Home-Screen app always boots the LATEST deploy instead of a stale cached page. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).catch(() => fetch(e.request)));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Exponential', {
    body: d.body || '',
    icon: './icons/app-192.png',
    data: d,
    tag: d.channelId || undefined, // newer message in the same channel replaces the old banner
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
