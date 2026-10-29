// Service worker: push + shell offline (network-first, só mesma origem).
const CACHE = 'mimo-v10';
const SHELL = ['./', './index.html', './app.js', './style.css', './supabase.js', './push.js', './install.js', './tour.js', './tour.css', './config.js',
  './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (e) => {
  // allSettled: um arquivo faltando não impede a instalação
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // supabase/esm.sh passam direto
  // no-cache: revalidate (cheap 304) so a deploy shows up now, not after GitHub Pages' 10-min max-age.
  // (by URL: a navigate-mode Request can't be re-created with options)
  e.respondWith(fetch(req.url, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((r) => r || (req.mode === 'navigate' ? caches.match('./') : Response.error()))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Me Dá Mimo', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: d.url || '' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL('./' + (e.notification.data?.url || ''), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => c.url.startsWith(self.registration.scope));
    return win ? win.focus().then((w) => (w || win).navigate(url)).catch(() => {}) : self.clients.openWindow(url);
  }));
});
