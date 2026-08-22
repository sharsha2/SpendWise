/* Self-destructing service worker.
   Caching is disabled for Moneta: this file exists only so browsers that
   installed an earlier version fetch it, remove every cache, and unregister —
   after which all visits load fresh from the server with no cache at all. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.navigate(client.url));
  })());
});
