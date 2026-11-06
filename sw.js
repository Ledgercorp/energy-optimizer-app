// Offline support: caches the app shell, the public weather files and the read-only Cloudflare weather API as they are fetched.
// Requests to other sites and your personal data are never cached here.
const CACHE = 'aeo-v21';
const API = 'https://aeo-public.colbyweiss15.workers.dev';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'core.js', 'weather.js', 'advisor.js', 'thermostat.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

// allSettled: a missing optional file (e.g. icons in local dev) must not block offline support.
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || (u.origin !== location.origin && u.origin !== API)) return;
  // Network first so updates appear; cached copy keeps the app working offline.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
