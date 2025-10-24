# backend/ingestor.py
import os
import time
import json
import logging
import random
from typing import Any, cast
import redis
from redis import Redis
from redis.exceptions import ConnectionError as RedisConnectionError, RedisError
import signal
from datetime import datetime, timezone
from dotenv import load_dotenv
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleAuthRequest
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


from backend.logging_config import setup_logging
from backend.database import db, Newsletter, initialize_db

load_dotenv("/opt/newsletter/.env")
setup_logging("INGESTOR")

THREAD_DEDUP_MODE = os.getenv("THREAD_DEDUP_MODE", "skip").lower()
logging.info(f"Modalità deduplicazione thread impostata: THREAD_DEDUP_MODE={THREAD_DEDUP_MODE}")

# --- CONFIGURAZIONE ---
CREDENTIALS_PATH = "/app/data/user_credentials.json"
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
POLL_SECONDS = int(os.getenv("INGESTOR_POLL_SECONDS", "60"))
BACKFILL_PAGES = int(os.getenv("INGESTOR_BACKFILL_PAGES", "4"))
BACKFILL_TARGET = int(os.getenv("INGESTOR_BACKFILL_TARGET", "200"))
GMAIL_BATCH = int(os.getenv("INGESTOR_GMAIL_BATCH", "100"))
SEARCH_Q_BASE = os.getenv("INGESTOR_GMAIL_QUERY", "newer_than:365d")
LABEL_Q = os.getenv("INGESTOR_GMAIL_LABELS", "")

# --- STATO GLOBALE E GESTIONE SEGNALI ---
_run = True
def _stop_handler(*_):
    global _run
    if _run:
        logging.info("Ricevuto segnale di interruzione. Il ciclo terminerà a breve...")
        _run = False

signal.signal(signal.SIGTERM, _stop_handler)
signal.signal(signal.SIGINT, _stop_handler)

# --- CONNESSIONE A REDIS ---
try:
    # Usiamo cast(Redis, ...) perché le definizioni di tipo nell'ambiente
    # non supportano la sintassi generica Redis[str].
    redis_client = cast(Redis, redis.from_url(REDIS_URL, decode_responses=True))
    redis_client.ping()
    logging.info("Connesso a Redis.")
except RedisConnectionError as e:
    logging.error(f"Impossibile connettersi a Redis: {e}.")
    raise SystemExit(1)

# --- FUNZIONI HELPER ---

def _scrub(s: str) -> str:
    """Rimuove informazioni sensibili dai log."""
    return (s[:3] + "…" + s[-3:]) if s and len(s) > 10 else s

def _acquire_lock() -> bool:
    """Acquisisce un lock su Redis per prevenire istanze multiple."""
    return bool(redis_client.set("ingestor:lock", os.getpid(), nx=True, ex=120))

def _refresh_lock():
    """Aggiorna la scadenza del lock."""
    redis_client.expire("ingestor:lock", 120)

def _reload_creds() -> dict:
    """Ricarica il file delle credenziali in modo robusto, con retry."""
    for _ in range(3):
        try:
            with open(CREDENTIALS_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            logging.error(f"File credenziali '{CREDENTIALS_PATH}' non trovato.")
            return {}
        except json.JSONDecodeError:
            time.sleep(0.2)  # File potrebbe essere in fase di scrittura atomica
        except Exception as e:
            logging.error(f"Errore imprevisto durante il caricamento delle credenziali: {e}")
            break
    return {}

def _save_creds_all(creds_all: dict):
    """Salva il dizionario completo delle credenziali in modo atomico e sicuro."""
    try:
        tmp_path = CREDENTIALS_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(creds_all, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, CREDENTIALS_PATH)
        try:
            os.chmod(CREDENTIALS_PATH, 0o600)
        except (OSError, AttributeError):
            pass  # Non critico se fallisce (es. Windows)
    except Exception as e:
        logging.error(f"Salvataggio credenziali fallito: {e}")

def _gmail_list(gmail, page_token=None):
    """Esegue la chiamata API a Gmail con backoff esponenziale e jitter."""
    backoff = 0.5
    # Aggiunge il filtro per escludere spam e cestino direttamente nella query
    query = f"-in:spam -in:trash ({SEARCH_Q_BASE}) {LABEL_Q}".strip()
    logging.info(json.dumps({"type":"ingestor","stage":"gmail_list","q":query,"batch":GMAIL_BATCH}))
    for _ in range(6):
        try:
            return gmail.users().messages().list(
                userId='me', q=query, maxResults=GMAIL_BATCH,
                pageToken=page_token, includeSpamTrash=False
            ).execute()
        except HttpError as e:
            if e.resp.status in (429, 500, 502, 503, 504):
                sleep_time = backoff + random.uniform(0, backoff / 2)
                logging.warning(f"Errore API Gmail ({e.resp.status}), ritento tra {sleep_time:.2f}s...")
                time.sleep(sleep_time)
                backoff = min(backoff * 2, 8.0)
                continue
            raise
    raise RuntimeError("Troppi tentativi falliti su Gmail list.")

def _exists_in_db(user_id: str, msg_id: str) -> bool:
    """Controlla se un messaggio esiste già nel database per un utente."""
    N = cast(Any, Newsletter)
    return N.select(N.id).where(
        (N.user_id == user_id) & (N.email_id == msg_id)
    ).exists()

def _exists_thread(user_id: str, thread_id: str) -> bool:
    """Controlla se un thread esiste già nel database per un utente."""
    if not thread_id:
        return False
    N = cast(Any, Newsletter)
    return N.select(N.id).where(
        (N.user_id == user_id) & (N.thread_id == thread_id)
    ).exists()

def _rpush_safe(key: str, payload: str, tries: int = 3) -> bool:
    """Esegue rpush su Redis con retry per errori transienti."""
    for i in range(tries):
        try:
            redis_client.rpush(key, payload)
            return True
        except RedisError:
            time.sleep(0.2 * (i + 1))
    logging.error(f"rpush su Redis fallito persistentemente per la chiave {key}")
    return False

def get_new_emails_for_user(user_id: str, creds_dict: dict) -> list[str]:
    """Ritorna gli ID email non ancora presenti nel DB per questo utente."""
    try:
        creds = Credentials.from_authorized_user_info(creds_dict)
        if creds.expired and creds.refresh_token:
            logging.info(f"Token per l'utente {_scrub(user_id)} scaduto. Eseguo il refresh...")
            creds.refresh(GoogleAuthRequest())
            
            all_creds = _reload_creds()
            all_creds[user_id] = json.loads(creds.to_json())
            _save_creds_all(all_creds)
            
            logging.info(f"Token per l'utente {_scrub(user_id)} aggiornato e salvato.")

        gmail = build('gmail', 'v1', credentials=creds, cache_discovery=False)
        
        new_ids, page_token, pages = [], None, 0
        while len(new_ids) < BACKFILL_TARGET and pages < BACKFILL_PAGES and _run:
            resp = _gmail_list(gmail, page_token=page_token)
            msgs = resp.get('messages', []) or []
            logging.info(f"[GMAIL] user={_scrub(user_id)} page={pages+1} found_msgs={len(msgs)}")

            if not msgs:
                break

            # --- INIZIO MODIFICA: LOG DETTAGLIATI PER PAGINA ---
            sk_thread = sk_id = 0
            # --- FINE MODIFICA ---

            for m in msgs:
                mid = m.get("id")
                tid = m.get("threadId")

                # --- INIZIO MODIFICA: CONTROLLO CON FEATURE FLAG ---
                if THREAD_DEDUP_MODE == "skip" and _exists_thread(user_id, tid):
                    sk_thread += 1
                    logging.info(json.dumps({"type":"ingestor","stage":"skip_thread","user":_scrub(user_id),"thread":tid}))
                    continue
                # --- FINE MODIFICA ---
                
                if mid and not _exists_in_db(user_id, mid):
                    new_ids.append(mid)
                else:
                    # --- INIZIO MODIFICA: CONTEGGIO ID SALTATI ---
                    # Questo ramo viene eseguito se il messaggio non ha un ID
                    # o se l'ID esiste già nel DB (ma il thread non esisteva, se la flag è off)
                    sk_id += 1
                    # --- FINE MODIFICA ---

                    if len(new_ids) >= BACKFILL_TARGET:
                        break
            
            # --- INIZIO MODIFICA: LOG DI RIEPILOGO PAGINA ---
            logging.info(json.dumps({
                "type": "ingestor",
                "stage": "page_summary",
                "user": _scrub(user_id),
                "page": pages + 1,
                "msgs": len(msgs),
                "skipped_thread": sk_thread,
                "skipped_id": sk_id,
                "queued_so_far": len(new_ids)
            }))
            # --- FINE MODIFICA ---

            page_token = resp.get('nextPageToken')
            pages += 1
            if not page_token:
                break

        if new_ids:
            logging.info(f"Trovate {len(new_ids)} nuove email per {_scrub(user_id)}.")
        return new_ids
        
    except HttpError as e:
        logging.error(f"Errore API Google per l'utente {_scrub(user_id)}: {e}")
    except Exception as e:
        logging.error(f"Errore imprevisto per l'utente {_scrub(user_id)}: {e}", exc_info=True)
    return []

def main_loop():
    """Ciclo principale dell'ingestor."""
    logging.info("Ingestor avviato. Tento di acquisire il lock...")
    if not _acquire_lock():
        logging.error("Un'altra istanza dell'ingestor è già attiva. Chiusura.")
        return

    logging.info("Lock acquisito. Inizio ciclo di controllo...")
    while _run:
        _refresh_lock()
        all_user_credentials = _reload_creds()
        logging.debug(f"--- Nuovo ciclo (utenti: {len(all_user_credentials)}) ---")
        
        for user_id, creds in list(all_user_credentials.items()):
            if not _run: break
            if redis_client.exists(f"kickstart_active:{user_id}"):
                logging.info(f"Salto l'utente {_scrub(user_id)}, kickstart in corso.")
                continue

            new_ids = get_new_emails_for_user(user_id, creds)
            if not new_ids:
                continue

            user_key = f"ingestor:queued:{user_id}"
            global_key = "ingestor:seen_global"
            jobs_created = 0
            
            for email_id in new_ids:
                nl, created = Newsletter.get_or_create(
                    email_id=email_id, user_id=user_id,
                    defaults={
                        "received_date": datetime.now(timezone.utc),
                        "enriched": False, "is_complete": False
                    }
                )
                if created or not nl.enriched:
                    # Deduplicazione a livello utente E globale
                    if redis_client.sadd(user_key, email_id) and redis_client.sadd(global_key, email_id):
                        job_payload = json.dumps({"email_id": email_id, "user_id": user_id})
                        logging.debug(f"[ENQ] rpush email_queue user={_scrub(user_id)} email_id={email_id}")
                        if _rpush_safe("email_queue", job_payload):
                            jobs_created += 1

            if jobs_created > 0:
                # Imposta TTL solo se non è già presente, per efficienza
                ttl_user = cast(int, redis_client.ttl(user_key))
                if isinstance(ttl_user, int) and ttl_user < 0:
                    redis_client.expire(user_key, 24 * 3600)

                ttl_global = cast(int, redis_client.ttl(global_key))
                if isinstance(ttl_global, int) and ttl_global < 0:
                    redis_client.expire(global_key, 24 * 3600)
                    
                logging.info(f"Aggiunti {jobs_created} lavori alla coda per l'utente {_scrub(user_id)}.")

        if _run:
            logging.debug(f"--- Ciclo completato. Pausa di {POLL_SECONDS} secondi. ---")
            time.sleep(POLL_SECONDS)

    logging.info("Ingestor in fase di chiusura...")

if __name__ == "__main__":
    if db.is_closed():
        db.connect()
    initialize_db()
    try:
        main_loop()
    finally:
        if not db.is_closed():
            db.close()
        # Rilascia il lock in uscita
        if redis_client.get("ingestor:lock") == str(os.getpid()):
            redis_client.delete("ingestor:lock")
            logging.info("Lock rilasciato.")
        logging.info("Ingestor fermato.")