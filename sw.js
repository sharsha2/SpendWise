/* Moneta service worker — network first, cache as offline fallback.
   Every load still goes to the server first, so a normal refresh always gets
   the latest version (the reason caching used to be disabled). The cache is
   only used when there is no connection, so the app also works offline.
   Only the app's own files are cached; transactions are never stored here. */
const CACHE = 'moneta-v3';
const APP_FILES = [
  './',
  'index.html',
  'app.js',
  'statement-import.js',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-512.png',
  'vendor/xlsx/xlsx.full.min.js',
  'vendor/chartjs/chart.umd.min.js',
  'vendor/fontawesome/css/all.min.css',
  'vendor/fontawesome/webfonts/fa-solid-900.woff2',
  'vendor/fontawesome/webfonts/fa-regular-400.woff2',
  'vendor/inter/inter-latin-wght-normal.woff2',
  'vendor/inter/inter-latin-ext-wght-normal.woff2',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-cache' });
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});
