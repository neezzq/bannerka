/*
 * Service worker: сначала сеть, при отсутствии сети — кэш.
 * После изменения файлов сайта можно увеличить версию — старый кэш удалится.
 */
var CACHE = 'zakazy-v2';
var SHELL = [
  './',
  './index.html',
  './admin.html',
  './app.css',
  './common.js',
  './config.js',
  './manifest.json',
  './admin-manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/admin-192.png',
  './icons/admin-512.png',
  './icons/admin-apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .catch(function () { /* сайт работает и без предзагрузки */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function cacheable(url) {
  return url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // запросы к API (POST) не трогаем
  var url = new URL(req.url);
  if (!cacheable(url)) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') {
          var page = url.pathname.indexOf('admin') !== -1 ? './admin.html' : './index.html';
          return caches.match(page);
        }
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
