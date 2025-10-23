// frontend/feed-store.js

// --- STATO UNICO DEL FEED ---
const state = {
  itemsById: new Map(),
  order: [], // Array di email_id ordinati per data
  filters: {
    topic: null,
    sender: null,
    types: new Set(['newsletter', 'promo', 'personali', 'informative']),
    read: new Set(['read', 'unread']),
    favoritesOnly: false,
  },
  read: new Set(),
  hidden: new Set(),
  userKey: 'anonymous',
};

// --- FUNZIONI ESPORTATE ---

/**
 * Inizializza lo store, caricando stati persistenti da localStorage.
 * @param {string} userKey - Una chiave unica per l'utente (es. email) per namespace localStorage.
 */
export function init(userKey) {
  state.userKey = userKey;
  try {
    state.read = new Set(JSON.parse(localStorage.getItem(`readThreads:${userKey}`) || '[]'));
    state.hidden = new Set(JSON.parse(localStorage.getItem('hiddenEmailIds') || '[]'));
    const savedTypes = JSON.parse(localStorage.getItem(`activeTypes:${userKey}`) || 'null');
    if (Array.isArray(savedTypes) && savedTypes.length > 0) {
        state.filters.types = new Set(savedTypes);
    }
  } catch (e) {
    console.warn("Impossibile caricare lo stato dal localStorage", e);
  }
}

/**
 * Aggiunge o aggiorna item nello store, mantenendo l'ordine cronologico.
 * @param {Array<object>} items - La lista di item da inserire.
 */
export function upsert(items) {
  let hasChanges = false;
  for (const item of items) {
    if (!item || !item.email_id) continue;
    const id = String(item.email_id);
    
    // Normalizza la data per un ordinamento affidabile
    const ts = Date.parse(item.received_date || 0) || 0;
    const normalizedItem = { ...item, _ts: ts };

    if (!state.itemsById.has(id)) {
      state.order.push(id);
      hasChanges = true;
    }
    state.itemsById.set(id, { ...(state.itemsById.get(id) || {}), ...normalizedItem });
  }

  if (hasChanges) {
    state.order.sort((a, b) => {
      const itemA = state.itemsById.get(a);
      const itemB = state.itemsById.get(b);
      return (itemB._ts || 0) - (itemA._ts || 0);
    });
  }
}

/**
 * Applica i filtri correnti e restituisce una lista ordinata di item.
 * @returns {Array<object>} La lista filtrata degli item.
 */
export function getFilteredItems() {
  const { topic, sender, types, read, favoritesOnly } = state.filters;

  return state.order
    .map(id => {
      const it = state.itemsById.get(id);
      return it ? { ...it, isRead: state.read.has(String(it.email_id)) } : null;
    })
    .filter(item => {
      if (!item) return false;
      // BUG FIX: Assicura che la chiave sia una stringa, come in hideItem
      if (state.hidden.has(String(item.email_id))) return false;
      if (favoritesOnly && !item.is_favorite) return false;
      if (topic && (item.topic_tag || '').toLowerCase() !== topic.toLowerCase()) return false;
      if (sender && (item.sender_email || '').toLowerCase() !== sender.toLowerCase()) return false;
      if (types.size < 4 && !types.has((item.type_tag || 'informative').toLowerCase())) return false;
      if (read.size < 2) {
        if (read.has('read') && !item.isRead) return false;
        if (read.has('unread') && item.isRead) return false;
      }
      return true;
    });
}


/**
 * Restituisce un singolo item tramite il suo ID.
 * @param {string} id - L'email_id dell'item.
 * @returns {object|undefined}
 */
export function getItem(id) {
  return state.itemsById.get(String(id));
}

/**
 * Restituisce tutti gli item, non filtrati.
 * @returns {Array<object>}
 */
export function getAllItems() {
    return state.order.map(id => state.itemsById.get(id));
}

/**
 * Imposta i filtri e restituisce un oggetto che indica se sono cambiati e se richiedono un reset.
 * @param {object} newFilters - Un oggetto con le nuove impostazioni di filtro.
 * @returns {{changed: boolean, requiresReset: boolean}}
 */
export function setFilters(newFilters) {
    let changed = false;
    const resetKeys = ['topic', 'sender', 'favoritesOnly'];
    let requiresReset = false;

    for (const key in newFilters) {
        if (Object.prototype.hasOwnProperty.call(state.filters, key)) {
            // La comparazione per i Set deve essere gestita diversamente
            if (state.filters[key] instanceof Set) {
                const oldSet = state.filters[key];
                const newSet = newFilters[key];
                if (oldSet.size !== newSet.size || ![...oldSet].every(value => newSet.has(value))) {
                    state.filters[key] = newSet;
                    changed = true;
                }
            } else if (state.filters[key] !== newFilters[key]) {
                state.filters[key] = newFilters[key];
                changed = true;
                if (resetKeys.includes(key)) {
                    requiresReset = true;
                }
            }
        }
    }
    
    if (changed && newFilters.types) {
        try {
            localStorage.setItem(`activeTypes:${state.userKey}`, JSON.stringify([...state.filters.types]));
        } catch {}
    }

    return { changed, requiresReset };
}

/**
 * Resetta tutti i filtri ai valori di default.
 */
export function resetFilters() {
    const changed = Boolean(state.filters.topic || state.filters.sender || state.filters.favoritesOnly);
    state.filters.topic = null;
    state.filters.sender = null;
    state.filters.favoritesOnly = false;
    return { changed, requiresReset: changed };
}

/**
 * Segna un item come letto o non letto.
 * @param {string} id - L'email_id dell'item.
 * @param {boolean} isRead - Lo stato di lettura.
 */
export function markRead(id, isRead) {
  const key = String(id);
  const changed = isRead ? !state.read.has(key) : state.read.has(key);
  if (!changed) return;

  if (isRead) {
    state.read.add(key);
  } else {
    state.read.delete(key);
  }
  try {
    localStorage.setItem(`readThreads:${state.userKey}`, JSON.stringify([...state.read]));
  } catch {}
}

/**
 * Controlla se un item è segnato come letto.
 * @param {string} id - L'email_id dell'item.
 * @returns {boolean}
 */
export function isRead(id) {
    return state.read.has(String(id));
}

/**
 * Nasconde un item.
 * @param {string} id - L'email_id dell'item.
 */
export function hideItem(id) {
    state.hidden.add(String(id));
    try {
        localStorage.setItem('hiddenEmailIds', JSON.stringify([...state.hidden]));
    } catch {}
}