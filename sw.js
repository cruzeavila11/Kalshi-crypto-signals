// Retirement worker: no protected resources are cached or served offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => /^kalshi/i.test(name)).map(name => caches.delete(name)));
  await self.clients.claim();
  await self.registration.unregister();
})()));
