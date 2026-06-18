// Service Worker — офлайн-кэш. При обновлении контента поднимай версию CACHE.
const CACHE = 'sniper-v9';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/app.js',
  './data/questions.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first для вопросов (чтобы правки подхватывались), cache-first для остального.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const isQuestions = e.request.url.includes('questions.json');

  if (isQuestions) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
