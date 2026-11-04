self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some(client => client.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'Zbuddy', {
      body: data.body || 'New message', icon: '/favicon.svg', badge: '/favicon.svg',
      tag: data.conversationId ? `conversation-${data.conversationId}` : 'zbuddy',
      renotify: true, data: { url: data.url || '/' }, timestamp: data.created || Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows[0];
    if (client) { await client.navigate(target); return client.focus(); }
    return self.clients.openWindow(target);
  })());
});
