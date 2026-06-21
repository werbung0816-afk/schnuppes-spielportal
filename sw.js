/*
  Schnuppes Spielportal – Service Worker
  Strategie: NETWORK-FIRST.
  -> Portal UND Spiele laden immer zuerst aus dem Netz (frische Version).
  -> Der Cache enthält nur den App-Rahmen (Startseite + Icons) und greift
     ausschließlich als Notfall-Fallback, wenn keine Verbindung besteht.
  Spiele werden bewusst NICHT gecacht.
*/

const CACHE = 'portal-shell-v1';

// Nur der App-Rahmen wird vorgehalten – keine Spiele.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Portal-Startseite = Scope-URL oder Scope-URL + "index.html"
  const scope = self.registration.scope;
  const isPortalRoot = req.url === scope || req.url === scope + 'index.html';

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Nur den App-Rahmen (Portal-Startseite) im Hintergrund aktualisieren.
        if (isPortalRoot && res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        // Offline: Spiele sind nicht gecacht -> wir landen auf der Portal-Startseite,
        // damit das Tablet einen funktionierenden Bildschirm zeigt statt einer Fehlerseite.
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
