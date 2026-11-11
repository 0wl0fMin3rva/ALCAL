// AlCal service worker: offline cache, plus push notifications for reminders.
const CACHE = 'alcal-v15';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './seal.png', './quotes.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const url = new URL(e.request.url);
  const page = e.request.mode === 'navigate' || /\/(index\.html)?$/.test(url.pathname) || /\.js$/.test(url.pathname);
  const save = res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; };
  if (page) {
    // The app itself: always try the network first, so a new version shows on the next reload.
    // Offline (or no answer within 4 seconds), the saved copy is used.
    e.respondWith(new Promise(resolve => {
      let done = false;
      const fallback = () => caches.match(e.request, {ignoreSearch: true}).then(c => c || caches.match('./index.html'));
      const timer = setTimeout(() => fallback().then(c => { if (c && !done) { done = true; resolve(c); } }), 4000);
      fetch(e.request, {cache: 'no-cache'}).then(res => { clearTimeout(timer); save(res); if (!done) { done = true; resolve(res); } })
        .catch(() => { clearTimeout(timer); fallback().then(c => { if (!done) { done = true; resolve(c || Response.error()); } }); });
    }));
    return;
  }
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(cached => {
    const fresh = fetch(e.request).then(save).catch(() => cached);
    return cached || fresh;
  }));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.title || 'AlCal', {
    body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png', data: {url: './'}
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const w of list) if ('focus' in w) return w.focus();
    return self.clients.openWindow('./');
  }));
});
