// sw.js — Progressive runtime caching (safe + fast)

const VERSION = 'v2.4'; // Versione incrementata per forzare l'aggiornamento
const ASSET_VERSION = '20251030a';
const C_STATIC = `static-${VERSION}`;
const C_IMAGES = `images-${VERSION}`;
const C_API    = `api-${VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  `/app.js?v=${ASSET_VERSION}`,
  '/feed-api.js',
  '/feed-store.js',
  '/feed-view.js',
  '/style.css',
  `/style.css?v=${ASSET_VERSION}`,
  '/manifest.json', // <-- FIX 1: Aggiunto manifest.json
  '/img/the-gist-icon.png',
  '/img/loading.gif',
  '/favicon.png',
  '/img/icons/icon-192.png',
  '/img/icons/icon-512.png'
];

/* ---------- helpers ---------- */
const isSameOrigin = (u) => new URL(u, self.location.href).origin === self.location.origin;

const shouldCacheResponse = (res) => {
  if (!res) return false; // Non `res.ok` perché vogliamo poter fare SWR anche su errori temporanei
  const cc = (res.headers.get('Cache-Control') || '').toLowerCase();
  return !cc.includes('no-store');
};

const apiCacheable = (pathname) => [
  /^\/api\/img(?:$|\/)/,
  /^\/api\/gmail\/messages\/[^/]+\/view$/
].some(rx => rx.test(pathname));

/* ---------- install ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(C_STATIC).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ---------- activate ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([C_STATIC, C_IMAGES, C_API]);
    for (const name of await caches.keys()) {
      if (!keep.has(name)) await caches.delete(name);
    }
    if ('navigationPreload' in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

/* ---------- messaging ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // --- BLOCCO DI BYPASS UNIFICATO E RAFFORZATO ---
  if (req.method !== 'GET' || !isSameOrigin(url)) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return; // <-- FIX 3
  if (req.headers.get('accept')?.includes('text/event-stream')) return; // <-- FIX 4
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/ingest/events')) return;

  // 1) IMAGES: cache-first con fallback a placeholder
  if (req.destination === 'image' || url.pathname.startsWith('/api/img')) {
    event.respondWith((async () => {
      const cache = await caches.open(C_IMAGES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (shouldCacheResponse(res)) { try { await cache.put(req, res.clone()); } catch {} }
        return res;
      } catch {
        // <-- FIX 2: Fallback a un'immagine placeholder invece di errore 504
        const placeholder = await (await caches.open(C_STATIC)).match('/img/loading.gif');
        return placeholder || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 2) API CACHEABILI: stale-while-revalidate
  if (url.pathname.startsWith('/api/')) {
    if (!apiCacheable(url.pathname)) return;
    
    event.respondWith((async () => {
      const cache = await caches.open(C_API);
      const cached = await cache.match(req);
      const network = fetch(req).then(async (res) => {
        // <-- FIX 5: Metti in cache solo le risposte 200 OK
        if (res.status === 200 && shouldCacheResponse(res)) {
          try { await cache.put(req, res.clone()); } catch {}
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })());
    return;
  }

  // 3) NAVIGATIONS: network-first con fallback alla shell
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = 'preloadResponse' in event ? await event.preloadResponse : null;
        if (preload) return preload;
        const res = await fetch(req);
        // Aggiorna la cache della shell se la navigazione ha successo
        if (url.pathname === '/' || url.pathname === '/index.html') {
          try { (await caches.open(C_STATIC)).put(req, res.clone()); } catch {}
        }
        return res;
      } catch {
        const cache = await caches.open(C_STATIC);
        return (await cache.match('/index.html')) || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 4) STATIC ASSETS (scripts/styles/fonts): stale-while-revalidate
  if (['script', 'style', 'font'].includes(req.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(C_STATIC);
      const cached = await cache.match(req);
      const network = fetch(req).then(async (res) => {
        // <-- FIX 5 (applicato anche qui per coerenza)
        if (res.status === 200 && shouldCacheResponse(res)) {
          try { await cache.put(req, res.clone()); } catch {}
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })());
    return;
  }
});
