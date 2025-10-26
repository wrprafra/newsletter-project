// frontend/feed-api.js

// --- STATO INTERNO DEL MODULO API ---
let __cursor = null;
let __hasMore = true;
let __feedAbort = null;
let __ingestSSE = null;
let __sseUpdateQueue = [];
let __sseProcessTimer = null;

// --- GETTER ESPORTATI ---
export const hasMore = () => __hasMore;
export const cursor = () => __cursor;

// --- FUNZIONI ESPORTATE ---

/**
 * Carica la prima pagina del feed dal backend.
 * @returns {Promise<{items: Array, nextCursor: string|null, hasMore: boolean, ingest: object}>}
 */
export async function loadFirstPage() {
  __cursor = null;
  __hasMore = true;
  return await fetchPage(null);
}

/**
 * Carica la pagina successiva del feed usando un cursore.
 * @param {string} cursor - Il cursore per la pagina successiva.
 * @returns {Promise<{items: Array, nextCursor: string|null, hasMore: boolean, ingest: object}>}
 */
export async function fetchNextPage(cursor = __cursor) {
  if (!__hasMore) {
    return { items: [], nextCursor: cursor, hasMore: false, ingest: {} };
  }
  return await fetchPage(cursor);
}

export function stopIngestSSE() {
  if (__ingestSSE) { try { __ingestSSE.close(); } catch {} }
  __ingestSSE = null;
  if (__sseProcessTimer) { clearTimeout(__sseProcessTimer); __sseProcessTimer = null; }
  __sseUpdateQueue = [];
}
/**
 * Recupera i dati completi di un singolo item del feed.
 * @param {string} emailId - L'ID dell'email da recuperare.
 * @returns {Promise<object|null>}
 */
export async function getItem(emailId) {
  try {
    const res = await fetch(`${window.API_URL}/feed/item/${encodeURIComponent(emailId)}`, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`[API] Fallimento getItem per ${emailId}:`, e);
    return null;
  }
}

/**
 * Avvia l'ascolto degli eventi di ingestione dal server (SSE).
 * @param {string} jobId - L'ID del job di ingestione.
 * @param {function(Array<string>): void} onUpdate - Callback chiamato con un array di email_id di item aggiornati.
 * @param {function(object): void} onProgress - Callback chiamato con i dati di progresso.
 * @param {function(object): void} onEnd - Callback chiamato alla fine del job.
 */
export function startIngestSSE(jobId, { onUpdate = () => {}, onProgress, onEnd } = {}) {
  if (__ingestSSE) {
    try { __ingestSSE.close(); } catch {}
  }
  
  __sseUpdateQueue = [];
  if (__sseProcessTimer) { clearTimeout(__sseProcessTimer); __sseProcessTimer = null; }

  // Helper per chiamare i callback in modo sicuro
  const safe = (fn, ...args) => { try { fn?.(...args); } catch (e) { console.error("SSE callback error:", e); } };

  __ingestSSE = new EventSource(`${window.BACKEND_BASE}/api/ingest/events/${jobId}`, { withCredentials: true });

  const scheduleUpdate = (emailId) => {
    if (!__sseUpdateQueue.includes(emailId)) {
      __sseUpdateQueue.push(emailId);
    }
    if (__sseProcessTimer) clearTimeout(__sseProcessTimer);
    __sseProcessTimer = setTimeout(() => {
      const idsToProcess = Array.from(new Set(__sseUpdateQueue));
      __sseUpdateQueue = [];
      if (idsToProcess.length > 0) {
        safe(onUpdate, idsToProcess);
      }
    }, 800);
  };

  const cleanup = () => {
    if (__ingestSSE) {
      __ingestSSE.close();
      __ingestSSE = null;
    }
    if (__sseProcessTimer) clearTimeout(__sseProcessTimer);
    __sseProcessTimer = null;
    __sseUpdateQueue = [];
  };

  __ingestSSE.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data || '{}');
      safe(onProgress, data);
      if (data.state === 'done' || data.state === 'failed') {
        safe(onEnd, data);
        cleanup();
      }
    } catch {}
  };
  
  __ingestSSE.addEventListener('update', (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data.email_id) {
            scheduleUpdate(data.email_id);
        }
      } catch {}
  });

  __ingestSSE.onerror = () => {
    safe(onEnd, { state: 'failed', reason: 'sse_error' });
    cleanup();
  };
}

/**
 * Invia al backend la richiesta di aggiornare le immagini per una lista di email.
 * @param {Array<string>} emailIds - Lista degli ID delle email.
 * @param {string} source - La sorgente delle immagini ('pixabay' o 'google_photos').
 * @returns {Promise<Array>} La lista degli item aggiornati.
 */
export async function updateImages(emailIds, source) {
  try {
    const body = { email_ids: emailIds, image_source: source };
    if (source === 'pixabay') body.only_empty = true;

    const res = await fetch(`${window.API_URL}/feed/update-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
        if (res.status === 409) throw new Error('pool_empty');
        throw new Error(`API error ${res.status}`);
    }
    const data = await res.json();
    return data.updated_items || [];
  } catch (e) {
    console.error(`[API] Fallimento updateImages:`, e);
    throw e;
  }
}

/**
 * Restituisce l'URL del proxy per un'immagine esterna.
 * @param {string} externalUrl - L'URL dell'immagine originale.
 * @returns {string} L'URL che passa attraverso il proxy del backend.
 */
export function toProxy(externalUrl) {
  if (!externalUrl) return '';
  if (externalUrl.startsWith('data:') || !externalUrl.startsWith('http')) return externalUrl;
  return `${window.BACKEND_BASE}/api/img?u=${encodeURIComponent(externalUrl)}`;
}

// --- FUNZIONI INTERNE ---

export function abortFeed() {
  __feedAbort?.abort();
}

export function unmount() {
  if (__readObserver) { __readObserver.disconnect(); __readObserver = null; }
  if (__scrollObserver) { __scrollObserver.disconnect(); __scrollObserver = null; }
  
  // Interrompe processi in background
  stopIngestSSE?.();
  abortFeed?.();

  // Pulisce lo stato interno
  __cardNodes.clear();
  __container = null;
  __sentinel = null;
}
/**
 * Funzione helper per eseguire la chiamata a /api/feed.
 * @param {string|null} cursor - Il cursore per la paginazione.
 * @returns {Promise<object>}
 */
async function fetchPage(cursor) {
  if (__feedAbort) {
    try { __feedAbort.abort(); } catch {}
  }
  const ctrl = new AbortController();
  __feedAbort = ctrl;

  const params = new URLSearchParams({ page_size: '20' });
  if (cursor) {
    params.set('before', cursor);
  }

  try {
    const res = await fetch(`${window.API_URL}/feed?${params.toString()}`, {
      credentials: 'include',
      signal: ctrl.signal,
    });

    if (!res.ok) throw new Error(`fetch_failed_${res.status}`);

    const data = await res.json();
    const page = Array.isArray(data?.feed) ? data.feed : [];

    __cursor = data.next_cursor ?? null;
    __hasMore = Boolean(data.has_more);

    return {
      items: page,
      nextCursor: __cursor,
      hasMore: __hasMore,
      ingest: data.ingest || {},
    };
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error("[API] Errore in fetchPage:", err);
    }
    return { items: [], nextCursor: cursor, hasMore: __hasMore, ingest: {} };
  } finally {
    if (__feedAbort === ctrl) {
      __feedAbort = null;
    }
  }
}