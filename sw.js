// Service Worker — офлайн-кэш. При обновлении контента поднимай версию CACHE.
const CACHE = 'sniper-v28';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/app.js',
  './data/questions.json',
  './data/tickets.json',
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
  // network-first для данных (вопросы и билеты), чтобы правки подхватывались
  const isQuestions = e.request.url.includes('questions.json') || e.request.url.includes('tickets.json');

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
