// Network-first for API and pages (fresh numbers and app updates), cache-first for hashed assets (offline launch).
const SHELL = 'petf-shell-v2';
const remember = (req, res) => { const c = res.clone(); caches.open(SHELL).then(x => x.put(req, c)); return res; };
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('petf-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname === '/api/backup') return;   // always live, and never keep a full copy in the browser cache
  if (u.pathname.startsWith('/api')) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open('petf-api').then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  if (u.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => remember(e.request, r))));
    return;
  }
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(fetch(e.request).then(r => remember(key, r)).catch(() => caches.match(key)));
});
