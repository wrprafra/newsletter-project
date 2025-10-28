// frontend/feed-view.js

// --- STATO INTERNO DEL MODULO VIEW ---
let __container = null;
let __sentinel = null;
let __readObserver = null;
let __scrollObserver = null;
const __cardNodes = new Map();
const readTimers = new WeakMap();
import { stopIngestSSE, toProxy, abortFeed } from './feed-api.js';

// --- FUNZIONI ESPORTATE ---

/**
 * Inizializza il modulo View, agganciandosi al contenitore del feed.
 * @param {HTMLElement} containerEl - L'elemento del DOM che conterrà il feed.
 */
export function mount(containerEl) {
  if (__container === containerEl) return; // Già montato su questo elemento
  if (__container) unmount(); // Pulisce il montaggio precedente

  if (!containerEl) throw new Error("Elemento contenitore non valido.");
  __container = containerEl;

  __sentinel = document.createElement('div');
  __sentinel.id = 'load-more-sentinel';
  __sentinel.setAttribute('role', 'button');
  __sentinel.setAttribute('aria-live', 'polite');
  __sentinel.tabIndex = 0;
  __sentinel.setAttribute('aria-label', 'Carica altri');
  __sentinel.className = 'py-6 text-center text-sm text-gray-500 hidden';
  __container.insertAdjacentElement('afterend', __sentinel);
}


/**
 * Renderizza una lista di item nel feed, creando nuove card o aggiornando quelle esistenti.
 * @param {Array<object>} items - La lista di item da visualizzare.
 */
export function render(items) {
  if (!__container) return;

  const fragment = document.createDocumentFragment();
  const visibleIds = new Set();

  for (const item of items) {
    const id = String(item.email_id);
    visibleIds.add(id);
    let cardNode = __cardNodes.get(id);

    if (cardNode) {
      updateFeedCard(cardNode, item);
    } else {
      cardNode = renderFeedCard(item);
      __cardNodes.set(id, cardNode);
    }

    fragment.appendChild(cardNode);
  }

  if (fragment.childElementCount > 0) {
    __container.appendChild(fragment);
  }

  for (const [id, node] of __cardNodes.entries()) {
    node.classList.toggle('hidden', !visibleIds.has(id));
  }
}

/**
 * Osserva un elemento per triggerare un callback quando diventa visibile (scroll infinito).
 * @param {function(): void} onBottom - Il callback da eseguire.
 */
export function observeInfinite(onBottom) {
  if (__scrollObserver) __scrollObserver.disconnect();

  __scrollObserver = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) {
      onBottom();
    }
  }, { rootMargin: '1200px 0px' });

  if (__sentinel) {
    __scrollObserver.observe(__sentinel);
  }
}

/**
 * Osserva una card per segnarla come letta quando è visibile per un certo tempo.
 * @param {HTMLElement} cardEl - La card da osservare.
 * @param {function(string): void} onRead - Callback con l'ID dell'item letto.
 */
export function observeRead(cardEl, onRead) {
  if (!__readObserver) {
    __readObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.emailId;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          if (!readTimers.has(entry.target)) {
            const timer = setTimeout(() => {
              onRead(id);
              __readObserver.unobserve(entry.target);
              readTimers.delete(entry.target);
            }, 2000);
            readTimers.set(entry.target, timer);
          }
        } else {
          const timer = readTimers.get(entry.target);
          if (timer) {
            clearTimeout(timer);
            readTimers.delete(entry.target);
          }
        }
      }
    }, { threshold: [0.6] });
  }
  __readObserver.observe(cardEl);
}

/**
 * Gestisce il caricamento e la visualizzazione di un'immagine in una card.
 * @param {HTMLImageElement} imgEl - L'elemento <img>.
 * @param {string} src - L'URL dell'immagine.
 * @param {object} options - Opzioni aggiuntive.
 * @param {string} options.accentHex - Colore esadecimale per lo sfondo.
 */
export function attachImage(imgEl, src, { accentHex, emailId } = {}) {
  if (!imgEl || !src) return;

  imgEl.crossOrigin = 'anonymous'; // Aggiunto per evitare canvas "tainted"

  const card = imgEl.closest('.feed-card');
  const imageWrapper = imgEl.parentElement;

  const bgColor = accentHex || '#374151';
  if (imageWrapper) imageWrapper.style.backgroundColor = bgColor;
  if (card) card.style.setProperty('--accent', bgColor);

  imgEl.loading = 'lazy';
  imgEl.decoding = 'async';
  imgEl.width = 800;
  imgEl.height = 450;
  if (emailId) {
    imgEl.dataset.emailId = String(emailId);
  }

  const finalSrc = toProxy(src, emailId);

  imgEl.onload = () => {
    imgEl.classList.add('is-loaded');
    if (!accentHex && card) {
        try {
            const avgColor = getAverageColorFromImage(imgEl);
            if (avgColor) {
                const darkR = Math.round(avgColor.r * 0.7);
                const darkG = Math.round(avgColor.g * 0.7);
                const darkB = Math.round(avgColor.b * 0.7);
                card.style.setProperty('--accent', `rgb(${darkR}, ${darkG}, ${darkB})`);
            }
        } catch {}
    }
  };

  imgEl.onerror = () => {
    imgEl.removeAttribute('srcset');
    imgEl.src = '/img/loading.gif';
    imgEl.classList.add('is-loaded');
  };

  imgEl.src = finalSrc;
}

// --- FUNZIONI DI UTILITÀ UI ---

export function showSentinel(text = 'Carico altri...') {
    if (!__sentinel) return;
    __sentinel.classList.remove('hidden');
    __sentinel.textContent = text;
}

export function hideSentinel() {
    if (!__sentinel) return;
    __sentinel.classList.add('hidden');
}

export function showToast(text, kind = 'ok') {
    const t = document.getElementById('toast'); if (!t) return;
    t.className = ''; t.classList.add(kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : '');
    t.textContent = String(text || '');
    t.classList.add('show');
    setTimeout(()=> t.classList.remove('show'), 2600);
}

// --- FUNZIONI DI RENDERING INTERNE ---
function proxyIfNeeded(u) {
  if (!u) return '';
  if (u.startsWith('data:') || !u.startsWith('http')) return u;
  return `${window.BACKEND_BASE}/api/img?u=${encodeURIComponent(u)}`;
}

function renderFeedCard(item) {
  const cardEl = document.createElement('article');
  cardEl.className = 'feed-card opacity-0';
  cardEl.dataset.emailId = item.email_id;
  cardEl.classList.toggle('is-read', item.isRead);

  const title = item.ai_title || item.original_subject || '';
  const safeTitle = esc(title);
  const safeSenderName = esc(item.sender_name || item.sender_email);
  const domainPart = (item.sender_email?.split('@')[1] || '').trim();
  const safeDomain = domainPart.replace(/[^a-z0-9.-]/gi, '');
  const logoHtml = safeDomain ? `<img class="avatar-dot" src="https://icons.duckduckgo.com/ip3/${safeDomain}.ico" alt="" loading="lazy">` : '';
  const bgColor = item.accent_hex || '#374151';
  const bgGradient = `linear-gradient(135deg, var(--accent, ${bgColor}) 0%, #111827 100%)`;

  cardEl.innerHTML = `
    <div class="image-wrapper w-full">
      <img alt="Copertina per ${safeTitle}" class="card-image w-full h-full object-cover">
    </div>
    <div class="tile-dark p-4 md:p-5 tile-attach" style="background:${bgGradient};">
      <div class="flex items-center gap-2 text-xs mb-3">
        ${logoHtml}
        <span class="badge">${safeSenderName}</span>
      </div>
      <h2 class="reading-title text-2xl font-bold leading-tight mb-1">${safeTitle}</h2>
      <div class="reading-copy text-[15px] text-white/90 mt-2">${mdToHtmlSafe(item.ai_summary_markdown) || ''}</div>
      <div class="tile-actions">
        <div class="action-left">
            <button type="button" class="icon-btn" data-action="fav" aria-pressed="${!!item.is_favorite}" aria-label="Preferiti">
              <span class="material-symbols-outlined ${!!item.is_favorite ? 'ms-filled' : ''}">favorite</span>
            </button>
            <button type="button" class="icon-btn" data-action="share" aria-label="Condividi">
              <span class="material-symbols-outlined">ios_share</span>
            </button>
        </div>
        <button type="button" class="icon-btn" data-action="open" data-url="${escAttr(getGmailUrl(item))}" aria-label="Apri in Gmail">
            <span class="material-symbols-outlined">open_in_new</span>
        </button>
      </div>
    </div>
  `;

  const imgEl = cardEl.querySelector('img.card-image');
  attachImage(imgEl, item.image_url, { accentHex: item.accent_hex, emailId: item.email_id });
  
  setTimeout(() => cardEl.classList.remove('opacity-0'), 50);

  return cardEl;
}

function updateFeedCard(cardEl, item) {
    cardEl.classList.toggle('is-read', item.isRead);
    const favBtn = cardEl.querySelector('[data-action="fav"]');
    if (favBtn) {
        const isFav = !!item.is_favorite;
        favBtn.setAttribute('aria-pressed', String(isFav));
        favBtn.querySelector('.material-symbols-outlined').classList.toggle('ms-filled', isFav);
    }
}

export function unmount() {
  if (__readObserver) { __readObserver.disconnect(); __readObserver = null; }
  if (__scrollObserver) { __scrollObserver.disconnect(); __scrollObserver = null; }
  stopIngestSSE?.(); // Chiude la connessione SSE
  __cardNodes.clear();
  __container = null;
  __sentinel = null;
}

// --- FUNZIONI HELPER INTERNE ---

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function escAttr(s = '') {
  return esc(s);
}

function mdToHtmlSafe(md) {
  if (!md) return '';
  return esc(md)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p class="md-p">${p}</p>`)
    .join('');
}

function getGmailUrl(item) {
    if (typeof window.getGmailUrl === 'function') {
        return window.getGmailUrl(item);
    }
    const base = (frag) => `https://mail.google.com/mail/u/0/#all/${frag}`;
    const threadId = item?.thread_id || item?.gmail_thread_id;
    if (threadId) return base(threadId);
    const msgId = item?.email_id || item?.gmail_message_id;
    if (msgId) return base(msgId);
    return 'https://mail.google.com/mail/u/0/#inbox';
}

function getAverageColorFromImage(img) {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = 16;
    canvas.height = 16;
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    const count = data.length / 4;
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
  } catch {
    return null;
  }
}
