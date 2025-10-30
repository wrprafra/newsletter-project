// ===================================================================
// CONFIGURAZIONE E VARIABILI DI STATO GLOBALI
// ===================================================================
function safeStringify(v){
  const seen = new WeakSet();
  return JSON.stringify(v, (k, val) => {
    if (typeof val === 'function') return undefined;
    if (typeof val === 'object' && val !== null){
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

async function logToServer(level, ...args) {
  try {
    const api = window.API_URL; if (!api) return;
    const message = args.map(a => {
      try { 
        const parsed = JSON.parse(safeStringify(a));
        return typeof parsed === 'string' ? redact(parsed) : parsed;
      } catch { 
        return redact(String(a));
      }
    });
    const messageString = message.map(part => {
      if (typeof part === 'string') return part;
      try { return JSON.stringify(part); } catch { return String(part); }
    }).join(' | ');
    const payload = safeStringify({ level, message: messageString });

    if (document.visibilityState === 'hidden' && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(`${api}/log`, blob); return;
    }
    await fetch(`${api}/log`, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: payload, keepalive:true
    });
  } catch {}
}


// Sovrascrivi le funzioni della console per inviare i log anche al server
if (!window.__consoleWrapped) {
  const _log   = console.log.bind(console);
  const _warn  = console.warn.bind(console);
  const _error = console.error.bind(console);

  window.__rawConsole = { log: _log, warn: _warn, error: _error };

  const _send = (level, args) => { try { logToServer(level, ...args); } catch (_) {} };

  console.log  = (...args) => { _log(...args);  _send('info',  args); };
  console.warn = (...args) => { _warn(...args); _send('warn',  args); };
  console.error= (...args) => { _error(...args);_send('error', args); };

  window.__consoleWrapped = true;
}

window.BACKEND_BASE = location.origin;
window.API_URL = `${window.BACKEND_BASE}/api`;
let API_URL = window.API_URL;
window.__DEBUG_FEED = true;
window.__ASSET_VERSION = '20251030g';
console.log(`[BUILD] frontend ${window.__ASSET_VERSION}`);
try {
  fetch(`${window.API_URL}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      level: 'info',
      message: `[FRONTEND_BOOT] ${window.__ASSET_VERSION} ua=${navigator.userAgent || 'n/a'}`
    })
  }).catch(() => {});
} catch (err) {
  console.warn('[FRONTEND_BOOT] ping fallito', err);
}

window.addEventListener('error', (event) => {
  try {
    logToServer('error', '[window.error]', {
      message: event.message || null,
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null
    });
  } catch (_) {}
});

window.addEventListener('unhandledrejection', (event) => {
  try {
    logToServer('error', '[window.unhandledrejection]', {
      reason: event.reason ? String(event.reason) : null
    });
  } catch (_) {}
});

function dlog(group, obj = {}) {
  if (!window.__DEBUG_FEED) return;
  try {
    console.groupCollapsed(`[FEED] ${group}`);
    console.log(obj);
    console.groupEnd();
  } catch (e) {
    console.log(`[FEED] ${group}`, obj);
  }
}

const pauseCss = hidden => document.documentElement.classList.toggle('prefers-reduced-motion', hidden);
document.addEventListener('visibilitychange', () => pauseCss(document.visibilityState !== 'visible'));

const SPLASH_MIN_DURATION_MS = 1000;
let __splashShownAt = 0;
let __splashHideTimer = null;
let __splashVisible = false;

function showSplash() {
  const splashEl = document.getElementById('splash-screen');
  if (!splashEl) return;
  __splashVisible = true;
  splashEl.classList.remove('splash-hidden');
  splashEl.classList.add('splash-visible');
  __splashShownAt = performance.now();
  clearTimeout(__splashHideTimer);
}

function hideSplash(force = false) {
  const splashEl = document.getElementById('splash-screen');
  if (!splashEl) return;

  if (!force && !__splashVisible) return;

  const elapsed = performance.now() - __splashShownAt;
  if (!force && __splashVisible && elapsed < SPLASH_MIN_DURATION_MS) {
    clearTimeout(__splashHideTimer);
    __splashHideTimer = window.setTimeout(() => hideSplash(true), SPLASH_MIN_DURATION_MS - elapsed);
    return;
  }

  __splashVisible = false;
  splashEl.classList.remove('splash-visible');
  splashEl.classList.add('splash-hidden');
  clearTimeout(__splashHideTimer);
}

window.__hideSplashScreen = hideSplash;
window.__showSplashScreen = showSplash;

// Evita doppie navigazioni verso /auth/login se l'utente clicca ripetutamente
document.addEventListener('click', (event) => {
  const loginLink = event.target.closest('a[href="/auth/login"]');
  if (!loginLink) return;
  if (loginLink.dataset.authLock === '1') {
    event.preventDefault();
    return;
  }
  loginLink.dataset.authLock = '1';
  loginLink.setAttribute('aria-disabled', 'true');
  loginLink.classList.add('cta-disabled');
}, true);

// Flag di stato dell'applicazione
let __activeTopic = null;
let __activeSender = null;
let __activePersonalTag = null;
let __typeTarget = null;
let __bootReady = false;
let __inFlight = false;
let __isIngesting = false;
let __isInitialIngesting = false;
let __initialLoadDone = false;
let __renderScheduled = false;
let __autoIngesting = false;
let __app_started = false;
let tailTimer = null;
const TYPE_ORDER = ['newsletter', 'promo', 'personali', 'informative'];
let activeTypes = new Set(TYPE_ORDER);
let __cursor = null;
let __hasMore = false;
let allFeedItems = [];
let __view = 'all'; // Stato della vista: 'all' o 'favorites'
const itemsById = new Map(); // Cache per accedere agli item per ID
let __endStreak = 0;
let __feedAbort = null;
let __feedCursor = null;
let __lastIngestAt = 0;
let __sseOpen = false;
let __sseUpdateQueue = [];
let __sseProcessTimer = null;
let __didBackfillOnce = false;
const FIRST_PAINT_COUNT = 4;
let __firstPaintDone = false;
const READ_STATES = ['read','unread'];
let activeReads = new Set(READ_STATES);
const readFilterKey = () => `activeReads:${EVER_KEY}`;
function saveActiveReads(){ try{ localStorage.setItem(readFilterKey(), JSON.stringify([...activeReads])); }catch{} }

const PTR_DEFAULT_TEXT = 'Tira per aggiornare';
const PTR_LOADERS = new Map();

function ptrUpdateHint() {
  const ptr = document.getElementById('ptr');
  if (!ptr) return;
  const textEl = ptr.querySelector('.ptr-text');
  if (!textEl) return;
  if (PTR_LOADERS.size === 0) {
    textEl.textContent = PTR_DEFAULT_TEXT;
  } else {
    const values = Array.from(PTR_LOADERS.values());
    const lastText = values[values.length - 1] || 'Sto sincronizzando nuove newsletter…';
    textEl.textContent = lastText;
  }
}

function ptrShowLoading(token = `ptr-${Date.now()}`, text = 'Sto sincronizzando nuove newsletter…') {
  const ptr = document.getElementById('ptr');
  if (!ptr) return token;
  PTR_LOADERS.set(token, text);
  ptr.classList.add('ptr--loading');
  ptrUpdateHint();
  return token;
}

function ptrHideLoading(token) {
  const ptr = document.getElementById('ptr');
  if (!ptr) return;
  if (token) PTR_LOADERS.delete(token);
  if (PTR_LOADERS.size === 0) {
    ptr.classList.remove('ptr--loading');
  }
  ptrUpdateHint();
}

// Failsafe: rimuove qualsiasi stato di loading del PTR
function ptrForceClear() {
  try {
    PTR_LOADERS.clear();
  } catch {}
  const ptr = document.getElementById('ptr');
  if (ptr) ptr.classList.remove('ptr--loading');
  ptrUpdateHint();
}

function ptrWaitUntilIdle(token) {
  const poll = () => {
    if (!window.__isIngesting && !window.__autoIngesting) {
      ptrHideLoading(token);
    } else {
      setTimeout(poll, 250);
    }
  };
  poll();
}

function ptrSetHint(text) {
  if (PTR_LOADERS.size > 0) return;
  const ptr = document.getElementById('ptr');
  const hint = typeof text === 'string' && text.length ? text : PTR_DEFAULT_TEXT;
  const txt = ptr ? ptr.querySelector('.ptr-text') : null;
  if (txt) txt.textContent = hint;
}

// let WINDOW_GMAIL_POPUP = null;
// let POPUP_POLL_TIMER = null;
// let lastGmailUrl = '';
// const POPUP_FEATURES_DESKTOP = 'width=1100,height=800,menubar=no,toolbar=no,location=yes,resizable=yes,scrollbars=yes';


 // Verrà inizializzato in DOMContentLoaded
let endOfFeedEl;

// Stato dei processi in background (SSE, cooldown)
let __ingestSSE = null;
let __ingestCooldownUntil = 0;
let __io;
let __firstRunJobId = null;
let __firstRunES = null;

// Stato dell'autenticazione e GSI
let tokenClient;
let gisInited = false;

// Stato UI e helper
let __emailOpenSeq = 0;
let lastFocusedEl = null;
let backgroundUpdateInterval = null;

// Costanti dell'applicazione
// let activeTypes = new Set(TYPE_OPTIONS); 
const __PAGE_SIZE = 20;
const placeholderNodes = window.placeholderNodes || new Map();
window.placeholderNodes = placeholderNodes;
const cardNodes = new Map();
const __colorCache = new Map();
const __mountedIds = new Set();
const __renderedIds = new Set();
const FEED_FOOTER_ID = "feed-loading-footer";
const __IMG_CACHE = new Map();
const SKELETON_CLASS = "skeleton-card";
const EVER_KEY_PREFIX = 'feedEverLoaded:';
const FEED_STATE = {
  everLoaded: false,
  inFlight: null,
  initialSkeletonsVisible: false,
  loadingFooterVisible: false,
};
let EVER_KEY = EVER_KEY_PREFIX + 'anonymous';

const originalConsole = window.__rawConsole || {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const __sseRetry = new Map(); // id -> n
async function fetchItem(id){
  const r = await fetch(`${API_URL}/feed/item/${id}`, { credentials:'include', cache:'no-store' });
  if (!r.ok) throw new Error(`fetch_failed_${r.status}`);
  return r.json();
}

function redact(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/([?&](?:access_)?token=)[^&]+/gi, '$1[REDACTED]')
    .replace(/("Authorization":\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g, '[EMAIL_REDACTED]')
    .replace(/\b(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){7,14}\b/g, '[PHONE_REDACTED]')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[IBAN_REDACTED]');
}

async function processSseUpdateQueue(){
  if (__sseUpdateQueue.length === 0) return;
  const ids = [...new Set(__sseUpdateQueue)]; __sseUpdateQueue = [];
  const results = await Promise.allSettled(ids.map(fetchItem));
  const newItems = [];

  for (let i=0; i<results.length; i++){
    const res = results[i], id = ids[i];
    if (res.status === 'fulfilled' && res.value && !__mountedIds.has(res.value.email_id)) {
      newItems.push(res.value);
      __sseRetry.delete(id); // Successo, resetta il contatore
    } else {
      const n = (__sseRetry.get(id) || 0) + 1;
      if (n <= 3) {
        __sseRetry.set(id, n);
        const delay = 800 * (2**(n-1)) + Math.random() * 200; // Aggiungi jitter
        feLog('warn','sse.item.retry',{id, attempts:n, delay});
        setTimeout(()=>{ scheduleSseUpdate(id); }, delay);
      } else {
        feLog('warn','sse.item.drop',{id, attempts:n, error: res.reason?.message});
        __sseRetry.delete(id); // Drop definitivo, resetta
      }
    }
  }

  if (newItems.length > 0) {
    newItems.sort((a, b) => new Date(b.received_date) - new Date(a.received_date));
    await upsertFeedItems(newItems, { prepend:true });
    mergeFeedMemory(newItems);
  }
  
  applyViewFilter(); 
  reconcileEndOfFeed();
}

function scheduleSseUpdate(emailId) {
  if (!emailId) return;
  if (!__sseUpdateQueue.includes(emailId)) {
    __sseUpdateQueue.push(emailId);
    // <-- MODIFICA: Se siamo alla fine del feed, mostra subito uno skeleton per un feedback immediato
    if (!__hasMore) {
      try { getOrCreatePlaceholder(emailId); } catch {}
    }
  }
  
  if (__sseProcessTimer) clearTimeout(__sseProcessTimer);
  // La guardia `if (!__sseOpen) return;` è stata rimossa per permettere il flush finale.
  __sseProcessTimer = setTimeout(processSseUpdateQueue, 800);
}

function formatDate(isoLike) {
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('it-IT', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Esegue l'escape dei caratteri speciali HTML per prevenire XSS.
 * @param {string} s La stringa da sanitizzare.
 * @returns {string} La stringa sanitizzata.
 */
function esc(s = '') {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/**
 * Esegue l'escape di una stringa da usare all'interno di un attributo HTML.
 * @param {string} s La stringa da sanitizzare.
 * @returns {string} La stringa sanitizzata per l'attributo.
 */
function escAttr(s = '') {
  return esc(s); // Per ora usa la stessa logica, ma è separata per future customizzazioni.
}

function feLog(level, code, ctx = {}) {
  const msg = `[FE][${level}] ${code} ${JSON.stringify(ctx)}`;

  // usa la console "originale" per non attivare l'override che invia al server
  const fn =
    level === 'error' ? originalConsole.error :
    level === 'warn'  ? originalConsole.warn  :
                        originalConsole.log;

  fn(msg);

  // ❌ niente logToServer qui (evita i duplicati)
  // try { logToServer(level, msg); } catch {}
}

// === DIAGNOSTICA ===
(function installDiagnostics(){
  if (!window.__DEBUG) return; // abilita solo se imposti window.__DEBUG=true da console
  // (il resto del corpo resta vuoto)
})();
// ===================================================================
// DICHIARAZIONE DELLE VARIABILI PER GLI ELEMENTI DEL DOM
// (Verranno popolate in DOMContentLoaded)
// ===================================================================
let feedContainer;
let loginMessage;
let sentinel;
let domainDropdown, btnFilterByDomain, btnAllInboxes;
let footerNav, domainSearch, domainListEl, domainApplyBtn, domainCancelBtn;
let domainSelectAll, domainClearAll, updateFeedBtn;
let logoutBtn, profileSheet, hideMenu;
let choosePhotoBtn, sheetCloseBtn, gphotosMenuBtn, gphotosMenu, pickBtn;
let hiddenSheet, hiddenDomainsList, hiddenThreadsList, openHiddenBtn, hiddenSheetBackdrop, closeHiddenSheetBtn;
const READ_SECONDS = 2;
let __readObserver;
const __readState = new Map(); // id -> { seen:ms, t0:hrtime, timer }
function readKey(){ return `readThreads:${EVER_KEY || 'anonymous'}`; }
let __readSet = loadReadSet();

function isRead(id){ return __readSet.has(String(id)); }

function loadReadSet() {
  try {
    const raw = localStorage.getItem(readKey());
    if (!raw) return new Set();
    
    const data = JSON.parse(raw);
    // Controlla se è il nuovo formato compresso
    if (data && typeof data.b !== 'undefined' && Array.isArray(data.d)) {
      let lastId = Number(data.b) || 0;
      const out = [String(lastId)];
      for (let i = 1; i < data.d.length; i++) {
        lastId += Number(data.d[i]) || 0;
        out.push(String(lastId));
      }
      return new Set(out);
    }
    // Fallback per il vecchio formato (array semplice)
    if (Array.isArray(data)) {
        return new Set(data);
    }
  } catch {}
  // Fallback finale se tutto fallisce
  return new Set();
}

const debounce = (fn, ms = 200) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function saveReadSet(){ 
  try{ 
    const arr = [...__readSet];
    const CAP = 5000;
    const trimmed = arr.slice(-CAP);
    localStorage.setItem(readKey(), JSON.stringify(trimmed)); 
  }catch{} 
}

function markRead(id){
  const s = String(id);
  if (__readSet.has(s)) return;
  __readSet.add(s); saveReadSet();
  const card = document.querySelector(`.feed-card[data-email-id="${CSS.escape(s)}"]`);
  if (card) card.classList.add('is-read');
  renderWithFilters(); // aggiorna subito lista e contatori
}

function applyReadUI(card){
  const read = isRead(card.dataset.emailId);
  card.classList.toggle('is-read', read);
}
function initReadObserver(){
  if (__readObserver) return;
  __readObserver = new IntersectionObserver((entries)=>{
    for (const e of entries){
      const card = e.target;
      const id = card.dataset.emailId;
      if (isRead(id)) { __readObserver.unobserve(card); continue; }
      let st = __readState.get(id) || { seen:0, t0:0, timer:null };
      const now = performance.now();
      const visible = e.isIntersecting && e.intersectionRatio >= 0.6;

      if (visible){
        st.t0 = now;
        const remaining = Math.max(0, READ_SECONDS*1000 - st.seen);
        st.timer = setTimeout(()=>{ markRead(id); __readObserver.unobserve(card); }, remaining);
      } else {
        if (st.timer){ clearTimeout(st.timer); st.timer = null; }
        if (st.t0){ st.seen += now - st.t0; st.t0 = 0; }
      }
      __readState.set(id, st);
    }
  }, { threshold: [0,0.6,1] });
}
function observeReadCard(card){
  initReadObserver();
  __readObserver.observe(card);
  applyReadUI(card);
}

function getOrCreatePlaceholder(email_id) {
  let el = placeholderNodes.get(email_id);
  if (el && el.isConnected) return el;
  const feedContainer = document.getElementById('feed-container');
  if (!feedContainer) throw new Error('feed-container non trovato');

  el = createSkeletonNode();               // usa il tuo creatore di skeleton
  el.dataset.emailId = email_id;
  feedContainer.appendChild(el);

  placeholderNodes.set(email_id, el);
  return el;
}

function removePlaceholder(email_id) {
  const el = placeholderNodes.get(email_id);
  if (el) { try { el.remove(); } catch {} }
  placeholderNodes.delete(email_id);
}

// Se non esistono già nel file, tieni anche queste utility minime:
function hasCards() {
  return !!document.querySelector('#feed-container .feed-card');
}

async function mapLimit(arr, limit, fn){
  const q = arr.slice(); 
  const running = new Set(); 
  const out = [];
  
  async function runner() {
    while (q.length > 0) {
      const item = q.shift();
      const p = fn(item).finally(() => running.delete(p));
      running.add(p);
      out.push(p);
      if (running.size >= limit) {
        await Promise.race(running);
      }
    }
    await Promise.all(running);
  }
  
  await runner();
  return Promise.allSettled(out);
}


function setSentinelBusy(text) {
  const el = document.getElementById('load-more-sentinel');
  if (!el) return;
  el.classList.remove('hidden');
  el.dataset.busy = '1';
  el.setAttribute('aria-busy', 'true');
  el.textContent = text || 'Carico altri…';
}

function closeEmailModal() {
  const m = document.getElementById('email-modal');
  if (!m) return;
  m.classList.add('hidden');
  document.body.classList.remove('body-lock');
  
  // Opzionale ma consigliato: ferma il caricamento dell'iframe
  const iframe = m.querySelector('iframe');
  if (iframe) {
    iframe.src = 'about:blank';
  }
}

function getBaseSetForCounters() {
  // I contatori devono essere coerenti con gli altri filtri attivi (es. preferiti, email nascoste)
  let base = allFeedItems.filter(it => !hiddenEmailIds.has(it.email_id));
  if (showOnlyFavorites) base = base.filter(it => !!it.is_favorite);

  // Aggiungi il filtro per topic e sender per avere contatori accurati
  if (__activeTopic) {
    base = base.filter(it => (it.topic_tag || '').toLowerCase() === __activeTopic.toLowerCase());
  }
  if (__activeSender) {
    base = base.filter(it => (it.sender_email || '').toLowerCase() === __activeSender);
  }
  
  return base;
}

function updateTypeMenuCounters() {
  const baseList = getBaseSetForCounters();
  const menu = document.getElementById('type-menu');
  if (!menu) return;

  // Contatori per tipologia
  const typeCounts = Object.fromEntries(TYPE_ORDER.map(t => [t, 0]));
  for (const it of baseList) {
    const t = (it.type_tag || 'informative').toLowerCase();
    if (typeCounts[t] != null) typeCounts[t]++;
  }
  TYPE_ORDER.forEach(t => {
    const row = menu.querySelector(`[data-type="${t}"]`);
    if (!row) return;
    const count = typeCounts[t] || 0;
    row.querySelector('.count').textContent = count;
    row.classList.toggle('bg-gray-100', activeTypes.has(t));
    row.setAttribute('aria-pressed', activeTypes.has(t) ? 'true' : 'false');
  });

  // Contatori per stato di lettura
  const totalRead = baseList.filter(it => isRead(it.email_id)).length;
  const totalUnread = baseList.length - totalRead;
  menu.querySelector('[data-read="read"] .count').textContent = String(totalRead);
  menu.querySelector('[data-read="unread"] .count').textContent = String(totalUnread);

  // Aggiornamento UI per stato di lettura
  menu.querySelectorAll('[data-read]').forEach(b => {
    const on = activeReads.has(b.dataset.read);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('bg-gray-100', on);
  });
}



window.__TYPE_MENU_INITIALIZED__ = window.__TYPE_MENU_INITIALIZED__ || false;

function initTypeMenu() {
  if (window.__TYPE_MENU_INITIALIZED__) return;

  const btn = document.getElementById('btnTypeFilter');
  const menu = document.getElementById('type-menu');
  if (!btn || !menu) return;

  const placeMenu = () => {
    const r = btn.getBoundingClientRect();
    const prevHidden = menu.classList.contains('hidden');
    if (prevHidden) {
      menu.classList.remove('hidden');
      menu.style.visibility = 'hidden';
    }
    const mw = menu.offsetWidth || 224;
    const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    const top = r.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    if (prevHidden) {
      menu.classList.add('hidden');
    }
    menu.style.visibility = '';
  };

  btn.style.touchAction = 'manipulation';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.classList.contains('hidden');
    if (opening) {
      menu.classList.remove('hidden');
      menu.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        placeMenu();
        menu.style.visibility = '';
        updateTypeMenuCounters();
      });
    } else {
      menu.classList.add('hidden');
    }
  });

  // Listener unico per gestire tutti i click all'interno del menu
  menu.addEventListener('click', (e) => {
    // Gestione filtro LETTO / NON LETTO
    const rbtn = e.target.closest('button[data-read]');
    if (rbtn){
      const key = rbtn.dataset.read; // 'read' | 'unread'
      const on = activeReads.has(key);
      if (on && activeReads.size === 1) return; // non spegnere l’ultimo
      on ? activeReads.delete(key) : activeReads.add(key);
      saveActiveReads();
      renderWithFilters();
      return;
    }

    // Gestione filtro TIPOLOGIA (codice esistente)
    const el = e.target.closest('[data-type]');
    if (el) {
      const t = el.dataset.type;
      if (activeTypes.has(t) && activeTypes.size === 1) {
        showToast('Almeno una tipologia deve rimanere attiva.', 'warn');
        return;
      }
      activeTypes.has(t) ? activeTypes.delete(t) : activeTypes.add(t);
      try {
        localStorage.setItem(`activeTypes:${EVER_KEY}`, JSON.stringify([...activeTypes]));
      } catch (e) {}
      renderWithFilters();
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') menu.classList.add('hidden');
  });

  window.__TYPE_MENU_INITIALIZED__ = true;
  console.log("[TypeMenu] Inizializzazione completata correttamente.");
}

document.addEventListener('click', (e) => {
  // Gestione dei filtri per topic e sender
  const topicBtn = e.target.closest('.js-topic');
  if (topicBtn) {
    const v = (topicBtn.dataset.topic || '').trim();
    __activeTopic = (__activeTopic === v) ? null : v;
    renderWithFilters();
    return; // Azione completata
  }
  
  const senderBtn = e.target.closest('.js-sender');
  if (senderBtn) {
    const v = (senderBtn.dataset.sender || '').trim();
    __activeSender = (__activeSender === v) ? null : v;
    renderWithFilters();
    return; // Azione completata
  }

  // Gestione chiusura modale email
  if (e.target.matches('[data-close="email-modal"]')) {
    e.preventDefault();
    closeEmailModal();
  }
  
  // Gestione chiusura menu a tendina (se si clicca fuori da essi)
  const typeMenu = document.getElementById('type-menu');
  if (typeMenu && !typeMenu.classList.contains('hidden') && !typeMenu.contains(e.target) && !e.target.closest('#btnTypeFilter')) {
    typeMenu.classList.add('hidden');
  }

  const overrideMenu = document.getElementById('type-override-menu');
  if (overrideMenu && !overrideMenu.classList.contains('hidden') && !overrideMenu.contains(e.target) && !e.target.closest('.js-type-edit')) {
    overrideMenu.classList.add('hidden');
  }
});

// Listener #2: Gestisce specificamente la chiusura del menu "nascondi"
document.addEventListener('click', (e) => {
  const menu = document.getElementById('hide-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  // Ignora i click sul bottone che apre il menu e dentro il menu stesso
  if (e.target.closest('[data-action="hide"]')) return;
  if (!menu.contains(e.target)) {
    menu.classList.add('hidden');
  }
}, { capture: true });

const closeTypeOverride = () =>
  document.getElementById('type-override-menu')?.classList.add('hidden');

['scroll','wheel','touchmove','resize'].forEach(ev =>
  window.addEventListener(ev, closeTypeOverride, { passive: true })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTypeOverride();
});


function resolveGmailLinkParts(item, accountIndex = 0) {
  const base = (fragment) => {
    const normalizedFragment = fragment.startsWith('#') ? fragment : `#${fragment}`;
    return {
      fragment: normalizedFragment,
      fragmentPath: normalizedFragment.replace(/^#/, ''),
      webUrl: `https://mail.google.com/mail/u/${accountIndex}/${normalizedFragment}`,
      accountIndex,
    };
  };

  const log  = (...a) => { if (window.__DEBUG) console.log('[GMAIL-LINK]', ...a); };
  const pick = (...vals) => vals.find(v => typeof v === 'string' && v.length >= 10);

  try {
    if (item?.display_url)        { log('display_url', item.display_url); return { ...base('#inbox'), webUrl: item.display_url }; }
    if (item?.gmail?.display_url) { log('gmail.display_url', item.gmail.display_url); return { ...base('#inbox'), webUrl: item.gmail.display_url }; }

    const webId = pick(
      item?.gmail_web_id, item?.gmail?.web_id, item?.gmail?.webId,
      item?.gmail_legacy_id, item?.gmail?.legacyId,
      item?.gmail?.rid, item?.gmail?.r
    );
    if (webId) { log('webId', webId); return base(`#inbox/${webId}`); }

    const threadId  = pick(item?.gmail_thread_id, item?.thread_id, item?.gmail?.threadId, item?.gmail?.thrId);
    if (threadId) { log('threadId', threadId); return base(`#inbox/${threadId}`); }

    const messageId = pick(item?.gmail_message_id, item?.message_id, item?.gmail?.id, item?.gmail?.msgId);
    if (messageId) { log('messageId', messageId); return base(`#inbox/${messageId}`); }

    const rfc822 = item?.rfc822_message_id || item?.messageId || item?.headers?.['Message-ID'] || item?.headers?.['Message-Id'];
    if (rfc822){
      const cleaned = String(rfc822).trim().replace(/[^\w.@<>-]/g,'');
      const q = `rfc822msgid:<${cleaned.replace(/[<>]/g,'')}>`;
      log('rfc822 → search', q);
      return base(`#search/${encodeURIComponent(q)}`);
    }

    if (!rfc822 && item?.sender_email) {
      const sender = (item.sender_email || '').trim();
      log('fallback → search by sender', sender);
      const searchQuery = `from:("${sender.replace(/"/g, '\\"')}")`;
      return base('#search/' + encodeURIComponent(searchQuery));
    }
    
    log('fallback → inbox');
    return base('#inbox');
    
  } catch (e) {
    console.error('[GMAIL-LINK] error', e, item);
    return base('#inbox');
  }
}

function getGmailUrl(item, accountIndex = 0) {
  return resolveGmailLinkParts(item, accountIndex).webUrl;
}

window.getGmailUrl = getGmailUrl;
window.resolveGmailLinkParts = resolveGmailLinkParts;

const USER_AGENT = navigator.userAgent || '';

function isIOSDevice() {
  return /iP(ad|hone|od)/.test(USER_AGENT) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /Android/.test(USER_AGENT);
}

function openInNewTab(url) {
  if (!url) return;
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (w) {
    w.opener = null;
    return;
  }
  // Fallback senza perdere il focus dell'app
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  requestAnimationFrame(() => {
    document.body.removeChild(a);
  });
}

function openMobileDeepLink(primaryUrl, fallbackUrl, secondaryUrl) {
  if (!primaryUrl) {
    if (fallbackUrl) openInNewTab(fallbackUrl);
    return;
  }

  let handled = false;
  const cleanup = () => {
    handled = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      cleanup();
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange, { once: true });

  const primaryTimer = setTimeout(() => {
    if (!handled) {
      if (secondaryUrl) {
        window.location.href = secondaryUrl;
        setTimeout(() => {
          if (!document.hidden && fallbackUrl) {
            openInNewTab(fallbackUrl);
          }
        }, 600);
      } else if (fallbackUrl) {
        openInNewTab(fallbackUrl);
      }
      cleanup();
    }
  }, 700);

  try {
    window.location.href = primaryUrl;
  } catch (err) {
    clearTimeout(primaryTimer);
    cleanup();
    if (secondaryUrl) {
      window.location.href = secondaryUrl;
    } else if (fallbackUrl) {
      openInNewTab(fallbackUrl);
    }
  }
}

function openGmailAppOrWeb(linkParts) {
  if (!linkParts) return;
  const { webUrl, fragmentPath, accountIndex } = linkParts;
  if (!(isIOSDevice() || isAndroidDevice())) {
    openInNewTab(webUrl);
    return;
  }

  const targetPath = fragmentPath || 'inbox';
  const appPrimary = `googlegmail://mail/u/${accountIndex}/${targetPath}`;
  if (isIOSDevice()) {
    openMobileDeepLink(appPrimary, webUrl);
    return;
  }

  const androidIntent = `intent://mail.google.com/mail/u/${accountIndex}/${targetPath}#Intent;scheme=https;package=com.google.android.gm;end`;
  openMobileDeepLink(appPrimary, webUrl, androidIntent);
}

async function applyTypeOverride(emailId, typeTag){
  const targetItem = allFeedItems.find(it => String(it.email_id) === String(emailId));
  if (!targetItem) return;
  const domain = (targetItem.source_domain || (targetItem.sender_email || '').split('@')[1] || '').toLowerCase();

  const before = new Map();
  allFeedItems.forEach(item => {
      const itemDomain = (item.source_domain || (item.sender_email || '').split('@')[1] || '').toLowerCase();
      if (domain && itemDomain === domain) {
          before.set(item.email_id, item.type_tag);
          item.type_tag = typeTag;
      }
  });

  // Aggiornamento ottimistico
  renderWithFilters();

  try {
      const res = await fetch(`${window.API_URL}/feed/${emailId}/type`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ type_tag: typeTag })
      });
      if (!res.ok) throw new Error('save_failed');
  } catch (err) {
      // Rollback in caso di errore
      allFeedItems.forEach(item => {
          if (before.has(item.email_id)) {
              item.type_tag = before.get(item.email_id);
          }
      });
      renderWithFilters();
      console.error("Salvataggio della tipologia fallito, rollback eseguito:", err);
      showToast('Errore nel salvare la modifica', 'error');
  }
}


function logGmailFields(item) {
  if (!window.__DEBUG) return;
  console.log('[GMAIL-FIELDS]', {
    id: item.id,
    display_url: item.display_url,
    gmail_display_url: item.gmail?.display_url,
    threadId: item.gmail_thread_id || item.thread_id || item.gmail?.threadId || item.gmail?.thrId,
    messageId: item.gmail_message_id || item.message_id || item.gmail?.id || item.gmail?.msgId,
    rfc822: item.rfc822_message_id || item.messageId || item.headers?.['Message-ID'] || item.headers?.['Message-Id']
  });
}

function clearSentinel() {
  const el = document.getElementById('load-more-sentinel');
  if (!el) return;
  el.dataset.busy = '0';
  el.removeAttribute('aria-busy'); // <-- AGGIUNGI SOLO QUESTA RIGA
  // 🟢 resta visibile per far scattare l'IntersectionObserver
  el.classList.remove('hidden');
  el.style.minHeight = '1px';
  el.style.padding = '0';
  el.textContent = '';
}

function renderTileSkeleton(id) {
  const el = document.createElement("article");
  el.dataset.emailId = id;
  el.dataset.revealed = "0";            // idempotenza del reveal
  el.className = "feed-card skeleton-card"; // Usa le tue classi esistenti
  el.innerHTML = `
    <div class="skel-img"></div>
    <div class="p-4">
      <div class="skel-line" style="width: 40%;"></div>
      <div class="skel-line" style="width: 80%;"></div>
      <div class="skel-line" style="width: 60%;"></div>
    </div>
  `;
  return el;
}

function setCardImageCached(imgEl, emailId, url, isInternal) {
  if (!imgEl || !url) return;

  imgEl.onerror = () => {
    imgEl.onerror = null;
    const originalUrl = new URL(url, window.location.origin).searchParams.get('u');
    if (originalUrl) {
      imgEl.src = originalUrl;
    }
  };

  const cached = __IMG_CACHE.get(emailId);

  const updateCacheAndEl = (blobUrl) => {
    const prev = __IMG_CACHE.get(emailId);
    if (prev && prev !== blobUrl && prev.startsWith('blob:')) {
      try { URL.revokeObjectURL(prev); } catch(e) {}
    }
    __IMG_CACHE.set(emailId, blobUrl);
    if (imgEl.src !== blobUrl) imgEl.src = blobUrl;
  };

  if (cached) {
    if (imgEl.src !== cached) imgEl.src = cached;
    return;
  }

  fetch(url, { credentials: 'include', cache: 'force-cache' })
    .then(r => r.ok ? r.blob() : Promise.reject(new Error('img_http_' + r.status)))
    .then(b => updateCacheAndEl(URL.createObjectURL(b)))
    .catch(() => {
      setCardImage(imgEl, url, isInternal);
    });
}

// Aggiungi questo listener a livello globale per pulire alla chiusura della pagina
window.addEventListener('beforeunload', () => {
  for (const u of __IMG_CACHE.values()) {
    if (u.startsWith('blob:')) {
      URL.revokeObjectURL(u);
    }
  }
});

function hydrateTile(el, item) {
  if (!el || el.dataset.revealed === "1") return; // idempotente
  
  // Sostituisce lo scheletro con la card reale
  const card = renderFeedCard(item); // Usa la tua funzione di rendering esistente
  el.replaceWith(card);
  observeReadCard(card); // <-- AGGIUNGI QUESTA RIGA
  card.dataset.revealed = "1";
  setTimeout(() => card.classList.remove('opacity-0'), 1200);

  // Precarico immagine per mostrare la card solo quando è pronta
  const url = item.image_url || item.img_url || item.cover_url;
  if (!url) {
    card.classList.remove('opacity-0'); // Mostra anche senza immagine
    return;
  }

  const imgEl = card.querySelector('.card-image');
  if (imgEl) {
      imgEl.addEventListener('load', () => {
        card.classList.remove('opacity-0');
        feLog('info', 'gate.reveal.ok', { email_id: item.email_id });
      }, { once: true });
      imgEl.addEventListener('error', () => {
        card.classList.remove('opacity-0'); // Mostra comunque in caso di errore
        feLog('warn', 'image.load.fail', { email_id: item.email_id });
      }, { once: true });
  }
}

function toggleLoadingMessage(show, text = "Sto preparando nuove newsletter…") {
  const el = document.getElementById('feed-loading');
  if (!el) return;
  const textEl = el.querySelector('.loader-text') || el.querySelector('p');
  if (textEl) textEl.textContent = text;
  el.classList.toggle('hidden', !show);
}

function toggleEndOfFeed(show) {
  if (!endOfFeedEl) endOfFeedEl = document.getElementById("feed-end-message");
  if (!endOfFeedEl) return;
  if (document.getElementById('login-message')?.classList.contains('hero-hidden')) {
    endOfFeedEl.classList.toggle("hidden", !show);
  } else {
    endOfFeedEl.classList.add("hidden");
  }
}

function hasRenderedAtLeastOneCard() {
  return !!document.querySelector('#feed-container .feed-card');
}

function getEverLoaded() {
  try { return localStorage.getItem(EVER_KEY) === '1'; } catch { return false; }
}
function setEverLoaded(v) {
  FEED_STATE.everLoaded = !!v;
  try { localStorage.setItem(EVER_KEY, v ? '1' : '0'); } catch {}
}


function removeGlobalLoading() {
  hideSplash();
  document.getElementById('feed-loading-indicator')?.remove();
  window.FEED_STATE && (FEED_STATE.initialSkeletonsVisible = false);
  window.__isInitialIngesting = false;
}

// ⚠️ all'avvio non conosciamo ancora l’utente → non leggere LS qui
FEED_STATE.everLoaded = false;


// 2. Funzione per caricare la configurazione remota e aggiornare le variabili
(function setupBootReadyTimeout(){
  const MAX_WAIT_MS = 4000;
  let resolved = false;
  const fallback = () => {
    if (resolved || __bootReady) return;
    resolved = true;
    __bootReady = true;
    console.warn('[CFG] Timeout nel caricamento di /config. Procedo con i valori di fallback.');
    window.__markBootReady = undefined;
  };
  setTimeout(fallback, MAX_WAIT_MS);
  window.__markBootReady = () => {
    if (resolved) return;
    resolved = true;
    __bootReady = true;
  };
})();

(async () => {
  try {
    const cfgRes = await fetch(`${window.BACKEND_BASE}/config`);

    if (!cfgRes.ok) throw new Error(`Config fetch failed with status ${cfgRes.status}`);
    
    const cfg = await cfgRes.json();
    
    window.BACKEND_BASE = cfg.BACKEND_BASE || window.BACKEND_BASE;
    window.API_URL = `${window.BACKEND_BASE}/api`;
    API_URL = window.API_URL; 
    window.GOOGLE_CLIENT_ID = cfg.GOOGLE_CLIENT_ID;
    window.GOOGLE_API_KEY = cfg.GOOGLE_API_KEY;

    // --- INIZIO BLOCCO DA AGGIUNGERE ---
    // Comando: Aggiungi preconnect al dominio del backend
    try {
      const backendOrigin = new URL(window.BACKEND_BASE).origin;
      const preconnectHint = document.createElement('link');
      preconnectHint.rel = 'preconnect';
      preconnectHint.href = backendOrigin;
      preconnectHint.crossOrigin = 'anonymous';
      document.head.appendChild(preconnectHint);
    } catch (e) {
      console.warn('[CFG] Impossibile aggiungere preconnect hint', e);
    }

    console.log('[CFG] Configurazione caricata correttamente.');
    console.log('[CFG] BACKEND_BASE:', window.BACKEND_BASE);
    
    // 3. Segna l'applicazione come pronta per iniziare
    console.log('[CFG] Boot ready via fetch.');
    window.__markBootReady?.();
    window.__markBootReady = undefined;

  } catch (e) {
    console.error('[CFG] Errore critico nel caricare /config. Si useranno i valori di fallback.', e);
    // L'app può comunque tentare di funzionare con i valori di fallback
    window.__markBootReady?.();
    window.__markBootReady = undefined;
  }
})();

// Logica per caricare le API di Google (rimane invariata)
window.__PICKER_READY__ = false;
window.onGapiLoad = function onGapiLoad() {
  try {
    gapi.load('picker', { callback: () => { window.__PICKER_READY__ = true; } });
  } catch (e) {
    console.error('[Picker] gapi.load("picker") failed:', e);
  }
};

window.__DEBUG = false;
const D = {
  rid: 0,
  now: () => new Date().toISOString(),
  log:  (...a) => { if (window.__DEBUG) console.log('[DBG]', ...a); },
  warn: (...a) => { if (window.__DEBUG) console.warn('[DBG]', ...a); },
  err:  (...a) => console.error('[DBG]', ...a),
};

// Log errori non gestiti (se qualcosa “salta” fuori dalle try/catch)
window.addEventListener('error', (e) => {
  D.err("[window.error]", e.message, e.filename, e.lineno, e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
  D.err("[unhandledrejection]", e.reason);
});

// fetch con logging (se vuoi usarlo altrove)
async function debugFetch(url, opts = {}, tag = "fetch") {
  const rid = (++window.__RID || (window.__RID = 1));
  const method = (opts.method || 'GET').toUpperCase();
  const hasBody = !!opts.body;
  const bodyLen = typeof opts.body === 'string' ? opts.body.length : (hasBody ? -1 : 0);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new DOMException('timeout','AbortError')), 60000);

  const o = { credentials: 'include', ...opts, signal: ctrl.signal };
  const t0 = performance.now();
  console.log(`[${tag}#${rid}] → ${method} ${url} ${hasBody ? `body[${bodyLen}]` : ''}`);

  try {
    const res = await fetch(url, o);
    const dt = (performance.now() - t0).toFixed(1);
    const clone = res.clone();
    let text = '';
    try { text = await clone.text(); } catch (e) {}
    console.log(`[${tag}#${rid}] ← ${res.status} ${dt}ms bytes=${text.length} ${text.slice(0,200)}`);
    return { res, text };
  } catch (err) {
    const dt = (performance.now() - t0).toFixed(1);
    console.warn(`[${tag}#${rid}] × NET-ERR ${dt}ms`, err);
    return { error: err };
  } finally {
    clearTimeout(to);
  }
}

(function setupImgDebug(){
  const p = new URLSearchParams(location.search);
  if (p.get('debug') === 'img') sessionStorage.setItem('debug_img_query','1');

  const on = sessionStorage.getItem('debug_img_query') === '1';
  document.body.classList.toggle('debug-img', on);

  // Toggle: Shift + D (rimane nella sessione della scheda)
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'd' && e.shiftKey){
      const now = !(sessionStorage.getItem('debug_img_query') === '1');
      sessionStorage.setItem('debug_img_query', now ? '1' : '0');
      document.body.classList.toggle('debug-img', now);
    }
  });
})();

function showPickerHintBar() {
  const el = document.getElementById('picker-hint');
  if (el) el.classList.remove('hidden');
}
function hidePickerHintBar() {
  const el = document.getElementById('picker-hint');
  if (el) el.classList.add('hidden');
}
window.showPickerHintBar = showPickerHintBar;
window.hidePickerHintBar = hidePickerHintBar;

function clearFeed(reason = 'unknown') {
  console.warn(`[FEED][CLEAR] Motivo: ${reason}`);
  if (!feedContainer) return;
  if (__readObserver) {
    document.querySelectorAll('#feed-container .feed-card').forEach(n => {
      try { __readObserver.unobserve(n); } catch {}
    });
  }

  // --- INIZIO MODIFICA: Pulizia dei Blob URL ---
  for (const u of __IMG_CACHE.values()) {
    if (u.startsWith('blob:')) {
      try { URL.revokeObjectURL(u); } catch(e) {}
    }
  }
  __IMG_CACHE.clear();
  // --- FINE MODIFICA ---

  const keepBootSkeletons = !__firstPaintDone && FEED_STATE.initialSkeletonsVisible;

  if (keepBootSkeletons) {
    feedContainer.querySelectorAll('.feed-card:not(.skeleton-card)').forEach(n => n.remove());
  } else {
    feedContainer.replaceChildren();
  }
  
  cardNodes.clear();
  __mountedIds.clear();
  hideLoadingFooter();
}

// app.js — blocco Service Worker
if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            // Mostra il banner per l'aggiornamento invece di forzare il reload
            document.getElementById('sw-update-banner')?.classList.remove('hidden');
          }
        });
      });
    }).catch(err => console.warn('Registrazione Service Worker fallita:', err));
  });
  // Aggiungi un listener al bottone del banner per eseguire il reload
  document.getElementById('sw-reload-btn')?.addEventListener('click', () => {
    // Invia un messaggio al nuovo SW per attivarsi subito
    navigator.serviceWorker.getRegistration().then(reg => {
        reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
        // Ricarica la pagina dopo un breve ritardo per dare tempo al SW di attivarsi
        setTimeout(() => window.location.reload(), 200);
    });
  });
} else {
    // Logica per ambiente di sviluppo (invariata)
    console.log('[SW] Rilevato ambiente di sviluppo. Annullamento registrazioni esistenti...');
    navigator.serviceWorker.getRegistrations()
      .then(registrations => {
        for (let registration of registrations) {
          registration.unregister();
        }
      });
}


function showInitialSkeletons(n = 6) {
  if (hasCards()) return;
  const root = feedContainer || document.getElementById('feed-container');
  if (!root) return;
  if (FEED_STATE.initialSkeletonsVisible) return;

  root.innerHTML = '';
  root.style.display = 'block';

  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'feed-loading-indicator';
  loadingIndicator.className = 'loading-indicator';
  loadingIndicator.innerHTML = `
    <div class="loader-visual" aria-hidden="true">
      <span class="loader-dot"></span>
      <span class="loader-dot"></span>
      <span class="loader-dot"></span>
    </div>
    <p class="loader-text">Stiamo preparando le tue newsletter migliori…</p>
    <p class="loader-sub">Tienila aperta: aggiorniamo ogni nuova scoperta in automatico.</p>
  `;
  root.appendChild(loadingIndicator);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const el = createSkeletonNode();
    el.id = `card-skel-boot-${i}`;
    el.dataset.state = "skeleton-boot"; // Stato specifico
    el.dataset.boot = "1"; // <-- COMANDO ESEGUITO: Aggiunto marcatore
    el.setAttribute("aria-busy", "true");
    frag.appendChild(el);
  }
  root.appendChild(frag);
  
  FEED_STATE.initialSkeletonsVisible = true;
}


function clearInitialSkeletons() {
  const root = document.getElementById('feed-container');
  if (!root) return;
  root.querySelectorAll('.skeleton-card').forEach(n => n.remove());
}

function showLoadingFooter(text = "Le tile si stanno caricando…") {
  if (FEED_STATE.loadingFooterVisible) return;

  const root = feedContainer || document.getElementById('feed-container');
  if (!root) return;

  const el = document.createElement("div");
  el.id = FEED_FOOTER_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.className = "text-sm text-gray-500 flex items-center gap-2 justify-center py-4";
  el.innerHTML = `
    <span class="inline-block h-3 w-3 rounded-full bg-gray-400 animate-ping"></span>
    <span>${text}</span>
  `;
  root.appendChild(el);
  
  FEED_STATE.loadingFooterVisible = true;
}

function hideLoadingFooter() {
  const el = document.getElementById(FEED_FOOTER_ID);
  if (el) el.remove();
  FEED_STATE.loadingFooterVisible = false;
}

function rootDomain(dom) {
  if (!dom) return null;
  dom = String(dom).toLowerCase().replace(/^www\./,'').replace(/^\.+/,'');
  const parts = dom.split('.');
  if (parts.length <= 2) return dom;
  const commonSLD = new Set([
    'co.uk','ac.uk','gov.uk',
    'com.au','net.au','org.au',
    'co.jp','ne.jp','or.jp',
    'com.br','com.ar','com.mx','com.tr','com.cn','com.hk','com.sg',
    'co.in','co.id','co.kr','co.za'
  ]);
  const tail = parts.slice(-2).join('.');
  if (commonSLD.has(tail) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

const PHOTOS_SCOPE_STR =
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly https://www.googleapis.com/auth/photoslibrary.readonly';


async function autoIngestAndLoad(options = {}) {
  const {
    reason = "auto",
    force = false,
    ptrToken = null,
    ptrText = 'Sto sincronizzando nuove newsletter…',
    ...apiParams
  } = options;

  const token = ptrToken || null;
  if (token) ptrShowLoading(token, ptrText);

  if (__autoIngesting && !force) {
    if (token) ptrWaitUntilIdle(token);
    return;
  }

  if (!force && Date.now() < __ingestCooldownUntil) {
    feLog('info', 'ingest.skip.cooldown', { reason });
    if (token) ptrWaitUntilIdle(token);
    return;
  }
  __autoIngesting = true;
  const releasePtr = () => {
    if (token) ptrHideLoading(token);
    else if (!window.__isIngesting && !window.__autoIngesting) ptrForceClear();
  };
  try {
    const payload = { batch: 5, pages: 1, target: 25, ...apiParams };
    
    const { res, error } = await debugFetch(`${window.API_URL}/ingest/pull`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, `ingest/pull(${reason})`);

    if (error || !res || !res.ok) {
      feLog('warn', 'ingest.pull.fail', { status: res?.status, error });
      __ingestCooldownUntil = Date.now() + 30_000;
      __autoIngesting = false;
      reconcileEndOfFeed(); // <-- Aggiunta qui
      releasePtr();
      return;
    }

    const body = await res.json().catch(() => ({}));
    const jobId = body?.job_id;
    feLog('info', 'ingest.pull.ok', { jobId, status: body?.status });

    if (body.status === 'already_running' && jobId) {
      __autoIngesting = false;
      window.__isIngesting = true;
      handleIngestionState(jobId, {
          onDone: () => { __autoIngesting = false; dlog('[PTR] refresh_done (joined)'); reconcileEndOfFeed(); releasePtr(); },
          onError: () => { __autoIngesting = false; reconcileEndOfFeed(); releasePtr(); }
      });
      if (token) ptrWaitUntilIdle(token);
      return;
    }

    if (jobId) {
      __isInitialIngesting = true;
      if (!hasCards()) showInitialSkeletons();
      
      handleIngestionState(jobId, {
        onDone: async ({ added = 0 } = {}) => {
          if ((added || 0) === 0) {
            __ingestCooldownUntil = Date.now() + 60_000 + Math.floor(Math.random() * 5000);
          }
          __isIngesting = false;
          __isInitialIngesting = false;
          await window.fetchFeed({ reset: false, cursor: __cursor });
          clearSentinel();
          __autoIngesting = false;
          dlog('[PTR] refresh_done');
          reconcileEndOfFeed();
          releasePtr();
        },
        onError: () => {
          __isIngesting = false;
          __isInitialIngesting = false;
          clearSentinel();
          __autoIngesting = false;
          reconcileEndOfFeed();
          releasePtr();
        }
      });
    } else {
      __autoIngesting = false;
      reconcileEndOfFeed();
      releasePtr();
    }
  } catch (e) {
    console.warn('[ingest] Errore durante il processo di auto-ingestione:', e);
    __autoIngesting = false;
    __isInitialIngesting = false;
    reconcileEndOfFeed();
    releasePtr();
  }
}


async function ensureGIS() {
  if (gisInited) return;
  if (!window.GOOGLE_CLIENT_ID) { console.warn('[GIS] client_id assente'); return; }

  // attende che la libreria GSI sia caricata
  const ready = () => !!(window.google && google.accounts && google.accounts.oauth2);
  const t0 = Date.now();
  while (!ready()) {
    if (Date.now() - t0 > 8000) { console.warn('[GIS] non pronto'); return; }
    await new Promise(r => requestAnimationFrame(r));
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.GOOGLE_CLIENT_ID,
    scope: PHOTOS_SCOPE_STR,
    callback: () => {}
  });
  gisInited = true;
}

function formatDateTimeLabel(isoLike) {
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return '';

  const datePart = d.toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long'
  });

  const timePart = d.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false // Per avere il formato 24h (es. 23:15)
  });

  return `${datePart} ${timePart}`; // Es. "15 settembre 23:15"
}

let tokenQueue = Promise.resolve();

async function getToken({ prompt } = {}) {
  await ensureGIS();
  
  // Accoda la nuova richiesta alla promessa precedente
  tokenQueue = tokenQueue.then(() => new Promise((resolve, reject) => {
    const prevCallback = tokenClient.callback;
    
    tokenClient.callback = (response) => {
      // Ripristina il callback precedente non appena questo viene eseguito
      tokenClient.callback = prevCallback || (() => {});
      
      if (response?.access_token) {
        resolve(response.access_token);
      } else {
        reject(response?.error || new Error('no_token'));
      }
    };
    
    // Esegui la richiesta
    tokenClient.requestAccessToken(prompt ? { prompt } : {});
  }));
  
  return tokenQueue;
}

async function getAccessToken(){ return getToken({ prompt:'consent' }); }
async function getAccessTokenSilently(){ return getToken(); }

function startBackgroundUpdates() {
  if (backgroundUpdateInterval) clearInterval(backgroundUpdateInterval);

  let updateCount = 0;
  const maxUpdates = 12; // ~1 minuto

  backgroundUpdateInterval = setInterval(async () => {
    console.log("Controllo aggiornamenti in background...");
    // FIX: Rimuovi il cursore per caricare la prima pagina e scoprire i nuovi item.
    await fetchFeed({ force: true, _fromWatcher: true });

    updateCount++;
    const sseGone = (__ingestSSE == null);
    const stop = sseGone || updateCount >= maxUpdates;

    if (stop) {
      clearInterval(backgroundUpdateInterval);
      console.log("Polling in background terminato.");
      // FIX: Anche la chiamata finale non deve avere il cursore.
      if (sseGone) {
        await fetchFeed({ force: true, _fromWatcher: true });
      }
    }
  }, 5000);
}

/**
 * Gestisce la risposta "ingesting" dal backend.
 * Mostra gli scheletri e avvia l'ascolto degli eventi SSE.
 */
function handleIngestionState(jobId, { onDone, onError } = {}) {
  feLog('info', 'sse.start', { jobId });

  if (__ingestSSE && __ingestSSE.__jobId === jobId) {
    dlog('[SSE] join', {jobId});
    __ingestSSE.__waiters ||= [];
    __ingestSSE.__waiters.push({ onDone, onError });
    __isIngesting = true;
    __sseOpen = true;
    toggleLoadingMessage(true);
    startBackgroundUpdates();
    return;
  }

  if (__ingestSSE) { try { __ingestSSE.close(); } catch {} }

  const updateBtn = document.getElementById('update-feed-btn');
  if (updateBtn) { updateBtn.disabled = true; updateBtn.classList.add('opacity-50','cursor-not-allowed'); }

  __isIngesting = true;
  let retries = 0;
  const MAX_RETRIES = 5;
  let es;
  let finished = false;

  const cleanup = () => {
    if (backgroundUpdateInterval) {
      clearInterval(backgroundUpdateInterval);
      backgroundUpdateInterval = null;
    }
    if (es) es.close();
    __ingestSSE = null;
    if (updateBtn) { updateBtn.disabled = false; updateBtn.classList.remove('opacity-50','cursor-not-allowed'); }
    __sseUpdateQueue = [];
    if (__sseProcessTimer) clearTimeout(__sseProcessTimer);
    __sseProcessTimer = null;
    feLog('info', 'sse.closed', { jobId });
  };

    const finish = (isSuccess, meta) => {
      if (finished) return;
      finished = true;
      __sseOpen = false;
      try { processSseUpdateQueue(); } catch {} // <-- MODIFICA: Esegui un ultimo flush della coda
      toggleLoadingMessage(false);
      // Failsafe: se non ci sono ingestion attive, pulisci qualsiasi loader PTR rimasto
      if (!window.__isIngesting && !window.__autoIngesting) ptrForceClear();
    
    const waiters = (es?.__waiters || []);
    for (const w of waiters) {
      if (isSuccess) w.onDone?.(meta);
      else w.onError?.();
    }
    if (es) es.__waiters = [];

    cleanup();

    if (isSuccess) {
      onDone?.(meta);
    } else {
      onError?.();
    }
    reconcileEndOfFeed();
  };

  const onAny = async (ev) => {
    let st = {}; 
    try { st = JSON.parse(ev.data || "{}"); } catch {}
    feLog('info', 'sse.event', { jobId, type: ev.type, ...st });
    if (ev.type === 'update' && st.email_id) {
      scheduleSseUpdate(st.email_id);
    }
    if (st.state === "done") {
      finish(true, { status: 'done', added: st.done || 0 });
    } else if (st.state === "failed") {
      finish(false);
    }
  };

  function openES() {
    es = new EventSource(`${window.BACKEND_BASE}/api/ingest/events/${jobId}`, { withCredentials: true });
    __ingestSSE = es; es.__jobId = jobId;
    __sseOpen = true;
    
    es.addEventListener('progress', onAny);
    es.addEventListener('update', onAny);
    window.addEventListener('beforeunload', cleanup, { once: true });

    es.onerror = () => {
      es.close();
      __sseOpen = false;
      
      if (!navigator.onLine) {
        feLog('warn', 'sse.offline', { jobId });
        window.addEventListener('online', openES, { once: true });
        return;
      }

      if (retries >= MAX_RETRIES) {
        feLog('error', 'sse.retries.exhausted', { jobId });
        finish(false);
        return;
      }
      const delay = Math.min(8000, 600 * (2 ** retries) + Math.random() * 300);
      retries++;
      feLog('warn', 'sse.retry.schedule', { jobId, retries, delay });
      setTimeout(openES, delay);
    };
  }

  toggleEndOfFeed(false);
  toggleLoadingMessage(true);
  startBackgroundUpdates();
  openES();
}

function reconcileEndOfFeed() {
    const ingesting = __isIngesting || __autoIngesting;
    const pendingMore = window.__pendingMore || false;
    
    const showEnd = !__hasMore && !ingesting && !pendingMore;

    if (showEnd) {
        hideLoadingFooter(); // <-- MODIFICA
        toggleEndOfFeed(true);
        toggleLoadingMessage(false);
        clearSentinel();
        stopTailPolling();
    } else {
        toggleEndOfFeed(false);
        if (!__hasMore && (ingesting || pendingMore)) {
            showLoadingFooter('Sto preparando nuove newsletter…'); // <-- MODIFICA
            setSentinelBusy('Elaborazione in corso…');
            startTailPolling();
        } else {
            hideLoadingFooter(); // <-- MODIFICA
            stopTailPolling();
        }
    }
}

function startTailPolling() {
  if (tailTimer) return;
  console.log("[Polling] Avvio tail polling ogni 4 secondi.");
  tailTimer = setInterval(() => {
    // Chiamiamo fetchFeed senza cursore per caricare la prima pagina
    window.fetchFeed({ force: true, _fromWatcher: true });
  }, 4000);
}

function stopTailPolling() {
  if (tailTimer) {
    console.log("[Polling] Arresto tail polling.");
    clearInterval(tailTimer);
    tailTimer = null;
  }
}
// Sovrascrivi la funzione fetchFeed globale con la versione finale

function isStandaloneDisplayMode() {
  try { return window.matchMedia('(display-mode: standalone)').matches; }
  catch { return false; }
}

// app.js
function buildPlaceholderUrl(emailId) {
  const seed = encodeURIComponent(String(emailId || 'ph'));
  return `https://picsum.photos/seed/${seed}/800/450`;
}

function setCardImage(imgEl, url, isInternal) {
  if (!imgEl || !url) return;

  const currentEffectiveSrc = imgEl.currentSrc || imgEl.src;
  if (currentEffectiveSrc === url) {
    return;
  }

  imgEl.loading = 'lazy';
  imgEl.decoding = 'async';
  if ('fetchPriority' in imgEl) imgEl.fetchPriority = 'low';

  let newSrcset = '';
  if (isInternal && url.includes('/api/photos/proxy/')) {
    const url1x = url.replace(/w=\d+/, 'w=800').replace(/h=\d+/, 'h=450');
    const url2x = url.replace(/w=\d+/, 'w=1600').replace(/h=\d+/, 'h=900');
    newSrcset = `${url1x} 1x, ${url2x} 2x`;
  }
  const curSrcset = imgEl.getAttribute('srcset') || '';
  if (curSrcset !== newSrcset) {
    if (newSrcset) imgEl.setAttribute('srcset', newSrcset);
    else imgEl.removeAttribute('srcset');
  }

  try {
    if (isInternal) {
      imgEl.removeAttribute('crossorigin');
      imgEl.removeAttribute('referrerpolicy');
    } else {
      imgEl.setAttribute('crossorigin', 'anonymous');
      imgEl.setAttribute('referrerpolicy', 'no-referrer');
    }
  } catch {}

  const updatingClass = 'updating-image';
  const done = () => imgEl.classList.remove(updatingClass);
  imgEl.addEventListener('load', done, { once: true });

  // Pipeline di fallback robusta: proxy → originale → placeholder
  const emailId = imgEl.dataset.emailId || imgEl.closest('.feed-card')?.dataset.emailId || '';
  const original = (() => {
    try {
      const u = new URL(url, window.location.origin);
      return u.pathname.startsWith('/api/img') ? (u.searchParams.get('u') || '') : '';
    } catch { return ''; }
  })();

  let step = 0; // 0: primary, 1: original, 2: placeholder
  const tryNext = () => {
    step++;
    // Rimuovi eventuale srcset quando vai su placeholder
    if (step >= 2) imgEl.removeAttribute('srcset');
    if (step === 1 && original) {
      // prova URL originale diretto
      try { imgEl.setAttribute('crossorigin', 'anonymous'); imgEl.setAttribute('referrerpolicy', 'no-referrer'); } catch {}
      imgEl.src = original;
      return;
    }
    // placeholder finale
    imgEl.dataset.fallback = '1';
    imgEl.src = buildPlaceholderUrl(emailId);
  };

  imgEl.addEventListener('error', () => {
    done();
    if (step < 2) tryNext();
  }, { once: true });

  imgEl.classList.add(updatingClass);
  imgEl.src = url;
}

function isInternalImageUrl(u) {
  if (!u) return false;
  try {
    const base = new URL(window.BACKEND_BASE).origin;
    return u.startsWith(base) || u.includes('/api/photos/proxy/') || u.startsWith('/api/img');
  } catch {
    return u.startsWith('/api/');
  }
}

function buildImageProxyUrl(imageUrl, emailId) {
  if (!imageUrl) return imageUrl;
  if (isInternalImageUrl(imageUrl)) return imageUrl;
  const params = new URLSearchParams();
  params.set('u', imageUrl);
  if (emailId) params.set('email_id', String(emailId));
  return `${window.BACKEND_BASE}/api/img?${params.toString()}`;
}

async function ensurePickerReady(timeout = 8000) {
  const start = Date.now();

  // se api.js è già pronto ma non abbiamo ancora caricato "picker", caricalo ora
  if (window.gapi && !window.__PICKER_READY__) {
    try { gapi.load('picker', { callback: () => { window.__PICKER_READY__ = true; } }); } 
    catch (e) { console.error('[Picker] gapi.load immediate failed:', e); }
  }

  // polling finché __PICKER_READY__ non diventa true
  await new Promise((resolve, reject) => {
    (function wait() {
      if (window.__PICKER_READY__ && window.google && google.picker) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('picker_not_ready'));
      requestAnimationFrame(wait);
    })();
  });
}

// Funzione per mostrare un tooltip temporaneo
let currentTooltip = null;
function showReadStatusTooltip(targetElement, text) {
  // Rimuovi qualsiasi tooltip precedente
  if (currentTooltip) {
    currentTooltip.remove();
    currentTooltip = null;
  }

  // Crea il nuovo tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'read-status-tooltip';
  tooltip.textContent = text;
  document.body.appendChild(tooltip);
  currentTooltip = tooltip;

  // Posizionalo
  const targetRect = targetElement.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  // Posiziona sopra l'elemento, centrato orizzontalmente
  let top = targetRect.top - tooltipRect.height - 8; // 8px di spazio
  let left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);

  // Controlla che non esca dai bordi dello schermo
  if (top < 8) { // Se esce sopra, posizionalo sotto
    top = targetRect.bottom + 8;
  }
  if (left < 8) { // Se esce a sinistra
    left = 8;
  }
  if (left + tooltipRect.width > window.innerWidth - 8) { // Se esce a destra
    left = window.innerWidth - tooltipRect.width - 8;
  }

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;

  // Mostra con animazione
  requestAnimationFrame(() => {
    tooltip.classList.add('show');
  });

  // Nascondi e rimuovi dopo un po'
  setTimeout(() => {
    tooltip.classList.remove('show');
    setTimeout(() => {
      if (tooltip === currentTooltip) {
        tooltip.remove();
        currentTooltip = null;
      }
    }, 200); // Attendi la fine della transizione
  }, 2000); // Durata del tooltip: 2 secondi
}

  function showToast(text, kind='ok'){
    const t = document.getElementById('toast'); if (!t) return;
    t.className = ''; t.classList.add(kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''); 
    t.textContent = String(text || '');
    t.classList.add('show');
    setTimeout(()=> t.classList.remove('show'), 2600);
  }

function showPickerLaunchDialog(pickerUri, onLaunched) {
  const host = location.host;

  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.45);z-index:2000;
  `;
  wrap.innerHTML = `
    <div style="background:#fff;border-radius:14px;max-width:520px;width:92vw;padding:18px 16px;box-shadow:0 10px 30px rgba(0,0,0,.2)">
      <h3 style="margin:0 0 8px;font:600 16px/1.2 system-ui">Serve un clic in più</h3>
      <p style="margin:0 0 10px;color:#444;font:14px/1.45 system-ui">
        <strong>Chrome ha bloccato il popup</strong> di Google Photos.
        Puoi aprirlo in una <strong>nuova scheda</strong> oppure consentire i popup per <strong>${host}</strong>.
      </p>

      <details style="margin:10px 0 12px">
        <summary style="cursor:pointer;color:#111;font:600 13px system-ui;list-style:none">
          💡 Come consentire i popup in Chrome
        </summary>
        <div style="margin-top:8px;color:#555;font:13px/1.5 system-ui">
          <p style="margin:0 0 6px"><strong>Desktop (Windows/Mac/Linux)</strong></p>
          <ol style="margin:0 0 10px 18px">
            <li>Clicca sull’icona <em>popup bloccato</em> nella barra degli indirizzi (a destra dell’URL).</li>
            <li>Scegli <em>Consenti sempre popup e reindirizzamenti da ${host}</em>.</li>
            <li>Clicca <em>Fine</em> e ricarica la pagina.</li>
          </ol>
          <p style="margin:0 0 6px"><strong>Android (Chrome)</strong></p>
          <ol style="margin:0 0 0 18px">
            <li>Tocca il lucchetto vicino all’URL → <em>Impostazioni sito</em>.</li>
            <li>Apri <em>Popup e reindirizzamenti</em> → imposta su <em>Consenti</em>.</li>
            <li>Torna alla pagina e riprova.</li>
          </ol>
        </div>
      </details>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="gpp-cancel"
                style="border:1px solid #ddd;background:#fff;border-radius:10px;padding:8px 12px;font:600 13px system-ui">
          Annulla
        </button>
        <a id="gpp-open" href="${pickerUri}" target="_blank" rel="noopener"
           style="background:#000;color:#fff;border-radius:10px;padding:8px 12px;font:600 13px system-ui;text-decoration:none">
          Apri in nuova scheda
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const cleanup = () => wrap.remove();
  wrap.querySelector('#gpp-cancel').addEventListener('click', cleanup);
  wrap.querySelector('#gpp-open').addEventListener('click', async () => {
    cleanup();
    try { await onLaunched?.(); } catch (e) { console.error(e); }
  });
}


async function openNewPhotosPicker({ mode = 'replace', popup = null, accessToken = null } = {}) {
  console.log("[NewPicker] Avvio Photos Picker API");

  // 1) usa il token passato; NON chiamare qui getAccessToken (altrimenti perdi il gesto utente)
  if (!accessToken) {
    throw new Error('missing_access_token');
  }

  // 2) Crea la sessione
 const sessRes = await fetch(`${window.BACKEND_BASE}/api/photos/picker/session`, {
   method: 'POST',
   headers: { 'Authorization': `Bearer ${accessToken}` },
   credentials: 'include'
 });
  console.log("[NewPicker] create_session status:", sessRes.status);
  if (!sessRes.ok) {
    const t = await sessRes.text();
    console.error("[NewPicker] ERRORE create session:", sessRes.status, t);
    throw new Error(`create_session_failed_${sessRes.status}`);
  }
  const session = await sessRes.json();
  console.log("[NewPicker] session response:", session);
  const sessionId = session.id;
  let resolved = false;

  if (!session.pickerUri) {
    console.error("[NewPicker] Nessuna pickerUri nella risposta:", session);
    throw new Error("missing_picker_uri");
  }
  console.log("[NewPicker] pickerUri:", session.pickerUri);

  // 3) Apro il popup del picker
let w = (popup && !popup.closed)
  ? popup
  : window.open('about:blank', 'gphotos_picker', 'width=960,height=720');

if (!w) {
  // Popup bloccato: salva l'ID sessione e proponi apertura in NUOVA scheda
  try { showToast('Chrome ha bloccato il popup. Apri in nuova scheda o consenti i popup.','error'); } catch (e) {}
  try {
    const pendingSessionKey = `pending_gphotos_session:${EVER_KEY.split(':')[1] || 'anonymous'}`;
    localStorage.setItem(pendingSessionKey, JSON.stringify({ id: sessionId, ts: Date.now() })); 
  } catch (e) {}

  showPickerLaunchDialog(session.pickerUri, () => {
    // Il link aprirà il picker in un'altra scheda/finestra.
    // Al ritorno, finalizePendingGPhotosSession() riprenderà la sessione.
  });

  return 'redirect';
}

try { w.location = session.pickerUri; } catch { w.location.replace(session.pickerUri); }
showPickerHintBar();


  // 4) Ricevo la selezione via postMessage e salvo su backend (/api/photos/cache)
  return new Promise((resolve) => {
    let safetyTimer;
    const TRUSTED_ORIGINS = new Set([
      'https://photos.google.com',
      'https://docs.google.com',
    ]);
    const isTrustedOrigin = (origin) => {
      try {
        const url = new URL(origin);
        // Controlla l'origine esatta per i domini principali
        if (TRUSTED_ORIGINS.has(url.origin)) return true;
        // Controlla se il dominio termina con .googleusercontent.com per i sottodomini
        return url.hostname.endsWith('.googleusercontent.com');
      } catch {
        return false;
      }
    };

    const handler = async (ev) => {
      if (ev.source !== w) return;     
      if (!isTrustedOrigin(ev.origin)) return;
      const data = ev.data || {};
      console.log("[NewPicker] postMessage da:", ev.origin, "data:", data);

      // normalizzazione strutture possibili
      let mediaItems = [];
      if (Array.isArray(data.mediaItems)) mediaItems = data.mediaItems;
      else if (data.payload?.mediaItems) mediaItems = data.payload.mediaItems;
      else if (data.result?.mediaItems) mediaItems = data.result.mediaItems;

      // eventi di chiusura senza selezione
      if (data.type === 'pickerCanceled' || data.type === 'pickerClosed') {
  window.removeEventListener('message', handler);
  try { w.close(); } catch (e) {}
  console.warn("[NewPicker] Picker cancellato/chiuso");
  resolved = true;                 // <— evita fallback successivi
  clearTimeout(safetyTimer);   
  hidePickerHintBar();    
  return resolve('cancel');
}

      // selezione effettuata
      if (mediaItems.length > 0) {
        
        window.removeEventListener('message', handler);
        try { w.close(); } catch (e) {}
        console.log("[NewPicker] Selezionate", mediaItems.length, "foto");

        console.log("[NewPicker] Avvio cache da sessione");
        const cacheRes = await fetch(`${window.BACKEND_BASE}/api/photos/picker/session/cache`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  credentials: 'include',
  body: JSON.stringify({ session_id: sessionId, mode })
});
const cacheJson = await cacheRes.json().catch(() => ({}));
console.log("[NewPicker] session/cache →", cacheRes.status, cacheJson);
resolved = true;
clearTimeout(safetyTimer);   
hidePickerHintBar();     // <— ferma il timeout di sicurezza
return resolve('picked');
      }
    };

    window.addEventListener('message', handler, false);
    (async () => {
  try {
    // diamo priorità al postMessage per 1.5s
    await new Promise(r => setTimeout(r, 1500));
    if (resolved) return;

    const maxMs = 90_000;      // quanto a lungo restiamo in attesa (90s)
    const stepMs = 1500;       // intervallo tra i tentativi (1.5s)
    const t0 = Date.now();

    while (!resolved && (Date.now() - t0) < maxMs) {
      // (opzionale) ispeziona lo stato della sessione
      try {
        const sessInfo = await fetch(
          `${window.BACKEND_BASE}/api/photos/picker/session/${sessionId}`,
          { headers: { 'Authorization': `Bearer ${accessToken}` }, credentials: 'include' }
        );
        const sessJson = await sessInfo.json().catch(()=> ({}));
        console.log("[NewPicker][fallback] session info:", sessJson);
      } catch (e) {
        console.warn("[NewPicker][fallback] get session err:", e);
      }

      // prova a cache-are gli item dalla sessione
      const cacheRes = await fetch(`${window.BACKEND_BASE}/api/photos/picker/session/cache`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ session_id: sessionId, mode: 'replace' })
      });
      const cacheJson = await cacheRes.json().catch(()=> ({}));
      console.log("[NewPicker][fallback] cache_from_session:", cacheRes.status, cacheJson);

      if (!resolved && cacheRes.ok && cacheJson.ok && cacheJson.cached > 0) {
  resolved = true;
  window.removeEventListener('message', handler);  // <— pulisci il listener
  try { w.close(); } catch (e) {}
  console.log("[NewPicker] Risolto via fallback (server).");
  clearTimeout(safetyTimer);   
  hidePickerHintBar();   
  return resolve('picked');
}

      // altrimenti attendo e riprovo
      await new Promise(r => setTimeout(r, stepMs));
    }

    if (!resolved) {
      console.warn("[NewPicker][fallback] timeout in attesa della selezione.");
    }
  } catch (e) {
    console.warn("[NewPicker][fallback] errore:", e);
  }
})();


    // timeout di sicurezza (es. l’utente chiude il popup senza inviare nulla)
safetyTimer = setTimeout(() => {
  window.removeEventListener('message', handler);
  try { w.close(); } catch (e) {}
  console.warn("[NewPicker] Timeout in attesa del postMessage");
  hidePickerHintBar(); // <-- QUI
if (!resolved) { resolved = true; resolve('timeout'); }
}, 2 * 60 * 1000);
  });
}

function throttle(fn, ms = 800) {
  let last = 0, timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, ms - (now - last));
    }
  };
}
    
document.addEventListener('DOMContentLoaded', () => {
    // 1. Popola le variabili globali del DOM (necessario per tutte le funzioni)
    feedContainer = document.getElementById('feed-container');
    loginMessage = document.getElementById('login-message');
    sentinel = document.getElementById('load-more-sentinel');
    domainDropdown   = document.getElementById('domain-dropdown');
    btnFilterByDomain = document.getElementById('btnFilterByDomain');
    btnAllInboxes   = document.getElementById('btnAllInboxes');
    footerNav = document.querySelector('footer nav');
    domainSearch     = document.getElementById('domain-search');
    domainListEl     = document.getElementById('domain-list');
    domainApplyBtn   = document.getElementById('domain-apply');
    domainCancelBtn  = document.getElementById('domain-cancel');
    domainSelectAll  = document.getElementById('domain-select-all');
    domainClearAll   = document.getElementById('domain-clear-all');
    updateFeedBtn = document.getElementById('update-feed-btn');
    logoutBtn = document.getElementById('logout-btn');
    profileSheet = document.getElementById('profile-sheet');
    hideMenu = document.getElementById('hide-menu');
    choosePhotoBtn = document.getElementById('choose-photo-btn');
    sheetCloseBtn = document.getElementById('photo-sheet-close');
    gphotosMenuBtn = document.getElementById('gphotos-menu-btn');
    gphotosMenu = document.getElementById('gphotos-menu');
    pickBtn = document.getElementById('pick-photos-btn');
    const photoSheetBackdrop = document.getElementById('photo-sheet-backdrop');
    const photoSheetClose = document.getElementById('photo-sheet-close');
    const closeProfileBtn = document.getElementById('close-profile-sheet-btn');
    const profileSheetBackdrop = document.getElementById('profile-sheet-backdrop');
    closeProfileBtn?.addEventListener('click', closeProfileSheet);
    profileSheetBackdrop?.addEventListener('click', closeProfileSheet);
    logoutBtn?.addEventListener('click', handleLogout);
    hiddenSheet = document.getElementById('hidden-sheet');
    hiddenDomainsList = document.getElementById('hidden-domains-list');
    hiddenThreadsList = document.getElementById('hidden-threads-list');
    openHiddenBtn = document.getElementById('open-hidden-btn');
    hiddenSheetBackdrop = document.getElementById('hidden-sheet-backdrop');
    closeHiddenSheetBtn = document.getElementById('close-hidden-sheet-btn');
    openHiddenBtn?.addEventListener('click', openHiddenSheet);
    closeHiddenSheetBtn?.addEventListener('click', closeHiddenSheet);
    hiddenSheetBackdrop?.addEventListener('click', closeHiddenSheet);
    initTypeMenu();

    
    const allTabs = footerNav?.querySelectorAll('button[data-tab]');
    const tabFeedBtn = document.querySelector('button[data-tab="feed"]');
    const tabFavBtn  = document.querySelector('button[data-tab="favorites"]');
    const closeHideMenu = () => document.getElementById('hide-menu')?.classList.add('hidden');

    // Listener per il pulsante della fotocamera (non correlato al refresh)
    document.addEventListener('click', (e) => {
      const cameraButton = e.target.closest('#choose-photo-btn');
      if (!cameraButton) return;
      e.preventDefault();
      try {
        openPhotoSheet();
      } catch (err) {
        console.error('[ERRORE] Impossibile aprire il pannello foto:', err);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeHideMenu();
    });


    hideMenu?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const emailId = hideMenu.dataset.emailId;
    const domain = hideMenu.dataset.domain;

    const hideEmailBtn = e.target.closest('#menu-hide-email');
    const hideDomainBtn = e.target.closest('#menu-hide-domain');

    if (hideEmailBtn && emailId) {
        hiddenEmailIds.add(emailId);
        saveHiddenIds();
        const root = feedContainer || document;
        const card = root.querySelector(`.feed-card[data-email-id="${emailId}"]`);
        if (card) {
            if (__readObserver) {
                try { __readObserver.unobserve(card); } catch {}
            }
            card.remove();
        }
        
        // --- INIZIO PATCH: Libera il blob dalla cache ---
        const cachedUrl = __IMG_CACHE.get(emailId);
        if (cachedUrl && cachedUrl.startsWith('blob:')) {
            URL.revokeObjectURL(cachedUrl);
        }
        __IMG_CACHE.delete(emailId);
        // --- FINE PATCH ---

        showToast('Thread nascosto', 'ok');
    }


    if (hideDomainBtn && domain) {
      feLog('info', 'hide.save_domain.try', { domain });
      const newHiddenDomains = new Set(userHiddenDomains).add(domain);
      try {
        await fetch(`${window.API_URL}/settings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ hidden_domains: Array.from(newHiddenDomains) })
        });
        userHiddenDomains = newHiddenDomains;
        renderWithFilters();
        await fetchFeed({ reset: false });
        feLog('info', 'hide.save_domain.ok', { domain, total_hidden: userHiddenDomains.size });
        showToast(`Nascoste tutte le email da ${domain}`, 'ok');
      } catch (err) {
        feLog('error', 'hide.save_domain.fail', { domain, err: String(err) });
        showToast('Errore nel salvare il filtro.', 'error');
      }
    }

    hideMenu.classList.add('hidden');
});

    window.addEventListener('scroll', () => hideMenu?.classList.add('hidden'), { passive: true });
    window.addEventListener('resize', () => hideMenu?.classList.add('hidden'));

  gphotosMenuBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    gphotosMenu.classList.remove('hidden');
    gphotosMenu.style.visibility = 'hidden'; // Nascondi temporaneamente
    
    // Usa requestAnimationFrame per assicurarti che il DOM sia aggiornato
    requestAnimationFrame(() => {
      const rect = gphotosMenuBtn.getBoundingClientRect();
      const mw = gphotosMenu.offsetWidth || 256;
      gphotosMenu.style.top  = `${rect.bottom + window.scrollY + 4}px`;
      gphotosMenu.style.left = `${rect.right  + window.scrollX - mw}px`;
      gphotosMenu.style.visibility = ''; // Rendi di nuovo visibile
    });
});

    window.addEventListener('click', () => {
        if (hideMenu && !hideMenu.classList.contains('hidden')) {
            hideMenu.classList.add('hidden');
        }
        if (gphotosMenu && !gphotosMenu.classList.contains('hidden')) {
            gphotosMenu.classList.add('hidden');
        }
    });

    gphotosMenu?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const actionBtn = e.target.closest('button');
      if (!actionBtn) return;

      gphotosMenu.classList.add('hidden');

      // Funzione helper per le azioni che NON aprono un popup custom
      const runAuthAction = async (actionFn) => {
        try {
          const accessToken = await getAccessToken();
          await actionFn(accessToken);
        } catch (err) {
          console.error("Google Photos Auth/Action Error:", err);
          alert("Azione annullata o autenticazione fallita.");
        }
      };

      // Esegui l'azione corretta in base all'ID del pulsante
      switch (actionBtn.id) {
        case 'menu-open-picker':
          try {
            const popup = window.open('about:blank', 'gphotos_picker', 'width=960,height=720');
            try { if (popup) popup.opener = null; } catch (e) {}
            const accessToken = await getToken();
            const res = await openNewPhotosPicker({ mode: 'replace', popup, accessToken });
            if (res === 'picked') {
              setImageSwitchBusy(true);
              try {
                const upd = await updateImages('google_photos');
                if (upd?.ok) {
                  await fetch(`${window.BACKEND_BASE}/api/settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ preferred_image_source: 'google_photos' })
                  });
                  window.PREFERRED_IMAGE_SOURCE = 'google_photos';
                  localStorage.setItem('preferred_image_source', 'google_photos');
                  syncGPhotosIcon();
                  showToast('Modalità impostata su “Google Foto” ✓', 'ok');
                } else {
                  showToast('Selezione fatta, ma non sono riuscito ad applicare le immagini.', 'error');
                }
              } finally {
                setImageSwitchBusy(false);
              }
            }
          } catch (err) {
            console.error('[Picker Flow] Errore di autenticazione:', err);
          }
          break;


        case 'menu-import-latest':
          await runAuthAction(async (token) => {
            await importLatestFromPhotos(50, token);
            await retryUpdateImages();
          });
          break;

        case 'menu-import-album':
          await runAuthAction(async (token) => {
            await importFromAlbumFlow(token);
            await retryUpdateImages();
          });
          break;
      }
    });

    btnFilterByDomain?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (domainDropdown.classList.contains('hidden')) {
            openDomainDropdown(); // <-- Verifica che chiami la funzione
        } else {
            closeDomainDropdown();
        }
    });

    domainListEl?.addEventListener('change', (e) => {
        const inp = e.target;
        if (inp?.matches('input[type="checkbox"][data-domain]')) {
            const dom = inp.getAttribute('data-domain');
            if (inp.checked) tmpHidden.delete(dom); // visibile
            else tmpHidden.add(dom); // nascosto
        }
    });

    domainSearch?.addEventListener('input', debounce(() => renderDomainDropdown(domainSearch.value), 150));

    domainSelectAll?.addEventListener('click', () => {
        const q = (domainSearch?.value || '').trim().toLowerCase();
        getAllDomains().forEach(dom => {
            if (!q || dom.includes(q)) tmpHidden.delete(dom);
        });
        renderDomainDropdown(domainSearch.value);
    });

    domainClearAll?.addEventListener('click', () => {
        const q = (domainSearch?.value || '').trim().toLowerCase();
        getAllDomains().forEach(dom => {
            if (!q || dom.includes(q)) tmpHidden.add(dom);
        });
        renderDomainDropdown(domainSearch.value);
    });

    domainCancelBtn?.addEventListener('click', closeDomainDropdown);

    domainApplyBtn?.addEventListener('click', async () => {
      setBtnBusy(domainApplyBtn, true);
      try {
        await fetch(`${window.API_URL}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ hidden_domains: Array.from(tmpHidden) })
        });
        userHiddenDomains = new Set(tmpHidden);
        closeDomainDropdown();
        await fetchFeed({ reset: true, force: true });
      } catch (e) {
        console.warn("[settings] salvataggio hidden_domains fallito:", e);
        showToast('Salvataggio filtri fallito.', 'error');
      } finally {
        setBtnBusy(domainApplyBtn, false);
      }
      try { lastFocusedEl?.focus(); } catch (e) {}
    });

     document.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-type-edit');
      const menu = document.getElementById('type-override-menu'); // Questo è l'ID corretto e ora unico
      
      if (btn && menu) {
        // Se clicco su un pulsante di modifica, apro il menu
        e.stopPropagation(); // Impedisce al click di propagarsi e chiudere subito il menu
        __typeTarget = btn.dataset.id;
        const r = btn.getBoundingClientRect();
        const mw = menu.offsetWidth || 224;                      // misura larghezza
        menu.style.left = Math.min(Math.max(8, r.left),          // clamp a dx/sx
                                  window.innerWidth - mw - 8) + 'px';
        // elemento fixed: NON aggiungere lo scroll
        menu.style.top  = (r.bottom + 6) + 'px';
        menu.classList.remove('hidden');
      } else if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) {
        // Se il menu è aperto e clicco in un punto qualsiasi fuori da esso, lo chiudo
        menu.classList.add('hidden');
      }
    });

    // Listener per GESTIRE il click su una delle voci del menu
    document.getElementById('type-override-menu')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-type]');
      if (!btn || !__typeTarget) return; // Esegui solo se clicco un bottone e ho un target
      
      const t = btn.dataset.type;
      document.getElementById('type-override-menu').classList.add('hidden'); // Chiudi il menu
      
      try { 
        await applyTypeOverride(__typeTarget, t); 
        showToast('Tipologia aggiornata per il dominio', 'ok'); 
      } catch (err) { 
        showToast('Errore nel salvataggio', 'error'); 
      } finally { 
        __typeTarget = null; // Resetta il target dopo l'operazione
      }
    });

    hiddenSheet?.addEventListener('click', async (e) => {
      // Azione per mostrare di nuovo un dominio
      const unhideDomainBtn = e.target.closest('.js-unhide-domain');
      if (unhideDomainBtn) {
        const domain = unhideDomainBtn.dataset.domain;
        setBtnBusy(unhideDomainBtn, true);
        try {
          const newHiddenDomains = new Set(userHiddenDomains);
          newHiddenDomains.delete(domain);
          
          await fetch(`${window.API_URL}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ hidden_domains: Array.from(newHiddenDomains) })
          });

          userHiddenDomains = newHiddenDomains; // Aggiorna lo stato globale
          renderHiddenLists(); // Ridisegna la lista nel pannello
          renderWithFilters(); // Aggiorna il feed principale
          showToast(`Dominio "${domain}" ora è visibile.`, 'ok');
        } catch (err) {
          showToast('Errore nel salvare le impostazioni.', 'error');
        } finally {
          setBtnBusy(unhideDomainBtn, false);
        }
      }

      // Azione per mostrare di nuovo un thread
      const unhideThreadBtn = e.target.closest('.js-unhide-thread');
      if (unhideThreadBtn) {
        const id = unhideThreadBtn.dataset.id;
        hiddenEmailIds.delete(id);
        saveHiddenIds(); // Salva in localStorage
        renderHiddenLists(); // Ridisegna la lista nel pannello
        renderWithFilters(); // Aggiorna il feed principale
        showToast('Thread ora visibile.', 'ok');
      }
    });

    // GESTORE PER LE AZIONI SULLE SINGOLE CARD (PREFERITI, NASCONDI, ETC.)
        feedContainer?.addEventListener('click', async (ev) => {
      const actionEl = ev.target.closest('[data-action]');
      if (!actionEl) return;

      ev.preventDefault();
      ev.stopPropagation();

      const card = ev.target.closest('.feed-card');
      const emailId = card?.dataset.emailId;
      if (!emailId) return;

      const action = actionEl.dataset.action;
      const item = getItemById(emailId);
      

      try {
      if (action === 'read-status-dot') {
        const text = isRead(emailId) ? 'Thread già letto' : 'Thread non letto';
        showReadStatusTooltip(actionEl, text);
        return;
      }
      if (action === 'fav') {
          const btn = actionEl.closest('button') || actionEl;
          const icon = btn.querySelector('.material-symbols-outlined');
          const card = ev.target.closest('[data-email-id]');
          const id = card?.dataset.emailId;
          if (!id || !icon) return;

          const was = btn.getAttribute('aria-pressed') === 'true';
          const now = !was;

          // 1. Aggiornamento ottimistico della UI
          icon.classList.toggle('ms-filled', now);
          btn.setAttribute('aria-pressed', String(now));
          const mem =getItemById(id);
          if (mem) mem.is_favorite = now;
          renderWithFilters(); // Assicuriamoci che la vista si aggiorni

          const cs = getComputedStyle(icon);
          console.log('[FE][info] fav.ui', {
            id, now, aria: btn.getAttribute('aria-pressed'),
            msFilled: icon.classList.contains('ms-filled'),
            fvs: cs.fontVariationSettings || cs.getPropertyValue('font-variation-settings')
          });

          // **FIX**: Log di verifica per il debug
          console.info('[FE][info] fav.ui', { id, now, aria: btn.getAttribute('aria-pressed'),
            msFilled: icon.classList.contains('ms-filled'),
            fvs: getComputedStyle(icon).getPropertyValue('font-variation-settings')
          });

          // **PATCH**: Log dettagliati
          feLog('info', 'fav.click', { id, was, now });

          try {
              // 2. Chiamata al backend
              const res = await fetch(`${window.API_URL}/feed/${id}/favorite`, {
                  method: 'POST',
                  credentials: 'include'
              });
              feLog('info', 'fav.res', { id, ok: res.ok, status: res.status });
              if (!res.ok) throw new Error('favorite_failed_' + res.status);
              const { is_favorite } = await res.json();
              feLog('info', 'fav.json', { id, is_favorite });

              // 3. Riallineamento (se il server risponde diversamente)
              if (is_favorite !== now) {
                  icon.classList.toggle('ms-filled', is_favorite);
                  btn.setAttribute('aria-pressed', String(is_favorite));
                  if (mem) mem.is_favorite = is_favorite;
                  renderWithFilters();
              }
          } catch (err) {
              feLog('error', 'fav.err', { id, err: String(err) });
              // 4. Rollback in caso di errore
              icon.classList.toggle('ms-filled', was);
              btn.setAttribute('aria-pressed', String(was));
              if (mem) mem.is_favorite = was;
              renderWithFilters();
              showToast('Azione fallita', 'error');
          }
          return;
        }

        if (action === 'hide') {
          const menu = document.getElementById('hide-menu');
          if (!menu || !card) return;

          const domain = (item?.source_domain || (item?.sender_email || '').split('@')[1] || '').toLowerCase();
          const r = actionEl.getBoundingClientRect();

          menu.dataset.emailId = emailId;
          menu.dataset.domain = domain || '';
          const domainTarget = menu.querySelector('#menu-hide-domain-target');
          if (domainTarget) domainTarget.textContent = domain;

          // misura e posiziona correttamente
          menu.style.visibility = 'hidden';
          menu.classList.remove('hidden');
          requestAnimationFrame(() => {
            const mw = menu.offsetWidth || 256;
            const mh = menu.offsetHeight || 120;

            let left = Math.min(r.left, window.innerWidth - mw - 8);
            left = Math.max(8, left);

            let top = r.bottom + window.scrollY + 6;
            const viewBottom = window.scrollY + window.innerHeight;
            if (top + mh > viewBottom) {
              top = r.top + window.scrollY - mh - 6; // apri sopra se non c’è spazio sotto
            }
            top = Math.max(8, top);

            menu.style.left = `${left}px`;
            menu.style.top  = `${top}px`;
            menu.style.visibility = 'visible';
          });

          return;
        }

                
        // --- INIZIO PATCH SICUREZZA window.open ---
        if (action === 'play') showToast('La riproduzione arriverà a breve 🎧', 'ok');
        if (action === 'reply') { 
            const to = item?.sender_email; 
            if (to) {
                const w = window.open(`mailto:${to}`, '_blank', 'noopener,noreferrer');
                if (w) w.opener = null;
            }
        }
        if (action === 'share') {
          const url = getGmailUrl(item);
          try {
            if (navigator.share) {
              await navigator.share({
                title: item.title || item.subject || 'Email',
                url
              });
            } else if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(url);
              showToast('Link copiato', 'ok');
            } else {
              const w = window.open(url, '_blank', 'noopener,noreferrer');
              if (w) w.opener = null;
            }
          } catch (err) {
            // Fallback robusto
            try {
              await navigator.clipboard.writeText(url);
              showToast('Link copiato', 'ok');
            } catch {
              const w = window.open(url, '_blank', 'noopener,noreferrer');
              if (w) w.opener = null;
            }
          }
          return;
        }

        if (action === 'open') {
          const linkParts = resolveGmailLinkParts(item || {}, item?.gmail_account_index || 0);
          if (isIOSDevice() || isAndroidDevice()) {
            openGmailAppOrWeb(linkParts);
          } else {
            openInNewTab(linkParts.webUrl || actionEl.dataset.url);
          }
          return;
        }
        // --- FINE PATCH ---

      } catch (e) {
        console.error(`[card-action] Errore:`, e);
        showToast('Azione fallita', 'error');
      }
    });

    document.getElementById('sheet-google-btn')?.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const popup = window.open('about:blank', 'gphotos_picker', 'width=960,height=720');
      try {
        // Usa direttamente il wrapper sicuro getToken che abbiamo creato
        const accessToken = await getToken({ prompt: 'consent' });
        const res = await openNewPhotosPicker({ mode: 'replace', popup, accessToken });
        if (res === 'picked' && typeof updateImages === 'function') {
          await updateImages('google_photos');
        }
      } catch (err) {
        console.error('[PickBtn] OAuth/Picker error:', err);
        // Chiudi il popup in caso di errore
        try { popup?.close(); } catch (e) {}
      }
    });

    document.getElementById('sheet-random-btn')?.addEventListener('click', async () => {
      setImageSwitchBusy(true);
      try {
        const upd = await updateImages('pixabay');
        if (!upd?.ok) {
          showToast('Aggiornamento immagini fallito. Resta la modalità precedente.', 'error');
          return;
        }
        await fetch(`${window.BACKEND_BASE}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ preferred_image_source: 'pixabay' })
        });
        window.PREFERRED_IMAGE_SOURCE = 'pixabay';
        localStorage.setItem('preferred_image_source', 'pixabay');
        syncGPhotosIcon();
        showToast('Modalità impostata su “Foto a caso” ✓', 'ok');
      } catch (e) {
        console.error("Errore nel passare a Pixabay:", e);
        showToast('Errore durante il cambio modalità.', 'error');
      } finally {
        setImageSwitchBusy(false);
        closePhotoSheet();
      }
    });

    if (photoSheetBackdrop) {
      photoSheetBackdrop.addEventListener('click', closePhotoSheet);
    }
    if (photoSheetClose) {
      photoSheetClose.addEventListener('click', closePhotoSheet);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePhotoSheet();
    });

    choosePhotoBtn?.addEventListener('click', openPhotoSheet);
    sheetCloseBtn?.addEventListener('click', closePhotoSheet);
    photoSheetBackdrop?.addEventListener('click', closePhotoSheet);

    if (pickBtn) {
  pickBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const popup = window.open('about:blank', 'gphotos_picker', 'width=960,height=720');
    try {
      const accessToken = await getToken({ prompt: 'consent' });
      const res = await openNewPhotosPicker({ mode: 'replace', popup, accessToken });
      if (res === 'picked' && typeof updateImages === 'function') {
        await updateImages('google_photos');
      }
    } catch (err) {
      console.error('[PickBtn] OAuth/Picker error:', err);
      try { popup?.close(); } catch (e) {}
    }
  });
}


    document.getElementById('btnImportLatest')?.addEventListener('click', async () => {
      const token = await getAccessToken();
      await importLatestFromPhotos(50, token);
      await retryUpdateImages();
    });

    document.getElementById('btnPickAlbum')?.addEventListener('click', async () => {
      const token = await getAccessToken();
      await importFromAlbumFlow(token);
      await retryUpdateImages();
    });

    allTabs?.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;

        // Gestione stato attivo/inattivo
        allTabs.forEach(t => {
          const isActive = t === tab;
          t.classList.toggle('text-gray-900', isActive);
          t.classList.toggle('text-gray-500', !isActive);
        });

        // Logica di navigazione
        if (tabName === 'feed') {
          setActiveTab(false);
          closeProfileSheet();
        } else if (tabName === 'favorites') {
          setActiveTab(true);
          closeProfileSheet();
        } else if (tabName === 'profile') {
          openProfileSheet();
        }
      });
    });

    if (btnAllInboxes) {
      btnAllInboxes.addEventListener('click', () => {
        try { openDomainDropdown(); } catch(e) { console.warn('[AllInboxes] open failed', e); }
      });
    }

    updateFeedBtn?.addEventListener('click', async () => {
    if (__isIngesting) {
        showToast('Sincronizzazione già in corso...', 'ok');
        return;
    }
    console.log("[UI] Aggiornamento manuale richiesto.");
    showInitialSkeletons(); // Mostra subito gli scheletri

    try {
        const { res, error } = await debugFetch(`${window.API_URL}/ingest/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch: 25 })
        }, "ingest/pull(btn)");

        if (error || !res || !res.ok) {
            throw new Error('Chiamata di ingest fallita');
        }
        
        const data = await res.json();
        if (data.job_id) {
            console.log(`[UI] Job ${data.job_id} ricevuto. Avvio ascolto SSE.`);
            handleIngestionState(data.job_id, {
              onDone: async () => {
                __isIngesting = false;
                __isInitialIngesting = false;
                await window.fetchFeed({ reset: false, cursor: __cursor });
                clearSentinel();
              },
              onError: () => {
                __isIngesting = false;
                __isInitialIngesting = false;
                clearSentinel();
              }
            });
        }
    } catch (e) {
        console.error("[UI] Errore durante l'avvio dell'ingestione:", e);
        showToast('Errore nell\'avviare l\'aggiornamento.', 'error');
        clearInitialSkeletons();
    }
});
    // 3. Logica di scroll e avvio

    /* ==== INFINITE SCROLL (sostituisci questo blocco) ==== */

let __scrollIO;
let __isScrollSetup = false; // <-- Flag per garantire l'inizializzazione singola

window.setupInfiniteScroll = function setupInfiniteScroll() {
  if (__isScrollSetup) {
    console.warn("[SCROLL] setupInfiniteScroll chiamato più di una volta. Ignoro.");
    return;
  }
  const sentinelEl = document.getElementById('load-more-sentinel');
  if (!sentinelEl) {
      console.error("Elemento sentinel non trovato. Lo scroll infinito non funzionerà.");
      return;
  }
  if (__scrollIO) __scrollIO.disconnect();

  __scrollIO = new IntersectionObserver(async (entries) => {
    const entry = entries[0];
    if (!entry || !entry.isIntersecting) return;

    // Evita di scatenare il sentinel durante il boot con gli skeleton
    if (FEED_STATE.initialSkeletonsVisible && !hasCards()) return;

    // Log di diagnostica
    dlog("sentinel_intersecting", { 
        hasMore: __hasMore, 
        inFlight: __inFlight, 
        isIngesting: __isIngesting, 
        cursor: __cursor 
    });

    if (__inFlight) return;

    if (__hasMore) {
      setSentinelBusy('Carico altri...');
      await window.fetchFeed({ reset: false, cursor: __cursor });
      return;
    }

    const now = Date.now();
    if (!__isIngesting && (now - __lastIngestAt > 30_000)) { // Cooldown ridotto
      __lastIngestAt = now;
      setSentinelBusy('Controllo la casella di posta…');
      autoIngestAndLoad({ reason: 'sentinel-scroll' }); // Passa un oggetto
      return;
    }
    
    toggleEndOfFeed(true); // Mostra "Fine del feed"
    clearSentinel();

  }, { rootMargin: '900px 0px 900px 0px' });

  __scrollIO.observe(sentinelEl);
  __isScrollSetup = true; // <-- Imposta il flag
  console.log("[SCROLL] Infinite scroll inizializzato correttamente.");
};

    sentinel?.addEventListener('click', () => {
      if (__inFlight) return;
      if (__hasMore) fetchFeed();
      else if (!__autoIngesting) autoIngestAndLoad({ reason: 'sentinel-click' });
    });
    sentinel?.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !__inFlight) {
        e.preventDefault();
        if (__hasMore) fetchFeed();
        else if (!__autoIngesting) autoIngestAndLoad({ reason: 'sentinel-key' });
      }
    });

    // 4. Avvio dell'applicazione
    mainAppStart();
});


async function finalizePendingGPhotosSession() {
  const userIdentifier = EVER_KEY.split(':')[1] || 'anonymous';
  const pendingSessionKey = `pending_gphotos_session:${userIdentifier}`;
  const raw = localStorage.getItem(pendingSessionKey);
  if (!raw) return;

  const pending = JSON.parse(raw);
  // scade dopo 2 ore
  if (!pending?.id || (Date.now() - (pending.ts || 0)) > 2*60*60*1000) {
    localStorage.removeItem(pendingSessionKey);
    return;
  }

  try {
    const accessToken = await getAccessTokenSilently();
    // prova a riversare gli item scelti dal picker direttamente dalla sessione
    const r = await fetch(`${window.BACKEND_BASE}/api/photos/picker/session/cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ session_id: pending.id, mode: 'replace' })
    });
    const json = await r.json().catch(()=> ({}));
    console.log('[Resume] cache_from_session:', r.status, json);

    if (r.ok && json.ok) {
      const upd = await (window.updateImages ? window.updateImages('google_photos') : null);
      if (upd?.ok) {
        await fetch(`${window.BACKEND_BASE}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ preferred_image_source: 'google_photos' })
        });
        window.PREFERRED_IMAGE_SOURCE = 'google_photos';
        localStorage.setItem('preferred_image_source', 'google_photos');
        window.syncGPhotosIcon?.();
        showToast('Foto aggiornate da Google Photos ✓', 'ok');
      }
    }
  } catch (e) {
    console.warn('[Resume] impossibile finalizzare la sessione:', e);
  } finally {
    localStorage.removeItem(pendingSessionKey);
  }
}

async function handleLogout() {
  console.log("-> [handleLogout] Avvio processo di logout.");

  // 1. Prima di fare logout, chiediamo al backend chi è l'utente corrente.
  // Questo ci serve per pulire la chiave corretta dal localStorage.
  let currentUserEmail = null;
  try {
    const meRes = await fetch(`${window.API_URL}/auth/me`, { credentials: 'include' });
    if (meRes.ok) {
      const me = await meRes.json();
      currentUserEmail = me?.email;
    }
  } catch (e) {
    console.warn("[handleLogout] Impossibile determinare l'utente prima del logout.", e);
  }

  // 2. Esegui la chiamata di logout al backend
  try {
    const r = await fetch(`${window.API_URL}/auth/logout`, { credentials: 'include' });
    if (!r.ok) throw new Error(`logout_${r.status}`);
    console.info("[handleLogout] Logout backend OK.");
  } catch (error) {
    console.error("[handleLogout] Errore durante il logout:", error);
  }

  // 3. Pulisci lo stato locale del frontend
  // Pulisci eventuale chiave legacy globale
  localStorage.removeItem('feedEverLoaded');
  // Pulisci anche la versione per-utente (già calcolata sopra)
  localStorage.removeItem(`feedEverLoaded:${currentUserEmail || 'anonymous'}`);
  
  // Resetta lo stato in memoria
  FEED_STATE.everLoaded = false;

  // 4. Ricarica la pagina per finalizzare il logout e mostrare la schermata di login
  // Usare location.reload() è spesso più robusto di cambiare solo il pathname.
  window.location.reload();
}
    
    function announce(msg){ try{ document.getElementById('sr-live').textContent = String(msg || ''); }catch{} }



  function setBtnBusy(btn, busy){
    if (!btn) return;
    if (busy){
      btn.setAttribute('data-busy','1');
      btn.setAttribute('aria-busy','true');
      btn.disabled = true;
    } else {
      btn.removeAttribute('data-busy');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  // Attiva/disattiva stato globale di “switch immagini”
  function setImageSwitchBusy(busy){
    document.body.classList.toggle('img-switching', !!busy);
    // Disabilita controlli coinvolti
    const sheetGoogleBtn   = document.getElementById('sheet-google-btn');
    const sheetRandomBtn   = document.getElementById('sheet-random-btn');
    setBtnBusy(sheetGoogleBtn, busy);
    setBtnBusy(sheetRandomBtn, busy);
    setBtnBusy(choosePhotoBtn, busy);
    setBtnBusy(gphotosMenuBtn, busy);
    if (busy) announce('Aggiornamento immagini in corso…');
    else announce('Aggiornamento immagini completato');
  }

async function loadGPhotosLogoInline(url = 'img/google-photos-logo.png') {
  try {
    const slot = document.getElementById('gphotos-logo-inline');
    const img  = document.getElementById('gphotos-logo-img');
    if (!slot) return;

    const res = await fetch(url, { cache: 'no-store' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    // Se NON è SVG, NON iniettare come HTML: usa <img>
    if (!ct.includes('image/svg')) {
      console.warn('[GPhotos][icon:inline] abort: content-type non SVG =', ct, '→ uso <img>', url);
      if (img) { img.hidden = false; img.src = url; }
      slot.hidden = true;
      slot.innerHTML = '';
      return;
    }

    const svg = await res.text();
    slot.innerHTML = svg;
    slot.hidden = false;
    if (img) img.hidden = true;

    const svgEl = slot.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('width', '24');
      svgEl.setAttribute('height', '24');
      svgEl.style.display = 'block';
    }
    console.log('[GPhotos][icon:inline] OK (inline render)');
  } catch (e) {
    console.warn('[GPhotos][icon:inline] fallback fallito:', e);
  }
}

// Prova i percorsi classici; se l'<img> fallisce → fallback inline
function resolveGPhotosLogo() {
  const img = document.getElementById('gphotos-logo-img');
  if (!img) return;

  const candidates = [
    'img/google-photos-logo.svg',
    'img/google-photos-logo.png',
    './img/google-photos-logo.svg',
    './img/google-photos-logo.png',
    '/img/google-photos-logo.svg',
    '/img/google-photos-logo.png',
    '/frontend/img/google-photos-logo.svg',
    '/frontend/img/google-photos-logo.png'
  ];

  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) {
      // Ultimo tentativo: provo l'inline SOLO se è un vero SVG
      return loadGPhotosLogoInline('img/google-photos-logo.svg');
    }
    const url = candidates[i++];
    const probe = new Image();
    probe.onload = () => {
      img.hidden = false;
      img.src = url;
      console.log('[GPhotos][icon] OK via <img>:', url, probe.naturalWidth + 'x' + probe.naturalHeight);
    };
    probe.onerror = () => {
      console.warn('[GPhotos][icon] FAIL via <img>:', url);
      tryNext();
    };
    probe.src = url + '?v=' + Date.now(); // bust cache
  };

  img.addEventListener('error', () => {
    console.warn('[GPhotos][icon] onerror dell’<img> → provo inline solo se SVG');
    loadGPhotosLogoInline(img.getAttribute('src') || 'img/google-photos-logo.svg');
  }, { once: true });

  tryNext();
}

function syncGPhotosIcon() {
  // Il nodo viene cercato qui, all'interno dello scope della funzione
  const btn = document.getElementById('gphotos-menu-btn');
  const useGPhotos = window.PREFERRED_IMAGE_SOURCE === 'google_photos';
  
  if (!btn) return; // Se il bottone non esiste, esci senza errori
  
  // Logica originale per mostrare/nascondere
  btn.style.display = useGPhotos ? '' : 'none';
  btn.classList.toggle('hidden', !useGPhotos);
  console.log('[GPhotos][sync] source=', window.PREFERRED_IMAGE_SOURCE, '| showIcon=', useGPhotos);
}

window.syncGPhotosIcon = syncGPhotosIcon;

    let tmpHidden = new Set();
    let knownDomains = new Set();
    let userHiddenDomains = new Set();
    
    let showOnlyFavorites = false;

// nascondi per-id (persistenza locale; se vuoi poi la portiamo su backend)
const hiddenEmailIds = new Set(JSON.parse(localStorage.getItem('hiddenEmailIds') || '[]'));
const saveHiddenIds = () =>
  localStorage.setItem('hiddenEmailIds', JSON.stringify([...hiddenEmailIds]));

// utility: trova l’item dal feed in memoria
const getItemById = (id) => itemsById.get(String(id));

// applica i filtri client (preferiti toggle + hidden locali)
const renderWithFilters = () => {
  if (__renderScheduled) return;
  __renderScheduled = true;
  requestAnimationFrame(() => {
    __renderScheduled = false;
    
    const filtered = applyClientFilters(allFeedItems);
    const visibleIds = new Set(filtered.map(it => String(it.email_id)));

    document.querySelectorAll('#feed-container .feed-card').forEach(card => {
      card.classList.toggle('hidden', !visibleIds.has(card.dataset.emailId));
    });

    document.querySelectorAll('.js-topic').forEach(el => {
      const on = __activeTopic && el.dataset.topic.toLowerCase() === __activeTopic.toLowerCase();
      el.classList.toggle('ring-2', on);
      el.classList.toggle('ring-white/40', on);
    });

    document.querySelectorAll('.js-sender').forEach(el => {
      const on = __activeSender && (el.dataset.sender || '') === __activeSender;
      el.classList.toggle('ring-2', on);
      el.classList.toggle('ring-white/40', on);
    });

    const isFiltered = showOnlyFavorites || __activeTopic || __activeSender || (activeTypes.size < TYPE_ORDER.length) || (activeReads.size < READ_STATES.length);
    document.getElementById('load-more-sentinel')?.classList.toggle('hidden', isFiltered);

    updateFeedCounter();
    updateTypeMenuCounters();

    if (__firstPaintDone) {
      const container = feedContainer || document.getElementById('feed-container');
      if (container) {
        const fragment = document.createDocumentFragment();
        for (const it of allFeedItems) {
          const node = cardNodes.get(String(it.email_id));
          if (node) fragment.appendChild(node);
        }
        container.appendChild(fragment);
      }
    }
  });
};


const applyClientFilters = (items) => {
  let out = items.filter(it => !hiddenEmailIds.has(String(it.email_id)));
  if (userHiddenDomains.size > 0) {
    out = out.filter(it => {
      const dom = (deriveDomainForItem(it) || '').toLowerCase();
      return !dom || !userHiddenDomains.has(dom);
    });
  }
  if (showOnlyFavorites) out = out.filter(it => !!it.is_favorite);

  if (activeTypes.size < TYPE_ORDER.length) {
    out = out.filter(it => activeTypes.has((it.type_tag || 'informative').toLowerCase()));
  }

  if (__activeTopic) {
    out = out.filter(it => (it.topic_tag || '').toLowerCase() === __activeTopic.toLowerCase());
  }

  if (__activeSender) {
    out = out.filter(it => (it.sender_email || '').toLowerCase() === __activeSender);
  }

  if (activeReads.size < READ_STATES.length){
    out = out.filter(it => activeReads.has(isRead(it.email_id) ? 'read' : 'unread'));
  }

  // --- INIZIO BLOCCO LOG ---
  feLog('info','filter.stats',{
    in: items.length,
    out: out.length,
    favorites: !!showOnlyFavorites,
    types: [...activeTypes],
    reads: [...activeReads],
    topic: __activeTopic || null,
    sender: __activeSender || null,
    hidden_ids: hiddenEmailIds.size,
    first_dt_out: out[0]?.received_date,
    last_dt_out: out[out.length-1]?.received_date
  });
  // --- FINE BLOCCO LOG ---

  return out;
};


function updateFeedCounter() {
  const counterEl = document.getElementById('feed-counter');
  if (!counterEl) return;

  // Conta solo le card attualmente visibili nel DOM
  const visibleCards = document.querySelectorAll('#feed-container .feed-card:not(.hidden)').length;
  
  if (visibleCards > 0) {
    counterEl.textContent = visibleCards;
    counterEl.classList.remove('hidden');
  } else {
    // Nascondi il contatore se non ci sono card visibili
    counterEl.classList.add('hidden');
  }
}

function setActiveTab(isFavorites) {
  __view = isFavorites ? 'favorites' : 'all';
  showOnlyFavorites = !!isFavorites;     
  
  const tabFeedBtn = document.querySelector('button[data-tab="feed"]');
  const tabFavBtn  = document.querySelector('button[data-tab="favorites"]');
  
  // Aggiorna lo stato visivo dei pulsanti
  tabFeedBtn?.classList.toggle('text-gray-900', !isFavorites);
  tabFeedBtn?.classList.toggle('text-gray-500',  isFavorites);
  tabFavBtn?.classList.toggle('text-gray-900',  isFavorites);
  tabFavBtn?.classList.toggle('text-gray-500', !isFavorites);
  
  const buttons = document.querySelectorAll('footer nav button[data-tab]');
  buttons.forEach(b => {
    const active = (b.dataset.tab === __view) || (b.dataset.tab === 'feed' && __view === 'all');
    b.classList.toggle('nav-active', active);
    b.setAttribute('aria-current', active ? 'page' : 'false');
  });

  // Applica il filtro alla vista corrente senza re-renderizzare
  applyViewFilter();
}

function setPhotoSheetSelected(mode) {
  const googleBtn = document.getElementById('sheet-google-btn');
  const randomBtn = document.getElementById('sheet-random-btn');
  const hint = document.getElementById('photo-mode-hint');

  const base = 'w-full inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold';
  const inactive = ' border-gray-200 bg-gray-50 text-gray-800 hover:bg-gray-100';
  const active   = ' border-gray-900 bg-gray-900 text-white';


  const isGoogle = (mode === 'google_photos');

  if (googleBtn) googleBtn.className = base + (isGoogle ? active : inactive);
  if (randomBtn) randomBtn.className = base + (!isGoogle ? active : inactive);

  if (hint) {
    hint.textContent = 'Modalità attuale: ' + (isGoogle ? 'Google Foto' : 'Foto a caso');
  }
}

const $ = (s) => document.querySelector(s);

// assicura che le variabili esistano sempre
 window.photoSheetBackdrop = window.photoSheetBackdrop ?? document.querySelector('#photo-sheet-backdrop, #photoSheetBackdrop') ?? null;
 window.photoSheet         = window.photoSheet         ?? document.querySelector('#photo-sheet, #photoSheet') ?? null;

// funzioni safe (non esplodono se gli elementi non ci sono)
function hidePhotoSheet() {
  if (photoSheetBackdrop) photoSheetBackdrop.classList.add('hidden');
  if (photoSheet) photoSheet.setAttribute('aria-hidden', 'true');
}

function openPhotoSheet() {
    const panel = photoSheet?.querySelector('.panel');
    if (!photoSheet || !photoSheetBackdrop || !panel) return;

    // --- PATCH ACCESSIBILITÀ ---
    photoSheet.setAttribute('role', 'dialog');
    photoSheet.setAttribute('aria-modal', 'true');
    // --- FINE PATCH ---

    photoSheet.classList.remove('hidden');
    photoSheetBackdrop.classList.remove('hidden');
    document.body.classList.add('body-lock');
    
    const mode = window.PREFERRED_IMAGE_SOURCE || 'pixabay';
    setPhotoSheetSelected(mode);

    requestAnimationFrame(() => {
        photoSheetBackdrop.style.opacity = '1';
        panel.style.transform = 'translateY(0)';
    });
}

function closePhotoSheet() {
    const panel = photoSheet?.querySelector('.panel');
    if (!photoSheet || !photoSheetBackdrop || !panel) return;

    photoSheetBackdrop.style.opacity = '0';
    panel.style.transform = 'translateY(100%)';

    setTimeout(() => {
        photoSheet.classList.add('hidden');
        photoSheetBackdrop.classList.add('hidden');
        document.body.classList.remove('body-lock');
    }, 220);
}

function getAllDomains() {
  const counts = window.__domainCounts || new Map();
  // ordina per frequenza desc
  return [...counts.entries()].sort((a,b) => b[1]-a[1]).map(([dom]) => dom);
}

// RENDER LISTA (con filtro)
function renderDomainDropdown(filter = "") {
    if (!domainListEl) return;
    const all = getAllDomains();
    const q = filter.trim().toLowerCase();
    domainListEl.innerHTML = '';
    const filtered = q ? all.filter(d => d.includes(q)) : all;

    if (filtered.length === 0) {
        domainListEl.innerHTML = `<p class="px-3 py-2 text-sm text-gray-500">Nessun dominio trovato.</p>`;
        return;
    }

    for (const dom of filtered) {
        const id = `dd-${dom.replace(/[^a-z0-9]/gi, '_')}`;
        const visible = !tmpHidden.has(dom); // checked = visibile
        const count = (window.__domainCounts && window.__domainCounts.get(dom)) || 0;

        const row = document.createElement('label');
        row.className = "flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer";
        const safeDom = esc(dom);
        row.innerHTML = `
            <input type="checkbox" id="${id}" data-domain="${safeDom}" ${visible ? 'checked' : ''} class="rounded border-gray-300" />
            <span class="truncate" title="${safeDom}"><strong>${safeDom}</strong></span>
            <span class="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">${count}</span>
        `;
        domainListEl.appendChild(row);
    }
}


function textToParagraphs(text) {
  if (!text) return '';
  return text
    .split(/\n+/)  // divide su newline multiple
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p class="mb-3 leading-relaxed">${p}</p>`)
    .join("");
}


function openDomainDropdown() {
    // Resetta lo stato temporaneo a quello salvato dall'utente
    tmpHidden = new Set(userHiddenDomains);
    
    // Salva l'elemento che aveva il focus per ripristinarlo alla chiusura
    lastFocusedEl = document.activeElement;

    domainDropdown.classList.remove('hidden');
    
    // Renderizza la lista aggiornata
    renderDomainDropdown(domainSearch?.value || "");
    
    // Metti il focus sul campo di ricerca
    setTimeout(() => domainSearch?.focus(), 50);
}
// --- FINE MICRO-FIX ---

function closeDomainDropdown() {
    if (domainDropdown) domainDropdown.classList.add('hidden');
}

async function createPickerSession(accessToken, maxItemCount = 50) {
  const r = await fetch('https://photospicker.googleapis.com/v1/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItemCount) } })
  });
  if (!r.ok) throw new Error('create_session_failed: ' + await r.text());
  return r.json();
}

// Poll finché mediaItemsSet = true (usa gli intervalli suggeriti)
async function pollSessionUntilReady(accessToken, sessionId, pollingConfig) {
  const intervalMs = parseDuration(pollingConfig?.pollInterval) ?? 3000;
  const timeoutMs  = parseDuration(pollingConfig?.timeoutIn)  ?? 120000;
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!r.ok) throw new Error('sessions_get_failed: ' + await r.text());
    const j = await r.json();
    if (j.mediaItemsSet) return j;
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error('picker_timeout');
}

async function listPickedMedia(accessToken, sessionId) {
  const out = [];
  let pageToken;
  do {
    const url = new URL('https://photospicker.googleapis.com/v1/mediaItems');
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error('mediaItems_list_failed: ' + await r.text());
    const j = await r.json();
    if (j.mediaItems) out.push(...j.mediaItems);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function deletePickerSession(accessToken, sessionId) {
  await fetch(`https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
}

function parseDuration(protoDuration /* "3.5s" */) {
  if (!protoDuration) return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(protoDuration);
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}

async function openPhotosPickerInline({accessToken, onPicked}) {
  await ensurePickerReady();

  const origin = window.location.origin; // es. http://localhost:5500
  const view = new google.picker.View(google.picker.ViewId.PHOTOS);
  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(accessToken)
    .setDeveloperKey(window.GOOGLE_API_KEY)
    .setOrigin(origin)                 // <— IMPORTANT
    .addView(view)
    .setSize(1050, 650)
    .setTitle('Scegli una foto')
    .setCallback((data) => {
      if (data.action === google.picker.Action.PICKED) {
        onPicked?.(data.docs || []);
      }
    })
    .build();

  picker.setVisible(true);
}

async function loadUserSettings() {
  try {
    const r = await fetch(`${window.BACKEND_BASE}/api/settings`, { credentials: 'include' });
    if (!r.ok) throw new Error(`settings_get_${r.status}`);
    const s = await r.json();

    const src = (s.preferred_image_source === 'google_photos') ? 'google_photos' : 'pixabay';
window.PREFERRED_IMAGE_SOURCE = src;
localStorage.setItem('preferred_image_source', window.PREFERRED_IMAGE_SOURCE);
syncGPhotosIcon();
    console.log('[GPhotos][settings] preferred_image_source (server)=', s.preferred_image_source);
    console.log('[GPhotos][settings] preferred_image_source (effective)=', window.PREFERRED_IMAGE_SOURCE);
    resolveGPhotosLogo();

    // Se hai un toggle UI locale, allinealo (se esiste)
    const photoSourceToggle = document.getElementById('photo-source-toggle');
    if (photoSourceToggle) {
  photoSourceToggle.checked = (src === 'google_photos');
}

    userHiddenDomains = new Set(Array.isArray(s.hidden_domains) ? s.hidden_domains : []);
  } catch (e) {
    console.warn("[settings] impossibile caricare settings utente:", e);
    // Fallback locale se il backend non risponde
    const ls = localStorage.getItem('preferred_image_source');
window.PREFERRED_IMAGE_SOURCE = (ls === 'google_photos') ? 'google_photos' : 'pixabay';
userHiddenDomains = new Set();
syncGPhotosIcon();
resolveGPhotosLogo(); // <— tenta comunque a trovare il file
    console.log('[GPhotos][settings:fallback] preferred (localStorage)=', window.PREFERRED_IMAGE_SOURCE);

  }
}


    // --- FUNZIONI HELPER ---
    const markdownToHtml = (md) => {
        if (typeof md !== 'string') return '';
        return md.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    };

function computeSummaryCount(md){
  if (typeof md !== 'string') return 0;
  const lines = md.split('\n').map(s => s.trim());
  // bullet tipici
  let bullets = lines.filter(l => /^[-*•]\s+/.test(l)).length;
  if (bullets) return bullets;
  // fallback semplice: conta frasi
  const sentences = md.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  return Math.min(sentences.length, 10);
}

function formatRelativeTime(isoLike){
  if (!isoLike) return '';
  const d = new Date(isoLike); if (isNaN(d)) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s fa`;
  const m = Math.floor(s/60); if (m < 60) return `${m}m fa`;
  const h = Math.floor(m/60); if (h < 24) return `${h}h fa`;
  const g = Math.floor(h/24); if (g < 30) return `${g}g fa`;
  const mesi = Math.floor(g/30); if (mesi < 12) return `${mesi} mesi fa`;
  const anni = Math.floor(mesi/12); return `${anni} anni fa`;
}

function getImageQuery(item){
  const keys = [
    'image_query',
    'image_search_term',
    'pixabay_query',
    'image_prompt',
    'image_search_query',
    'image_keywords',
    'image_query_term',
    'img_query',
    'pixabay_search_term'
  ];
  for (const k of keys) {
    if (item && item[k]) return String(item[k]);
  }
  return '';
}

function wireImageDebugging(root = document) {
  const imgs = root.querySelectorAll('.feed-card img.card-image');
  imgs.forEach((img) => {
    const id = img.closest('.feed-card')?.dataset.emailId || 'n/a';
    const logSrc = () => img.currentSrc || img.src;

    const onLoad = () => {
      console.log(`[IMG][OK] id=${id} size=${img.naturalWidth}x${img.naturalHeight} src=${logSrc()}`);
    };
    const onError = () => {
      console.error(`[IMG][ERR] id=${id} src=${logSrc()} (frontend=${location.origin} backend=${new URL(window.BACKEND_BASE).origin})`);
      // Fallback garantito (anche se già settato prima)
      if (img.dataset.fallback !== '1') {
        img.dataset.fallback = '1';
        img.src = `https://picsum.photos/seed/${id}-fallback/800/600`;
        console.warn(`[IMG][FALLBACK] id=${id} → picsum`);
      }
    };

    img.removeEventListener('load', onLoad);
    img.removeEventListener('error', onError);
    img.addEventListener('load', onLoad, { once: true });
    img.addEventListener('error', onError, { once: true });
  });
}

let __applyPrefTimer = null;
    ;     // una sola fetch alla volta
    let __lastResetAt = 0;      // anti-bounce reset
    const __RESET_DEBOUNCE_MS = 300;

    // per debug
    const dbg = {
      page: 0,
      total: 0,
    };

function extractHostname(u) {
  if (!u || u.startsWith('mailto:') || u.startsWith('tel:')) return null;
  try { return new URL(u).hostname.replace(/^www\./,'').toLowerCase(); } 
  catch { return null; }
}

function deriveDomainForItem(item) {
  // 1) se backend ha già calcolato source_domain, usa quello
  if (item.source_domain) {
    return item.source_domain.toLowerCase();
  }

  // 2) fallback: prendi dal mittente email
  if (item.sender_email && item.sender_email.includes('@')) {
    return item.sender_email.split('@')[1].toLowerCase();
  }

  // 3) altrimenti prova dai link
  if (item.link) {
    return extractHostname(item.link);
  }

  if (item.full_content_html) {
    const m = item.full_content_html.match(/href="([^"]+)"/i);
    if (m) return extractHostname(m[1]);
  }

  return null;
}

function mdToHtmlSafe(md) {
  if (!md) return '';
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const autolink = (txt) =>
    txt.replace(/((?:https?:\/\/|mailto:)[^\s<]+[^<.,:;"')\]\s])/gi,
      (m) => `<a href="${esc(m)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${esc(m)}</a>`);

  const inline = (s) => autolink(
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g,     '<code>$1</code>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  );

  const lines = String(md).split(/\n+/);
  let out = [], inList = false;
  for (const raw of lines) {
    const l = raw.trim(), isBullet = /^[-*•]\s+/.test(l);
    if (isBullet) { if (!inList) { out.push('<ul class="md-list">'); inList = true; }
      out.push('<li>' + inline(l.replace(/^[-*•]\s+/, '')) + '</li>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      if (l) out.push('<p class="md-p">' + inline(l) + '</p>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}


function isLikelyDomain(s){ return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s || ''); }

function sanitizeDomain(dom) {
  return String(dom || '')
    .trim()
    .replace(/[>\s]+$/g, '')     // rimuove '>' e spazi finali
    .replace(/^<+/g, '')         // rimuove eventuali '<' iniziali
    .replace(/^www\./, '')
    .toLowerCase();
}

function getSenderIdentity(item){
  const sender_email = item.sender_email || '';
  const sender_name  = item.sender_name  || '';
  const senderLabel  = sender_name || sender_email || 'Newsletter';

  let domain = (sender_email.includes('@') ? sender_email.split('@')[1] : '').trim();
  domain = sanitizeDomain(domain);
  const logoSrc = domain ? `https://icons.duckduckgo.com/ip3/${domain}.ico` : null;

  return { senderLabel, logoSrc };
}

function formatDayMonthLabel(isoLike){
  if (!isoLike) return '';
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
}

function getAverageColorFromImage(img) {
  try {
    const w = Math.max(1, Math.min(48, img.naturalWidth || img.width || 48));
    const h = Math.max(1, Math.min(48, img.naturalHeight || img.height || 48));
    const can = document.createElement('canvas');
    can.width = w; can.height = h;
    const ctx = can.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let r=0,g=0,b=0,n=0;
    for (let i=0; i<data.length; i+=4) { r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++; }
    if (!n) return null;
    return { r: Math.round(r/n), g: Math.round(g/n), b: Math.round(b/n) };
  } catch { return null; }
}

function applyColorsFromImage(card, img) {
  if (!card || !img) return;
  const key = img.currentSrc || img.src || '';
  let bg = __colorCache.get(key);
  if (!bg) {
    const avg = getAverageColorFromImage(img);
    if (!avg) return;
    const darkR = Math.round(avg.r * 0.6);
    const darkG = Math.round(avg.g * 0.6);
    const darkB = Math.round(avg.b * 0.6);
    bg = `rgb(${darkR}, ${darkG}, ${darkB})`;
    __colorCache.set(key, bg);
  }
  // --- INIZIO MODIFICA ---
  // Imposta una variabile CSS sulla card invece di un colore fisso.
  if (card) {
    card.style.setProperty('--accent', bg);
  }
  // --- FINE MODIFICA ---
}

// --- FUNZIONI DI RENDERING PRINCIPALI ---
let __cardRenderCount = 0; // Contatore per fetchpriority

function renderFeedCard(item, opts = {}) {
  const cardEl = document.createElement('article');
  cardEl.className = 'feed-card opacity-0';
  cardEl.dataset.emailId = item.email_id;
  cardEl.dataset.received = item.received_date || '';
  __cardRenderCount++;
  const isFav = !!item.is_favorite;
  const title = item.ai_title || item.original_subject || '';
  const safeTitle = esc(title);
  const safeSenderName = esc(item.sender_name || item.sender_email);
  const safeTopicTag = esc(item.topic_tag || '');
  const safeTopicTagAttr = escAttr(item.topic_tag || '');
  const openUrl = getGmailUrl(item);
  const safeOpenUrl = escAttr(openUrl);
  const domainPart = (item.sender_email?.split('@')[1] || '').trim();
  const safeDomain = isLikelyDomain(domainPart) ? sanitizeDomain(domainPart) : '';
  const logoHtml = safeDomain
    ? `<img class="avatar-dot" src="https://icons.duckduckgo.com/ip3/${safeDomain}.ico" alt="${escAttr(item.sender_name || '')}" loading="lazy">`
    : '';
  
  // --- INIZIO MODIFICA ---
  // Fallback color usato se --accent non è definito
  const bgColor = item.accent_hex || 'var(--card-1, #374151)';
  const bgGradient = `linear-gradient(135deg, var(--accent, ${bgColor}) 0%, #111827 100%)`;
  // --- FINE MODIFICA ---

  cardEl.innerHTML = `
    <div class="image-wrapper w-full" style="background-color:var(--accent, ${bgColor}); line-height:0;">
      <img alt="Copertina per ${safeTitle}" class="card-image w-full h-full object-cover" width="800" height="450">
    </div>
    <div class="tile-dark p-4 md:p-5 tile-attach" style="background:${bgGradient};">
      <div class="flex items-center gap-2 text-xs mb-3">
        ${logoHtml}
        <button type="button"
              class="badge js-sender"
              data-sender="${escAttr((item.sender_email || '').toLowerCase())}"
              title="Filtra per mittente">
        ${safeSenderName}
      </button>
      </div>
      <h2 class="reading-title text-2xl font-bold leading-tight mb-1">${safeTitle}</h2>
      <div class="reading-copy text-[15px] text-white/90 mt-2">${mdToHtmlSafe(item.ai_summary_markdown) || '<p class="md-p">...</p>'}</div>
      <div class="mt-5">
        <div class="flex items-start justify-between mb-3">
          <div class="text-xs text-white/80 leading-tight">
            <div class="flex items-center gap-2">
            <button type="button" class="font-medium underline-offset-2 hover:underline js-type-edit" data-id="${escAttr(item.email_id)}">
              ${esc(item.type_tag || 'Newsletter')}
            </button>
            <button type="button" class="read-dot-btn" data-action="read-status-dot" aria-label="Mostra stato lettura">
              <span class="read-dot" data-read-dot></span>
            </button>
          </div>
            <div class="mt-1">${new Date(item.received_date).toLocaleString('it-IT', {dateStyle: 'medium', timeStyle: 'short'})}</div>
          </div>
          ${item.topic_tag ? `<button type="button" class="tag-chip js-topic" data-topic="${safeTopicTagAttr}">${safeTopicTag}</button>` : ''}
        </div>
        <div class="py-2 -mx-4 -mb-4 rounded-b-lg" style="background-color: rgba(0,0,0,0.2);">
          <div class="flex justify-around text-white/80">
            <button type="button" class="icon-btn" data-action="share" aria-haspopup="true" aria-label="Condividi">
              <span class="material-symbols-outlined" aria-hidden="true">ios_share</span>
            </button>
            <button type="button" class="icon-btn" data-action="fav" aria-pressed="${!!item.is_favorite}" aria-label="${item.is_favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">
              <span class="material-symbols-outlined ${!!item.is_favorite ? 'ms-filled' : ''}" aria-hidden="true">favorite</span>
            </button>
            <button type="button" class="icon-btn" data-action="open" data-url="${safeOpenUrl}" rel="noopener noreferrer" aria-label="Apri in una nuova scheda">
              <span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>
            </button>
            <button type="button" class="icon-btn" data-action="play" aria-label="Ascolta riassunto">
              <span class="material-symbols-outlined" aria-hidden="true">play_circle</span>
            </button>
            <button type="button" class="icon-btn" data-action="hide" aria-haspopup="true" aria-label="Nascondi email">
              <span class="material-symbols-outlined" aria-hidden="true">visibility_off</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const imgEl = cardEl.querySelector('img.card-image');
  if (imgEl) {
    imgEl.dataset.emailId = String(item.email_id || '');
  }
  const imageUrl = item.image_url || '';

  if (__cardRenderCount <= 3) {
    imgEl.loading = 'eager';
    imgEl.fetchPriority = 'high';
  } else {
    imgEl.loading = 'lazy';
    imgEl.fetchPriority = 'low';
  }
  imgEl.decoding = 'async';

  if (!opts.skipImageInit && imgEl && imageUrl) {
    const isInternal = isInternalImageUrl(imageUrl);
    const finalSrc = isInternal ? imageUrl : buildImageProxyUrl(imageUrl, item.email_id);
    
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
    imgEl.addEventListener('load', () => {
      imgEl.style.opacity = 1;
      if (!__firstPaintDone || __cardRenderCount <= FIRST_PAINT_COUNT) {
        try { applyColorsFromImage(cardEl, imgEl); } catch {}
      } else {
        idle(() => { try { applyColorsFromImage(cardEl, imgEl); } catch {} });
      }
    }, { once: true });
    setCardImageCached(imgEl, item.email_id, finalSrc, isInternal);
  } else {
    if(imgEl) imgEl.style.opacity = 1;
  }

  return cardEl;
}


function updateFeedCard(cardEl, item) {
  const titleEl = cardEl.querySelector('.reading-title');
  const newTitle = item.ai_title || item.original_subject || '';
  if (titleEl && titleEl.textContent !== newTitle) titleEl.textContent = newTitle;

  const summaryEl = cardEl.querySelector('.reading-copy');
  const newSummaryHtml = item.ai_summary_markdown
    ? mdToHtmlSafe(item.ai_summary_markdown)
    : '<p class="md-p">Elaborazione del contenuto...</p>';
  if (summaryEl && summaryEl.innerHTML !== newSummaryHtml) {
    summaryEl.innerHTML = newSummaryHtml;
  }

  const imgEl = cardEl.querySelector('.card-image');
  if (imgEl && item.image_url) {
    const isInternal = isInternalImageUrl(item.image_url);
    const newSrc = isInternal
      ? item.image_url
      : buildImageProxyUrl(item.image_url, item.email_id);

    const cur = imgEl.currentSrc || imgEl.src || '';
    if (cur !== newSrc) {
      imgEl.style.opacity = 0;

      loadWithRetry(newSrc)
        .then(preImg => {
          try { applyColorsFromImage(cardEl, preImg); } catch {}
          setCardImage(imgEl, newSrc, isInternal);
          imgEl.style.display = 'block';
          imgEl.style.transition = 'opacity .25s ease-in';
          requestAnimationFrame(() => { imgEl.style.opacity = 1; });
          cardEl.classList.remove('opacity-0');
        })
        .catch(() => { // Questo catch ora gestisce il fallimento anche di picsum
          imgEl.src = '/img/loading.gif'; // Fallback finale
          imgEl.style.opacity = 1;
          cardEl.classList.remove('opacity-0');
        });
    }
  }

const favBtn = cardEl.querySelector('[data-action="fav"]');
  const favIcon = favBtn?.querySelector('.material-symbols-outlined');
  if (favIcon && favBtn) {
    const isFav = !!item.is_favorite;
    favBtn.setAttribute('aria-pressed', String(isFav));
    favIcon.classList.toggle('ms-filled', isFav);
  }
}

function createSkeletonNode() {
  const el = document.createElement('article');
  el.className = 'skeleton-card'; // Questa classe attiva l'animazione shimmer di base
  el.setAttribute('aria-busy', 'true');
  // NOTA: Non usiamo più stili inline, lasciamo che il CSS gestisca le larghezze
  // per un look più consistente.
  el.innerHTML = `
    <div class="skel-img"></div>
    <div class="p-4">
      <div class="skel-line" style="width: 40%;"></div>
      <div class="skel-line" style="width: 80%;"></div>
      <div class="skel-line" style="width: 60%;"></div>
    </div>
  `;
  return el;
}

 window.createSkeletonNode = window.createSkeletonNode || createSkeletonNode;

 function loadImageWithDiagnostics(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    let timer;

    const finish = (ok, err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      if (ok) {
        if (img.decode) {
          img.decode().then(() => resolve(img)).catch(() => resolve(img)); // Risolve anche se decode fallisce
        } else {
          resolve(img);
        }
      } else {
        reject(err || new Error('image load failed'));
      }
    };

    timer = setTimeout(() => finish(false, new Error('timeout')), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = (e) => finish(false, e?.message || 'network');
    
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}
async function loadWithRetry(u){
  for (const t of [3000, 6000]){
    try{ return await loadImageWithDiagnostics(u, t); }catch{}
  }
  const seed = Math.random().toString(36).slice(2);
  return loadImageWithDiagnostics(`https://picsum.photos/seed/${seed}/800/600`, 4000);
}

async function prepareAndMountCard(item, placeholder) {
  // Comando: Non bloccare il montaggio della card sull'esito del preload.
  // La logica di attesa dell'immagine è stata rimossa da questa funzione.

  if (!placeholder || !placeholder.isConnected) {
    placeholder = getOrCreatePlaceholder(item.email_id);
  }
  // Guardia per evitare di montare una card già presente
  if (cardNodes.has(item.email_id)) {
    removePlaceholder(item.email_id); // Pulisci il placeholder duplicato se esiste
    return;
  }

  // 1. Renderizza e monta la card IMMEDIATAMENTE
  // La funzione renderFeedCard ora gestisce l'avvio del caricamento dell'immagine in background.
  const card = renderFeedCard(item);
  
  feLog('info', 'PH->CARD', { email_id: item.email_id });
  placeholder.replaceWith(card);
  observeReadCard(card); // <-- AGGIUNGI QUESTA RIGA
  cardNodes.set(item.email_id, card);
  __mountedIds.add(item.email_id);
  feLog('info', 'MOUNTED', { email_id: item.email_id });

  // 2. Rimuovi l'opacità per mostrare subito il testo e lo sfondo della card.
  // L'immagine apparirà con una sua transizione quando sarà pronta.
  requestAnimationFrame(() => {
    card.classList.remove('opacity-0');
  });
}


(function(){
  if (typeof window.prepareAndMountCard === 'function') {
    const _prepare = window.prepareAndMountCard;
    window.prepareAndMountCard = async function(item, ph){
      const t0 = performance.now();
      try { return await _prepare(item, ph); }
      finally {
        console.log(`[DIAG] mount ${item?.email_id} Δ=${(performance.now()-t0).toFixed(1)}ms`
          + ` text=${!!(item?.ai_title && item?.ai_summary_markdown)} img=${!!item?.image_url}`);
      }
    };
  }
})();

function applyViewFilter() {
    // Questa funzione è ora un alias per renderWithFilters per mantenere la compatibilità
    // con le parti del codice che la chiamano. La logica di filtraggio è centralizzata
    // in applyClientFilters, e il rendering in renderWithFilters.
    renderWithFilters();
}

async function upsertFeedItems(items, { append = false, prepend = false } = {}) {
  if (!feedContainer) return;
  if (!Array.isArray(items) || items.length === 0) return;

  if (!append && !prepend && __firstPaintDone) {
    document.querySelectorAll('.skeleton-card[data-boot="1"]').forEach(n => n.remove());
    document.getElementById('feed-loading-indicator')?.remove();
  }

  const newItems = [];
  for (const it of items) {
    if (__mountedIds.has(it.email_id)) continue;
    newItems.push(it);
  }
  if (newItems.length === 0) return;

  const firstCard = feedContainer.querySelector('.feed-card:not(.hidden)');
  const topBefore = firstCard ? firstCard.getBoundingClientRect().top : 0;

  const fragment = document.createDocumentFragment();
  const placeholders = [];
  for (const item of newItems) {
    const ph = createSkeletonNode();
    ph.dataset.state = 'skeleton-item';
    ph.id = `ph-${item.email_id}`;
    ph.setAttribute('data-email-id', item.email_id);
    fragment.appendChild(ph);
    placeholders.push([item, ph]);
  }
  
  // --- INIZIO MODIFICA ---
  // Inserisce gli scheletri in cima se è un prepend, altrimenti in fondo.
  if (prepend) {
    feedContainer.insertBefore(fragment, feedContainer.firstChild);
  } else {
    feedContainer.appendChild(fragment);
  }

  // Determina l'ordine di caricamento: invertito per il prepend per ridurre i salti.
  const loadOrder = prepend ? placeholders.slice().reverse() : placeholders;
  // --- FINE MODIFICA ---

  if (!__firstPaintDone) {
    // --- INIZIO MODIFICA (usa loadOrder) ---
    const firstBatch = loadOrder.slice(0, FIRST_PAINT_COUNT);
    const restBatch  = loadOrder.slice(FIRST_PAINT_COUNT);
    // --- FINE MODIFICA ---

    const t0 = performance.now();
    await mapLimit(firstBatch, 4, ([it, ph]) => prepareAndMountCard(it, ph));
    console.log('[first.paint.ready]', {count: firstBatch.length, ms: Math.round(performance.now()-t0)});

    document.querySelectorAll('.skeleton-card[data-boot="1"]').forEach(n => n.remove());
    document.getElementById('feed-loading-indicator')?.remove();
    __firstPaintDone = true;

    if (restBatch.length > 0) {
      await mapLimit(restBatch, 6, ([it, ph]) => prepareAndMountCard(it, ph));
    }
  } else {
    // --- INIZIO MODIFICA (usa loadOrder) ---
    await mapLimit(loadOrder, 6, ([it, ph]) => prepareAndMountCard(it, ph));
    // --- FINE MODIFICA ---
  }
  if (prepend && firstCard && topBefore) {
    const topAfter = firstCard.getBoundingClientRect().top;
    window.scrollBy(0, topAfter - topBefore);
  }
}

window.fetchFeed = async ({ reset = false, cursor = null, force = false } = {}) => {
  dlog("fetch_start", { reset, cursor, force, inFlight: __inFlight, isIngesting: __isIngesting });

  if (__inFlight && !force) {
    return;
  }
  __inFlight = true;

  if (reset) {
    __cursor = null;
    __hasMore = true;
    allFeedItems = [];
    itemsById.clear();
    __mountedIds.clear();
    clearFeed('fetchFeed(reset=true)');
    toggleEndOfFeed(false);
  }

  const prepend = !reset && !cursor && hasCards();
  const append = !!cursor || (cursor === null && !hasCards());
  const size = __firstPaintDone ? __PAGE_SIZE : FIRST_PAINT_COUNT;
  const params = new URLSearchParams({ page_size: String(size) });
  const currentCursor = append ? (cursor || __cursor) : null;

  if (currentCursor) {
    params.set('before', currentCursor);
  }

  const url = `${API_URL}/feed?${params.toString()}`;
  if (__feedAbort) {
    try {
      __feedAbort.abort();
    } catch {}
  }
  const ctrl = new AbortController();
  __feedAbort = ctrl;

  try {
    const t0_fetch = performance.now();
    const res = await fetch(url, {
      credentials: 'include',
      signal: ctrl.signal,
      headers: {
        "X-Request-Id": (window.crypto?.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).slice(2)).slice(0, 12)
      }
    });
    console.log('[FEED][resp]', res.status, url);
    const data = res.ok ? await res.json() : null;
    if (!data || typeof data !== 'object' || !('feed' in data)) {
      // Evita di rileggere il body (già consumato) per non generare errori
      console.error('[FEED][bad-json]', res.status, url);
      __inFlight = false;
      return;
    }
    console.log('[feed.fetch.ms]', Math.round(performance.now() - t0_fetch), res.headers.get('server-timing'));


    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[fetchFeed] Errore HTTP ${res.status}:`, errorText.slice(0, 500));
      showToast(`Errore di comunicazione (${res.status})`, 'error');
      hideLoadingFooter();
      clearSentinel();
      return;
    }

    // --- INIZIO BLOCCO LOG ---
    feLog('info','feed.page',{
      reset, append, prepend,
      page_len: Array.isArray(data?.feed)? data.feed.length : 0,
      has_more: !!data?.has_more,
      next_cursor: data?.next_cursor,
      first_dt: data?.feed?.[0]?.received_date,
      last_dt: data?.feed?.[data.feed.length-1]?.received_date
    });
    // Date malformate
    const bad = (data.feed||[]).filter(it => isNaN(new Date(it.received_date)));
    if (bad.length) feLog('warn','feed.page.bad_dates', {count: bad.length, samples: bad.slice(0,3).map(x=>({id:x.email_id, dt:x.received_date}))});
    // --- FINE BLOCCO LOG ---

    const page = Array.isArray(data?.feed) ? data.feed : [];

    __hasMore = Boolean(data.has_more);
    window.__pendingMore = Boolean(data.pending_more); 
    __isIngesting = data?.ingest?.running || false;

    if (page.length === 0 && !reset) {
      reconcileEndOfFeed();
      return;
    }

    mergeFeedMemory(page, { prepend });
    await upsertFeedItems(page, { append, prepend });

    if (prepend) {
      clearSentinel();
    }

    applyViewFilter();

    // Il cursore si aggiorna solo se ci sono altre pagine
    if (data.has_more) {
        __cursor = data.next_cursor ?? null;
    }
    __hasMore = Boolean(data.has_more);

    if (data?.ingest?.running && data.ingest.job_id) {
      handleIngestionState(data.ingest.job_id);
    }

    reconcileEndOfFeed();

  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error("[fetchFeed] ERRORE:", err);
    }
  } finally {
    __inFlight = false;
    if (__feedAbort === ctrl) {
      __feedAbort = null;
    }
    if (!FEED_STATE.everLoaded && hasCards()) {
      setEverLoaded(true);
    }
  }
};

function mergeFeedMemory(pageItems = [], { prepend = false } = {}) {
  if (!Array.isArray(pageItems) || pageItems.length === 0) return;
  const MAX_CACHE = 1500;

  const fresh = [];

  for (const it of pageItems) {
    const k = String(it.email_id);
    if (itemsById.has(k)) {
      const idx = allFeedItems.findIndex(x => String(x.email_id) === k);
      if (idx >= 0) allFeedItems[idx] = it;
    } else {
      fresh.push(it);
    }
    itemsById.set(k, it);
  }

  if (fresh.length) {
    if (prepend) {
      allFeedItems = fresh.concat(allFeedItems);
    } else {
      allFeedItems = allFeedItems.concat(fresh);
    }
  }

  if (allFeedItems.length > MAX_CACHE) {
    const removed = allFeedItems.splice(MAX_CACHE);
    for (const it of removed) {
      itemsById.delete(String(it.email_id));
    }
  }

  // Assicura ordinamento temporale stabile (più recenti in alto).
  // Tie-break su email_id (desc) per un cursore coerente con il backend.
  const cmp = (a, b) => {
    const ta = Date.parse(a?.received_date) || 0;
    const tb = Date.parse(b?.received_date) || 0;
    if (tb !== ta) return tb - ta;
    const ida = String(a?.email_id ?? '');
    const idb = String(b?.email_id ?? '');
    return idb.localeCompare(ida);
  };
  allFeedItems.sort(cmp);

  recomputeDomainCounts(allFeedItems);

  if (domainDropdown && !domainDropdown.classList.contains('hidden')) {
    renderDomainDropdown(domainSearch?.value || "");
  }

  // Dopo il sort non dovremmo avere discontinuità.
}


document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState !== 'visible';
  if (__readObserver) {
    const cards = document.querySelectorAll('#feed-container .feed-card');
    cards.forEach(card => {
      try {
        if (hidden) {
          __readObserver.unobserve(card);
        } else {
          // Osserva di nuovo solo se non è già stato letto
          if (!isRead(card.dataset.emailId)) {
            __readObserver.observe(card);
          }
        }
      } catch {}
    });
  }
});

function recomputeDomainCounts(items){
  const counts = new Map();
  for (const it of items){
    const dom = rootDomain(deriveDomainForItem(it) || "");
    if (!dom) continue;
    counts.set(dom, (counts.get(dom) || 0) + 1);
  }
  window.__domainCounts = counts;
}

const mkSrcSet = (u)=> `${u.replace(/w=\d+/, 'w=800').replace(/h=\d+/, 'h=450')} 1x, ${u.replace(/w=\d+/, 'w=1600').replace(/h=\d+/, 'h=900')} 2x`;
    // --- LOGICA DI AGGIORNAMENTO IMMAGINI ---

const updateImages = async (overrideSource = null) => {
    console.log("-> [updateImages] Avvio processo...");

    const imageSource = overrideSource || window.PREFERRED_IMAGE_SOURCE || 'pixabay';
    console.debug("[IMG] updateImages request", {
        source: imageSource, 
        only_empty: (imageSource === 'pixabay') 
    });

    const cards = document.querySelectorAll('.feed-card');
    if (cards.length === 0) {
        console.warn("[updateImages] WARN: Nessuna card da aggiornare.");
        return { ok: false, reason: 'no_cards' };
    }

    const emailIds = Array.from(cards).map(card => card.dataset.emailId);
    console.log(`[updateImages] Aggiornamento di ${emailIds.length} immagini. Nuova fonte: ${imageSource}`);

    const body = { email_ids: emailIds, image_source: imageSource };
    if (imageSource === 'pixabay') body.only_empty = true;

    try {
        const response = await fetch(`${window.API_URL}/feed/update-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            if (response.status === 409 && imageSource === 'google_photos') {
                console.warn("[updateImages] 409: La pool di Google Photos è vuota.");
                showToast('Seleziona prima le foto da Google Photos.', 'error');
                openPhotoSheet();
                return { ok: false, reason: 'pool_empty' };
            }
            throw new Error(`Errore aggiornamento immagini: ${response.status}`);
        }

        const data = await response.json();
        console.log("[updateImages] Dati ricevuti:", data);

        (data.updated_items || []).forEach(item => {
            const card = document.querySelector(`.feed-card[data-email-id="${item.email_id}"]`);
            if (!card) return;
            const img = card.querySelector('.card-image');
            if (!img) return;

            img.classList.add('updating-image');

            const internal = isInternalImageUrl(item.image_url);
            const newSrc = internal
              ? item.image_url
              : buildImageProxyUrl(item.image_url, item.email_id);
            if (item.email_id) {
              img.dataset.emailId = String(item.email_id);
            }

            if (item.accent_hex) {
              card.style.setProperty('--accent', item.accent_hex);
            }
            
            if (internal && /w=\d+/.test(newSrc)) {
                img.setAttribute('srcset', mkSrcSet(newSrc));
            } else {
                img.removeAttribute('srcset');
            }

            const done = () => {
              img.classList.remove('updating-image');
              try { applyColorsFromImage(card, img); } catch (e) {}
            };

            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', () => {
              img.classList.remove('updating-image');
              img.removeAttribute('srcset');
              img.src = '/img/loading.gif';
            }, { once: true });

            setCardImage(img, newSrc, internal);
            if (img.complete && img.naturalWidth > 0) done();
        });

        console.info("[updateImages] Aggiornamento immagini completato.");
        return { ok: true, updated: (data.updated_items || []).length };

    } catch (error) {
        console.error("--- [updateImages] ERRORE CRITICO ---", error);
        cards.forEach(card => card.querySelector('.card-image')?.classList.remove('updating-image'));
        return { ok: false, error: String(error) };
    }
};

window.updateImages = updateImages;

const mask = (s) => (typeof s === 'string' && s.length > 8) ? s.slice(0,4) + '...' + s.slice(-4) : s;

// Test popup blocker
function testPopupAllowed() {
  const w = window.open('', '', 'width=300,height=200');
  if (!w) {
    console.warn('[Diag] Popup BLOCCATI dal browser.');
    return false;
  }
  w.document.write('<p>Popup test OK. Puoi chiudermi.</p>');
  try { w.close(); } catch (e) {}
  console.log('[Diag] Popup consentiti.');
  return true;
}

// Prova a caricare l’iframe del picker “grezzo” per vedere se arriva un 403
function testDocsPickerReachable() {
  return new Promise((resolve) => {
    const u = new URL('https://docs.google.com/picker');
    // parametri minimi “harmless”: senza token non funziona, ma ci basta vedere onload/error
    u.searchParams.set('protocol','gadgets');
    u.searchParams.set('origin', window.location.origin);
    const ifr = document.createElement('iframe');
    ifr.style.display = 'none';
    ifr.src = u.toString();
    ifr.onload = () => {
      console.log('[Diag] iframe docs.google.com/picker onload → raggiungibile (non garantisce che funzioni col token, ma non è bloccato a monte).');
      ifr.remove(); resolve(true);
    };
    ifr.onerror = () => {
      console.warn('[Diag] iframe docs.google.com/picker onerror → probabile blocco (403 / network / estensioni).');
      ifr.remove(); resolve(false);
    };
    document.body.appendChild(ifr);
    // safety timeout
    setTimeout(() => { try { ifr.remove(); } catch (e) {} ; resolve(false); }, 5000);
  });
}

// Ascolta eventuali errori inviati dal picker via postMessage
function attachPickerPostMessageProbe() {
  const handler = (ev) => {
    const o = new URL(ev.origin);
    if (o.hostname.endsWith('google.com')) {
      console.log('[Diag] postMessage da', ev.origin, 'data:', ev.data);
    }
  };
  window.addEventListener('message', handler, { once:false });
  return () => window.removeEventListener('message', handler);
}

async function importLatestFromPhotos(limit, accessToken) {
  const res = await fetch(`${window.BACKEND_BASE}/api/photos/import/latest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({ limit, mode: "replace" })
  });
  const out = await res.json();
  console.log("[BulkImport] Ultime foto importate:", out);
  return out;
}

async function importAlbumById(albumId, accessToken) {
  const res = await fetch(`${window.BACKEND_BASE}/api/photos/import/album`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({ albumId, mode: "replace" })
  });
  const out = await res.json();
  console.log("[BulkImport] Album importato:", out);
  return out;
}

async function importFromAlbumFlow(accessToken) {
  try {
    // 1. Chiedi al backend la lista degli album
    console.log("[AlbumImport] Caricamento lista album...");
    const albumsRes = await fetch(`${window.BACKEND_BASE}/api/photos/albums`, {
   headers: { 'Authorization': `Bearer ${accessToken}` },
   credentials: 'include'
 });
    if (!albumsRes.ok) throw new Error('Errore nel caricare gli album');
    const albumsData = await albumsRes.json();
    const albums = albumsData.albums || [];

    if (albums.length === 0) {
      alert("Nessun album trovato nel tuo Google Photos.");
      return;
    }

    // 2. Mostra all'utente una lista e chiedi di scegliere
    const albumListText = albums
      .map((album, index) => `${index + 1}: ${album.title} (${album.mediaItemsCount} foto)`)
      .join('\n');
    
    const choice = prompt(`Scegli un album inserendo il numero:\n\n${albumListText}`);
    if (choice === null) return; // L'utente ha annullato

    const choiceIndex = parseInt(choice, 10) - 1;
    if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= albums.length) {
      alert("Scelta non valida.");
      return;
    }

    // 3. Prendi l'ID dell'album scelto e avvia l'importazione
    const selectedAlbum = albums[choiceIndex];
    alert(`OK, avvio l'importazione dall'album "${selectedAlbum.title}"...`);
    
    await importAlbumById(selectedAlbum.id, accessToken);
    
    alert("Importazione completata! Ora aggiorno le immagini nel feed.");

  } catch (e) {
    console.error("[AlbumImport] Errore:", e);
    alert("Si è verificato un errore durante l'importazione dall'album.");
  }
}

async function retryUpdateImages() {
  console.log("[BulkImport] Richiamo updateImages() dopo importazione bulk (forzo Google Photos).");
  const cards = document.querySelectorAll('.feed-card');
  if (cards.length === 0) return;

  const emailIds = Array.from(cards).map(card => card.dataset.emailId);

  const response = await fetch(`${window.API_URL}/feed/update-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email_ids: emailIds, image_source: 'google_photos' })
  });

  if (!response.ok) {
    console.error("[BulkImport] Errore nel retryUpdateImages:", response.status);
    return;
  }
  const data = await response.json();
  console.log("[BulkImport] Immagini aggiornate:", data);

  data.updated_items.forEach(item => {
  const card = document.querySelector(`.feed-card[data-email-id="${item.email_id}"]`);
  if (!card) return;
  const img = card.querySelector('.card-image');
  if (!img) return;

  const internal = isInternalImageUrl(item.image_url);
  const newSrc = internal ? item.image_url : buildImageProxyUrl(item.image_url, item.email_id);
  if (item.email_id) {
    img.dataset.emailId = String(item.email_id);
  }
  setCardImage(img, newSrc, internal);

  img.onload = () => {
    img.classList.remove('updating-image');
    try { applyColorsFromImage(img.closest('.feed-card'), img); } catch(e) {}
  };
if (document.body.classList.contains('debug-img')) {
    const dbgQ = card.querySelector('.img-query-debug');
    if (dbgQ) {
      const q = item.image_query || getImageQuery(item);
      dbgQ.textContent = q ? `🔎 ${q}` : '';
    }
  }
});
}

const openProfileSheet = () => {
  profileSheet?.classList.remove('hidden');
  requestAnimationFrame(() => {
    profileSheet.querySelector('.panel')?.classList.remove('translate-y-full');
  });
};

const closeProfileSheet = () => {
  profileSheet?.querySelector('.panel')?.classList.add('translate-y-full');
  setTimeout(() => profileSheet?.classList.add('hidden'), 220);
};

function openHiddenSheet() {
  if (!hiddenSheet || !hiddenSheetBackdrop) return;
  renderHiddenLists();
  hiddenSheet.classList.remove('hidden');
  hiddenSheetBackdrop.classList.remove('hidden');   // <--- QUESTA RIGA ERA MANCANTE
  document.body.classList.add('body-lock');
  requestAnimationFrame(() => {
    hiddenSheetBackdrop.style.opacity = '1';
    hiddenSheet.querySelector('.panel').style.transform = 'translateY(0)';
  });
}

function closeHiddenSheet() {
  if (!hiddenSheet || !hiddenSheetBackdrop) return;
  hiddenSheetBackdrop.style.opacity = '0';
  hiddenSheet.querySelector('.panel').style.transform = 'translateY(100%)';
  setTimeout(() => {
    hiddenSheet.classList.add('hidden');
    hiddenSheetBackdrop.classList.add('hidden');
    document.body.classList.remove('body-lock');
  }, 220);
}

async function renderHiddenLists() {
  // 1. Renderizza i domini nascosti (dal backend)
  if (hiddenDomainsList) {
    hiddenDomainsList.innerHTML = '';
    const domains = Array.from(userHiddenDomains || []).sort();
    if (domains.length === 0) {
      hiddenDomainsList.innerHTML = '<li class="px-4 py-3 text-sm text-gray-500">Nessun dominio nascosto.</li>';
    } else {
      domains.forEach(d => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between px-4 py-3';
        li.innerHTML = `
          <span class="text-sm font-medium text-gray-800 truncate">${d}</span>
          <button class="text-sm font-semibold text-blue-600 hover:underline js-unhide-domain" data-domain="${d}">Mostra</button>
        `;
        hiddenDomainsList.appendChild(li);
      });
    }
  }

  // 2. Renderizza i thread nascosti (leggibile)
  if (hiddenThreadsList) {
    hiddenThreadsList.innerHTML = '';
    const ids = Array.from(hiddenEmailIds || []);
  
    if (ids.length === 0) {
      hiddenThreadsList.innerHTML =
        '<li class="px-4 py-3 text-sm text-gray-500">Nessun thread nascosto.</li>';
    } else {
      for (const id of ids) {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between px-4 py-3';
        li.innerHTML = `
          <div class="min-w-0 flex items-center gap-3">
            <img data-thread-logo class="h-5 w-5 rounded-full bg-gray-100 flex-shrink-0" alt="">
            <div class="min-w-0">
              <div data-thread-title class="text-sm font-medium text-gray-900 truncate">Carico…</div>
              <div data-thread-meta  class="text-xs text-gray-500 truncate">ID: ${esc(id)}</div>
            </div>
          </div>
          <button class="text-sm font-semibold text-blue-600 hover:underline js-unhide-thread" data-id="${escAttr(id)}">
            Mostra
          </button>
        `;
        hiddenThreadsList.appendChild(li);
  
        const titleEl = li.querySelector('[data-thread-title]');
        const metaEl  = li.querySelector('[data-thread-meta]');
        const logoEl  = li.querySelector('[data-thread-logo]');
  
        const hydrate = (item) => {
          if (!item) {
            titleEl.textContent = 'Conversazione nascosta';
            metaEl.textContent  = `ID: ${id}`;
            logoEl.removeAttribute('src');
            return;
          }
          const title = item.ai_title || item.original_subject || '(senza oggetto)';
          const who   = item.sender_name || item.sender_email || 'mittente sconosciuto';
          const when  = formatDate(item.received_date) || '';
          titleEl.textContent = title;
          metaEl.textContent  = when ? `${who} • ${when}` : who;
  
          const dom = (item.source_domain || (item.sender_email||'').split('@')[1] || '').toLowerCase();
          if (dom) {
            logoEl.src = `https://icons.duckduckgo.com/ip3/${dom}.ico`;
            logoEl.alt = dom;
          }
        };
  
        // 1) Prova a recuperare i dati dalla memoria cache dell'app
        let item = itemsById.get(String(id)) || getItemById(id);
        if (item) {
          hydrate(item);
        } else {
          // 2) Se non è in memoria, fai una richiesta al backend per i dettagli
          fetch(`${window.API_URL}/feed/item/${id}`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : null)
            .then(hydrate)
            .catch(() => hydrate(null)); // In caso di errore, mostra un fallback
        }
      }
    }
  }
}

// --- LOGICA DI AVVIO PAGINA ---
console.log("AVVIO: Verifico sessione utente...");

async function mainAppStart() {
  if (window.__APP_BOOTED) return;   // ⬅️ guardia anti-doppio avvio
  window.__APP_BOOTED = true;

  try {
  const savedTypes = JSON.parse(localStorage.getItem(`activeTypes:${EVER_KEY}`) || 'null');
  if (Array.isArray(savedTypes) && savedTypes.length > 0) {
    activeTypes = new Set(savedTypes);
  }
} catch (e) {}

  if (__app_started) {
    console.warn("[JS-DEBUG] mainAppStart: Avvio già in corso o completato. Chiamata ignorata.");
    return;
  }
  __app_started = true;
  console.log("[JS-DEBUG] mainAppStart: Inizio avvio dell'applicazione.");

  feedContainer = document.getElementById('feed-container');
  loginMessage  = document.getElementById('login-message');

  console.log('[JS-DEBUG] mainAppStart: attendo bootReady...');
  while (!__bootReady) {
    await new Promise(r => setTimeout(r, 50));
  }
  console.log('[JS-DEBUG] mainAppStart: bootReady OK.');
  
  const stopBoot = () => document.body.classList.remove('booting');

  try {
    const url = new URL(window.location.href);
    const didAuth = url.searchParams.get('authenticated') === 'true';

    async function checkAuthOnce() {
      console.log('[JS-DEBUG] checkAuthOnce: chiamata /api/auth/me');
      const r = await fetch(`${window.BACKEND_BASE}/api/auth/me`, {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!r.ok) return null;
      return r.json();
    }

    // Rimuovi subito il marker dall'URL per evitare confusione visiva
    if (didAuth) {
      try {
        url.searchParams.delete('authenticated');
        history.replaceState({}, '', url.toString());
      } catch {}
    }

    // Se torniamo dal login, attendi in modo più robusto la sessione
    let me = await checkAuthOnce();
    if (!me && didAuth) {
      // Ottimismo UI: mostra skeleton e header mentre aspettiamo i cookie
      try {
        document.getElementById('login-message')?.classList.add('hero-hidden');
        document.getElementById('login-message')?.setAttribute('style','display:none');
        document.getElementById('app-header')?.classList.remove('hidden');
        document.getElementById('app-footer')?.classList.remove('hidden');
        document.getElementById('ptr')?.classList.remove('hidden');
        showSplash();
        showInitialSkeletons();
      } catch {}

      const MAX_ATTEMPTS = 40; // ~10s con 250ms
      for (let i = 0; i < MAX_ATTEMPTS && !me; i++) {
        await new Promise(r => setTimeout(r, 250));
        me = await checkAuthOnce();
      }
    }

    const isLogged = !!(me && (me.email || me.user_id));
    console.log(`[JS-DEBUG] mainAppStart: Controllo autenticazione. Utente loggato: ${isLogged}`);

    EVER_KEY = EVER_KEY_PREFIX + (me?.email || 'anonymous');
    const FEED_STATE_VERSION = '2'; // Incrementa questo numero se fai modifiche future allo stato
    try {
      const savedVersion = localStorage.getItem('feedStateVersion');
      if (savedVersion !== FEED_STATE_VERSION) {
        console.warn(`[RESET] Versione stato feed obsoleta (salvata: ${savedVersion}, richiesta: ${FEED_STATE_VERSION}). Eseguo pulizia.`);
        // Rimuovi le chiavi che potrebbero contenere un cursore non valido o dati vecchi.
        // Adatta queste chiavi se ne usi altre.
        localStorage.removeItem(`activeTypes:${EVER_KEY}`);
        localStorage.removeItem(readFilterKey());
        // La cosa più importante è che il vecchio cursore non venga letto.
        // Poiché __cursor è in memoria, un refresh della pagina lo azzera.
        // Forzare un reset=true al primo caricamento è garantito dalla logica sottostante.
        localStorage.setItem('feedStateVersion', FEED_STATE_VERSION);
      }
    } catch (e) {
      console.error('[RESET] Errore durante il controllo della versione dello stato.', e);
    }

    try{
      const saved = JSON.parse(localStorage.getItem(readFilterKey()) || '["read","unread"]');
      const s = new Set(saved.filter(v => READ_STATES.includes(v)));
      activeReads = s.size ? s : new Set(READ_STATES);
    }catch{}
    __readSet = loadReadSet();
    FEED_STATE.everLoaded = getEverLoaded();

    if (isLogged) {
      if (loginMessage) {
        // Nascondi in modo robusto l'hero di login per evitare overlay
        loginMessage.style.display = 'none';
        loginMessage.classList.add('hero-hidden');
        try { loginMessage.classList.add('hidden'); } catch {}
      }
      showSplash();
      document.getElementById('app-header')?.classList.remove('hidden');
      document.getElementById('app-footer')?.classList.remove('hidden');
      document.getElementById('ptr')?.classList.remove('hidden');
      await loadUserSettings();
      await finalizePendingGPhotosSession();
      stopBoot();
      showInitialSkeletons();
      
      await fetchFeed({ reset: true });

      setTimeout(() => {
        // Guardia: non eseguire in background o offline.
        if (document.visibilityState !== 'visible' || !navigator.onLine) {
          console.log("[on-enter] Sync saltata (pagina non visibile o offline).");
          return;
        }

        // Guardia: rispetta un cooldown tra sessioni diverse (5 min).
        const SYNC_COOLDOWN = 5 * 60 * 1000;
        const lastSync = parseInt(localStorage.getItem('lastSyncAt') || '0', 10);
        if (Date.now() - lastSync < SYNC_COOLDOWN) {
          console.log("[on-enter] Sync saltata (cooldown tra sessioni attivo).");
          return;
        }

        // Guardia: non eseguire se un'altra operazione è già in corso.
        if (window.__isIngesting || window.__autoIngesting) {
          console.log("[on-enter] Sync saltata (ingestione già in corso).");
          return;
        }

        console.log("[on-enter] Avvio controllo leggero all'atterraggio.");
        localStorage.setItem('lastSyncAt', String(Date.now()));
        window.__lastIngestAt = Date.now();
        
        // Payload "leggero" per scaricare solo le novità recenti.
        autoIngestAndLoad({ reason: 'on-enter', batch: 10, pages: 1, target: 30 });

      }, 250);

      // Parametro già ripulito sopra se presente

    } else {
      hideSplash(true);
      document.getElementById('app-header')?.classList.add('hidden');
      document.getElementById('app-footer')?.classList.add('hidden');
      document.getElementById('ptr')?.classList.add('hidden');
      if (loginMessage) {
        loginMessage.style.display = 'block';
        loginMessage.classList.remove('hero-hidden');
      }
      stopBoot();
      return;
    }

  } catch (e) {
    console.error("[JS-DEBUG] mainAppStart: Errore critico durante l'avvio:", e);
    hideSplash(true);
    document.getElementById('app-header')?.classList.add('hidden');
    document.getElementById('app-footer')?.classList.add('hidden');
    document.getElementById('ptr')?.classList.add('hidden');
    if (loginMessage) {
      loginMessage.style.display = 'block';
      loginMessage.classList.remove('hero-hidden');
    }
    stopBoot();
  }  finally {
    removeGlobalLoading();

    console.log("[JS] Avvio completato. Abilito lo scroll automatico.");
    __initialLoadDone = true;
    document.body.classList.remove("body-lock");
    document.documentElement.classList.remove("body-lock");
    document.body.style.overflow = "";
    
    try {
      // Assicurati che il sentinel sia visibile prima di avviare l'observer
      const sentinelEl = document.getElementById('load-more-sentinel');
      if (sentinelEl) sentinelEl.classList.remove('hidden');
      
      window.setupInfiniteScroll?.();
    } catch (e) {
      console.error("Errore nell'avvio dell'infinite scroll:", e);
    }
  }
}


// Esegui mainAppStart() non appena possibile, in modo sicuro.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mainAppStart, { once: true });
} else {
  mainAppStart();
}

(function headerDebug(){
  const HDR = document.getElementById('app-header') || document.getElementById('main-header');
  if (!HDR) {
    console.warn('[HDR] Elemento header non trovato.');
    return;
  }

  // Imposta il debug a 'false' di default.
  window.__DEBUG_HEADER = window.__DEBUG_HEADER ?? false;

  const THRESHOLD = 50, HYST = 20;
  let lastY = window.scrollY;
  let compact = HDR.classList.contains('compact');

  // --- Logica di Debug (eseguita solo se __DEBUG_HEADER è true) ---
  let dbg, log;
  if (window.__DEBUG_HEADER) {
    dbg = document.createElement('div');
    dbg.id = 'hdr-debug';
    dbg.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;background:#111a;color:#fff;padding:4px 6px;border-radius:6px;font:12px ui-monospace,monospace;pointer-events:none';
    document.body.appendChild(dbg);
    log = (...a) => console.log('[HDR]', ...a);
  } else {
    // Se il debug è disattivato, crea funzioni vuote per non causare errori.
    dbg = { textContent: '' };
    log = () => {};
  }

  // --- Logica Principale (eseguita sempre) ---
  function apply(state, reason) {
    HDR.classList.toggle('compact', !!state);
    compact = !!state;
    
    // Aggiorna il badge di debug solo se esiste
    const h = HDR.getBoundingClientRect().height | 0;
    dbg.textContent = `y:${window.scrollY} compact:${compact} h:${h} ${reason||''}`;
    log(`→ compact=${compact}`, { y: window.scrollY, h, reason, cls: [...HDR.classList].join(' ') });
  }

  function onScroll() {
    const y = window.scrollY;
    const goingDown = y > lastY;
    if (goingDown && y > THRESHOLD && !compact) {
      apply(true, 'down>thr');
    } else if (!goingDown && y < (THRESHOLD - HYST) && compact) {
      apply(false, 'up<hyst');
    }
    lastY = y;
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => apply(compact, 'resize'));
  
  log('init', {
    headerId: HDR.id,
    position: getComputedStyle(HDR).position,
    classList: [...HDR.classList]
  });
  
  // Applica lo stato iniziale al caricamento della pagina
  apply(compact, 'boot');
})();

(function setupTopRefresh(){
  let lastY = window.scrollY;
  let lastTrigger = 0;
  const TOP_PX = 80;
  const COOLDOWN_MS = 8000; // Cooldown di 8 secondi

  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const goingUp = y < lastY;
    const canTrigger =
      goingUp && y <= TOP_PX &&
      !window.__isIngesting && !window.__autoIngesting &&
      (Date.now() - lastTrigger > COOLDOWN_MS);

    if (canTrigger) {
      lastTrigger = Date.now();
      window.__lastIngestAt = Date.now();

      const token = ptrShowLoading('scroll-up', 'Sto sincronizzando nuove newsletter…');
      try { window.setSentinelBusy?.('Controllo la casella di posta…'); } catch {}
      autoIngestAndLoad({
        reason: 'scroll-up',
        batch: 10,
        pages: 1,
        target: 30,
        ptrToken: token,
        ptrText: 'Sto sincronizzando nuove newsletter…'
      });
    }
    lastY = y;
  }, { passive: true });
})();

// 2. PULL-TO-REFRESH MANUALE E VISIBILE
// Si attiva quando l'utente "tira" la pagina dall'alto.
(function pullToRefresh() {
  const ptr = document.getElementById('ptr');
  if (!ptr) return;

  const TH = 70;
  let startY = null, pulling = false, ready = false;
  let wheelPull = 0, wheelActive = false, wheelReady = false, wheelTimer = null;

  const triggerRefresh = (reason) => {
    dlog('[PTR] refresh_trigger');
    const token = ptrShowLoading(`ptr-${reason}-${Date.now()}`, 'Sto sincronizzando nuove newsletter…');
    __lastIngestAt = Date.now();
    try { window.setSentinelBusy?.('Controllo la casella di posta…'); } catch {}
    autoIngestAndLoad({
      reason,
      force: true,
      batch: 10,
      pages: 1,
      target: 30,
      ptrToken: token,
      ptrText: 'Sto sincronizzando nuove newsletter…'
    });
  };

  const onStart = (e) => {
    if (window.scrollY > 0) { dlog('ptr_blocked', { reason: 'not_top' }); return; }
    
    if (window.__isIngesting || window.__autoIngesting) {
      const waitToken = ptrShowLoading(`ptr-wait-${Date.now()}`, 'Aggiornamento in corso…');
      ptrWaitUntilIdle(waitToken);
      dlog('ptr_blocked', { reason: window.__isIngesting ? 'isIngesting' : 'autoIngesting' });
      return;
    }

    if (wheelActive) return;
    
    dlog('[PTR] pull_start');
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    pulling = true;
    ready = false;
    ptrSetHint('Trascina per aggiornare');
  };

  const onMove = (e) => {
    if (!pulling || !startY) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = Math.max(0, y - startY);
    if (window.scrollY > 0) { onEnd(); return; }
    if (dy > 5) e.preventDefault();
    ptr.style.setProperty('--ptr-pull', Math.min(dy, 100) + 'px');
    ptr.classList.add('ptr--pull');
    ready = dy > TH;
    if (ready) dlog('[PTR] release_to_refresh');
    ptr.classList.toggle('ptr--ready', ready);
    ptrSetHint(ready ? 'Rilascia per aggiornare' : 'Trascina per aggiornare');
  };

  const onEnd = () => {
    if (!pulling) return;
    const wasReady = ready;
    pulling = false; ready = false; startY = null;
    ptr.classList.remove('ptr--pull', 'ptr--ready');
    ptr.style.removeProperty('--ptr-pull');
    ptrSetHint(PTR_DEFAULT_TEXT);
    if (wasReady) triggerRefresh('ptr-drag');
  };

  const onWheel = (e) => {
    if (window.scrollY > 0 || pulling) return;
    if (window.__isIngesting || window.__autoIngesting) {
      const waitToken = ptrShowLoading(`ptr-wheel-wait-${Date.now()}`, 'Aggiornamento in corso…');
      ptrWaitUntilIdle(waitToken);
      return;
    }
    if (e.deltaY < 0) {
      if (!wheelActive) dlog('[PTR] pull_start (wheel)');
      wheelActive = true;
      wheelPull = Math.min(100, wheelPull - e.deltaY);
      ptr.style.setProperty('--ptr-pull', wheelPull + 'px');
      ptr.classList.add('ptr--pull');
      wheelReady = wheelPull > TH;
      if (wheelReady) dlog('[PTR] release_to_refresh (wheel)');
      ptr.classList.toggle('ptr--ready', wheelReady);
      ptrSetHint(wheelReady ? 'Rilascia per aggiornare' : 'Trascina per aggiornare');
      e.preventDefault();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(onWheelEnd, 150);
    }
  };

  const onWheelEnd = () => {
    if (!wheelActive) return;
    const wasReady = wheelReady;
    wheelActive = false; wheelReady = false; wheelPull = 0;
    ptr.classList.remove('ptr--pull', 'ptr--ready');
    ptr.style.removeProperty('--ptr-pull');
    ptrSetHint(PTR_DEFAULT_TEXT);
    if (wasReady) triggerRefresh('ptr-wheel');
  };

  window.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onEnd, { passive: true });
  window.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('wheel', onWheel, { passive: false });

  window.addEventListener('scroll', () => {
    if (window.scrollY > 0) {
      if (pulling) onEnd();
      if (wheelActive) onWheelEnd();
    }
  }, { passive: true });
})();

(function focusRefresh(){
  const COOLDOWN = 5 * 60 * 1000; // 5 minuti
  let last = 0;
  
  const trySync = (reason) => {
    // Esegui solo se la scheda è visibile e c'è connessione
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    
    // Non fare nulla se una sincronizzazione è già in corso
    if (window.__isIngesting || window.__autoIngesting) return;
    
    const now = Date.now();
    // Rispetta il cooldown per evitare chiamate troppo frequenti
    if (now - last < COOLDOWN) return;
    
    console.log(`[FocusRefresh] Avvio sync soft (reason: ${reason})`);
    last = now;
    window.__lastIngestAt = now;
    
    // Usa lo stesso payload "leggero"
    autoIngestAndLoad({ reason, batch: 10, pages: 1, target: 30 });
  };

  // Ascolta sia il focus della finestra che il cambio di visibilità della scheda
  window.addEventListener('focus', () => trySync('focus'));
  document.addEventListener('visibilitychange', () => trySync('visibility'));
})();
