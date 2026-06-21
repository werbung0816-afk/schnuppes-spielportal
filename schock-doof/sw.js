// Service Worker — Ingo's Schock Doof
// Cache-Version IMMER zusammen mit der VERSION-Konstante in index.html hochzählen,
// sonst bekommen Spieler nach einem Update weiter die alte gecachte Version.
const CACHE_VERSION = 'v5.60';
const CACHE_NAME = 'schock-doof-' + CACHE_VERSION;

const CORE_ASSETS = [
  './index.html',
  './manifest.json',
  './dice.mp3',
  './applause.mp3',
  './beersound.mp3',
  './Jingle1.mp3',
  './Jingle2.mp3',
  './what-a-fuck.mp3',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // einzeln cachen statt addAll, damit ein einzelner fehlender/unerreichbarer
      // Asset (z. B. noch nicht hochgeladener Sound) die Installation nicht abbricht
      return Promise.all(
        CORE_ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Firebase / externe Skripte nie über den Cache ausliefern — die brauchen Live-Netz
  if (!req.url.startsWith(self.location.origin)) return;

  // HTML-Seite selbst: Network-first, damit Updates schnell ankommen,
  // mit Cache-Fallback fürs Offline-Spielen.
  if (req.mode === 'navigate' || req.url.includes('index.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Alles andere (Icons, Sounds, Manifest): Cache-first, im Hintergrund auffrischen.
  // Audio-Elemente fordern mp3s oft per HTTP-Range an (Status 206) — solche Teilantworten
  // dürfen NICHT in den Cache (die Cache API wirft sonst einen TypeError), daher Status pruefen.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res.ok && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
