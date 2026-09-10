const CACHE_NAME = 'bazar-pos-v2.8.0';
const ASSETS_TO_CACHE = [
  '/',
  '/admin',
  '/admin.html',
  '/sellers',
  '/sellers.html',
  '/404.html',
  '/style.css',
  '/script.js',
  '/i18n.js',
  '/favicon.ico',
  '/manifest.json',
  '/assets/logo.webp',
  '/assets/logo-icon.webp',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        // Cache assets individually so one failure doesn't block the entire SW installation
        for (const asset of ASSETS_TO_CACHE) {
          try {
            await cache.add(asset);
          } catch (err) {
            console.warn(`[SW] Failed to cache ${asset}:`, err);
          }
        }
      })
      .then(() => self.skipWaiting())
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
  if (event.request.mode === 'navigate' || (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html'))) {
    event.respondWith(
      fetch(event.request).then(response => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        return response;
      }).catch(() => {
        return caches.match(event.request, { ignoreSearch: true }).then(response => {
          if (response) return response;
          
          // Smart offline routing based on hostname
          if (url.hostname.startsWith('admin')) {
            return caches.match('/admin.html') || caches.match('/admin');
          } else if (url.hostname.startsWith('sellers')) {
            return caches.match('/sellers.html') || caches.match('/sellers');
          }
          
          return caches.match('/404.html');
        });
      })
    );
    return;
  }

  // Handle other static assets
  event.respondWith(
    fetch(event.request).then(networkResponse => {
      if (networkResponse && networkResponse.status === 200) {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(event.request, { ignoreSearch: true });
    })
  );
});
