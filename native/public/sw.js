// Push only. Do not cache the console — a stale service worker is a second
// copy of locusrifle, and this origin is a live agent.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
	event.waitUntil(self.registration.showNotification('locusrifle', {
		body: 'pi is ready',
		tag: 'locusrifle-ready',
		renotify: true,
	}));
});

self.addEventListener('notificationclick', event => {
	event.notification.close();
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		for (const client of windows) {
			if ('focus' in client) { await client.focus(); return; }
		}
		if (self.clients.openWindow) await self.clients.openWindow('/');
	})());
});
