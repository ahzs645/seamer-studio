const CACHE_NAME = 'seamer-studio-v2';
const STUDIO_CACHE = 'seamer-studio-assets-v2';

const PRECACHE_ASSETS = [
  '/studio',
  '/favicon.ico',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME && name !== STUDIO_CACHE)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin === location.origin && 
      (request.mode === 'navigate' || url.pathname.startsWith('/studio'))) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(STUDIO_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok && request.method === 'GET' && 
            (url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|woff2?|ttf)$/) ||
             url.pathname.startsWith('/static/'))) {
          const clone = response.clone();
          caches.open(STUDIO_CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
