const CACHE = 'vera-static-v1';
const STATIC = ['/offline.html', '/manifest.webmanifest', '/icon.svg'];

function isPrivateRequest(url) {
  return url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/audio/') ||
    /auth|session/i.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || isPrivateRequest(url)) return;

  // Only immutable Next assets and explicitly static files enter the cache.
  const isStatic = url.pathname.startsWith('/_next/static/') || STATIC.includes(url.pathname);
  if (isStatic) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});
