const CACHE_NAME = 'clockai-shell-v2';
const APP_SHELL = ['/', '/index.html', '/kiosk', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(APP_SHELL);
        const index = await cache.match('/index.html');
        if (!index) return;
        const html = await index.text();
        const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
          .map((match) => match[1])
          .filter((path) => path?.startsWith('/') && !path.startsWith('/api/'));
        await cache.addAll([...new Set(assetUrls)]);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Nómina y checadas siempre van a red/cola IndexedDB; jamás al HTTP cache.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

// The visible text is hard-coded so an accidental sensitive server payload
// (employee name, photo or biometric result) can never be rendered by push.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('ClockAI', {
      body: 'Hay una actualización operativa pendiente.',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'clockai-operational-update',
      renotify: true,
      data: { url: '/exceptions' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('/exceptions', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        existing.navigate(target);
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
