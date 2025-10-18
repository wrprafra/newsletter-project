// sw.js — Progressive runtime caching (safe + fast)

const VERSION = 'v1.9'; // --- FIX: Versione incrementata ---
const C_STATIC = `static-${VERSION}`;
const C_IMAGES = `images-${VERSION}`;
const C_API    = `api-${VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/img/the-gist-icon.png',
  '/img/loading.gif',
  '/favicon.png',
  '/img/icons/icon-192.png',
  '/img/icons/icon-512.png'
];

/* ---------- helpers ---------- */
const isSameOrigin = (u) => new URL(u, self.location.href).origin === self.location.origin;

const shouldCacheResponse = (res) => {
  if (!res || !res.ok) return false;
  const cc = (res.headers.get('Cache-Control') || '').toLowerCase();
  return !cc.includes('no-store'); // be conservative; allow SWR on others
};

const apiCacheable = (pathname) => [
  /^\/api\/img(?:$|\/)/,       // image proxy
  /^\/api\/gmail\/messages\/[^/]+\/view$/ // reader HTML
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
    // clean old caches
    const keep = new Set([C_STATIC, C_IMAGES, C_API]);
    for (const name of await caches.keys()) {
      if (!keep.has(name)) await caches.delete(name);
    }
    // opt-in: navigation preload (if supported)
    if ('navigationPreload' in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

/* ---------- messaging (optional: let UI trigger update) ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // --- BLOCCO DI BYPASS UNIFICATO E PULITO ---
  // Ignora completamente le richieste non-GET e quelle a domini esterni.
  if (req.method !== 'GET' || !isSameOrigin(url)) {
    return;
  }

  // Ignora completamente il flusso di autenticazione e gli eventi SSE.
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/ingest/events')) {
    return; // Lascia che la richiesta vada direttamente alla rete.
  }
  // --- FINE BLOCCO DI BYPASS ---

  // 1) IMAGES: cache-first (includes /api/img)
  if (req.destination === 'image' || url.pathname.startsWith('/api/img')) {
    event.respondWith((async () => {
      const cache = await caches.open(C_IMAGES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (shouldCacheResponse(res)) {
          try { await cache.put(req, res.clone()); } catch {}
        }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 2) API: stale-while-revalidate for allowlisted endpoints only
  if (url.pathname.startsWith('/api/')) {
    if (!apiCacheable(url.pathname)) {
      return;
    }
    event.respondWith((async () => {
      const cache = await caches.open(C_API);
      const cached = await cache.match(req);
      const network = fetch(req).then(async (res) => {
        if (shouldCacheResponse(res)) {
          try { await cache.put(req, res.clone()); } catch {}
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })());
    return;
  }

  // 3) NAVIGATIONS: network-first with navigation preload and shell fallback
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = 'preloadResponse' in event ? await event.preloadResponse : null;
        if (preload) return preload;
        const res = await fetch(req);
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

  // 4) STATIC ASSETS (scripts/styles/fonts): SWR
  if (['script', 'style', 'font'].includes(req.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(C_STATIC);
      const cached = await cache.match(req);
      const network = fetch(req).then(async (res) => {
        if (shouldCacheResponse(res)) {
          try { await cache.put(req, res.clone()); } catch {}
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })());
    return;
  }
});