const CACHE_NAME = 'bazar-pos-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/admin.html',
  '/sellers.html',
  '/404.html',
  '/style.css',
  '/script.js',
  '/i18n.js',
  '/favicon.ico',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // We use addAll but handle potential errors nicely
        // (if any file doesn't exist, the whole addAll might fail, so we might want to ensure they exist)
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.warn('Service worker install error:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Do not intercept API calls
  if (url.pathname.startsWith('/api')) {
    return;
  }

  // Handle HTML (Network first, fallback to cache)
  if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(event.request).then(response => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        return response;
      }).catch(() => {
        return caches.match(event.request).then(response => {
          return response || caches.match('/404.html');
        });
      })
    );
    return;
  }

  // Handle other static assets (Stale-While-Revalidate)
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // If fetch fails and no cache, let it fail natively
      });
      return cachedResponse || fetchPromise;
    })
  );
});
