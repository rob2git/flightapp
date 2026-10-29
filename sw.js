// Caches the app shell so Flightapp opens offline. Flight data is never cached here:
// API calls go to other origins and are left alone; the app keeps the last answer itself.
const CACHE = 'flightapp-shell-v9';
const SHELL = [
  './', 'index.html', 'guide.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/map.js', 'js/land.js', 'js/providers.js', 'js/airports.js', 'js/util.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'fonts/barlow-condensed-latin-500-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first for the page and scripts so updates show up; fall back to the cache offline.
  e.respondWith(
    fetch(req, { cache: 'no-cache' }) // always revalidate, so a new upload is never hidden by the HTTP cache
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
