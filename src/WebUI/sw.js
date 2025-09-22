const CACHE_NAME = 'showtrak-ui-v2';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/main.js',
  '/images/icon.png',
  '/vendors/socket.io/socket.io.min.js',
  '/vendors/fonts/inter.css',
  '/vendors/fonts/files/inter-400.woff2',
  '/vendors/fonts/files/inter-600.woff2',
  '/vendors/fonts/files/inter-700.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // For navigation requests, use network-first then cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Static assets: cache-first, then network
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
