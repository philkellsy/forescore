const CACHE_NAME = 'forescore-cache-v3';
const WARMING_URL = '/warming.html';
const OFFLINE_URL = '/offline.html';
const NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([WARMING_URL, OFFLINE_URL]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    Promise.race([
      fetch(event.request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)
      ),
    ]).catch(() => caches.match(WARMING_URL).then((r) => r || caches.match(OFFLINE_URL)))
  );
});
