# backend/worker.py

import os
from googleapiclient.errors import HttpError
import http.client as http_client
import ssl
import socket
import time
import json
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
load_dotenv("/opt/newsletter/.env")
from backend.logging_config import setup_logging
import logging
import typing as t
from typing import Any, Optional, Tuple, cast
import redis
from redis import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from peewee import DoesNotExist as PeeweeDoesNotExist
import asyncio
import httpx
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleAuthRequest
from googleapiclient.discovery import build
from email.utils import parsedate_to_datetime, parseaddr

from backend.database import db, Newsletter, initialize_db, DomainTypeOverride
from backend.processing_utils import (
            extract_html_from_payload, parse_sender, clean_html,
            get_ai_summary, get_ai_keyword, get_pixabay_image_by_query, extract_dominant_hex, classify_type_and_topic,
            root_domain_py, extract_domain_from_from_header,
            SHARED_HTTP_CLIENT
        )

# --- CONFIGURAZIONE ---
setup_logging("WORKER")

THREAD_DEDUP_MODE = os.getenv("THREAD_DEDUP_MODE", "skip").lower()
logging.info(f"Modalità deduplicazione thread impostata: THREAD_DEDUP_MODE={THREAD_DEDUP_MODE}")

BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:8000")

CREDENTIALS_PATH = "/app/data/user_credentials.json"
try:
    with open(CREDENTIALS_PATH, "r") as f:
        ALL_USER_CREDENTIALS = json.load(f)
except FileNotFoundError:
    logging.error(f"File credenziali '{CREDENTIALS_PATH}' non trovato. Il worker non può partire.")
    exit()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
try:
    redis_client: Redis = cast(Redis, redis.from_url(REDIS_URL, decode_responses=True))
    redis_client.ping()
    logging.info("Connesso a Redis.")
except RedisConnectionError as e:
    logging.error(f"Impossibile connettersi a Redis: {e}.")
    exit()

# Limita il numero di elaborazioni pesanti in parallelo per non sovraccaricare il sistema
# MODIFICA: Ridotta concorrenza come richiesto
ENRICH_SEM = asyncio.Semaphore(1)

# Aggiungi configurazione e semaforo dedicato a Pixabay
PIXABAY_MAX_CONC = int(os.getenv("PIXABAY_MAX_CONC", "1"))  # 1 è prudente
PIXABAY_RPM = int(os.getenv("PIXABAY_RPM", "25"))           # rate conservativo
PIXABAY_CACHE_TTL = int(os.getenv("PIXABAY_CACHE_TTL", "604800"))  # 7 giorni
PIXABAY_BLOCK_SEC = int(os.getenv("PIXABAY_BLOCK_SEC", "900"))     # 15 minuti
PIXABAY_SEM = asyncio.Semaphore(PIXABAY_MAX_CONC)


# --- FUNZIONI HELPER PER OPERAZIONI BLOCCANTI ---
def _save_credentials_all(creds_all: dict):
    """Salva il dizionario completo delle credenziali in modo atomico e sicuro."""
    try:
        tmp_path = CREDENTIALS_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(creds_all, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, CREDENTIALS_PATH)
        try:
            os.chmod(CREDENTIALS_PATH, 0o600)
        except (OSError, AttributeError):
            pass
    except Exception as e:
        logging.error(f"Salvataggio credenziali fallito: {e}")

def _db_get_newsletter(email_id, user_id):
    """Funzione sincrona per ottenere la newsletter dal DB."""
    try:
        return Newsletter.get(Newsletter.email_id == email_id, Newsletter.user_id == user_id)
    except PeeweeDoesNotExist:
        return None

def _db_save_newsletter(newsletter_instance):
    """Funzione sincrona per salvare la newsletter."""
    newsletter_instance.save()

def _refresh_credentials(creds_dict):
    """Funzione sincrona per fare il refresh del token."""
    creds = Credentials.from_authorized_user_info(creds_dict)
    if creds.expired and creds.refresh_token:
        logging.info(f"[WORKER] Token per utente scaduto. Eseguo il refresh...")
        creds.refresh(GoogleAuthRequest())
        return json.loads(creds.to_json())
    return None # Nessun refresh necessario

# Aggiungi un semplice gate di rate e cache usando Redis
def _pixabay_cache_key(kw: str) -> str:
    return f"pixabay:img:{(kw or '').strip().lower()}"

async def _pixabay_rate_gate():
    val_raw: Any = redis_client.get("pixabay:block_until_epoch")
    block_until: float = 0.0
    if val_raw is not None:
        try:
            block_until = float(val_raw)  # gestisce str/int/bytes
        except (TypeError, ValueError):
            block_until = 0.0
    if block_until and time.time() < block_until:
        raise RuntimeError("pixabay_temporarily_blocked")

    now_min = int(time.time() // 60)
    cnt_key = f"pixabay:rpm:{now_min}"
    cnt_raw: Any = redis_client.incr(cnt_key)
    cnt: int = int(cnt_raw)
    if cnt == 1:
        redis_client.expire(cnt_key, 120)
    if cnt > PIXABAY_RPM:
        await asyncio.sleep(1.0)  # breve attesa quando si eccede

# --- LOGICA PRINCIPALE DEL WORKER ---


async def _gmail_get_message_with_retries(gmail, msg_id: str, max_attempts: int = 5):
    backoff = 0.5
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await asyncio.to_thread(
                gmail.users().messages().get(userId='me', id=msg_id, format='full').execute
            )
        except (HttpError, http_client.IncompleteRead, ssl.SSLError, socket.timeout, ConnectionResetError) as e:
            last_exc = e
            logw("gmail_get_retry", msg_id=msg_id, attempt=attempt, error=str(e))
            logging.warning(f"[{msg_id}] transient gmail get error (attempt {attempt}/{max_attempts}): {e}")
            await asyncio.sleep(backoff)
            backoff *= 2
        except Exception as e:
            last_exc = e
            logging.warning(f"[{msg_id}] unexpected gmail get error (attempt {attempt}/{max_attempts}): {e}")
            if attempt >= max_attempts:
                raise
            await asyncio.sleep(backoff)
            backoff *= 2
    raise last_exc or RuntimeError("_gmail_get_message_with_retries: unknown failure")

def logw(stage, **kv):
    try:
        logging.info(json.dumps({"type": "worker", "stage": stage, **kv}))
    except Exception:
        logging.info(f"[worker][{stage}] {kv}")

def to_utc(dt):
    if dt is None: return None
    return dt.astimezone(timezone.utc) if getattr(dt, "tzinfo", None) else dt.replace(tzinfo=timezone.utc)

async def process_job(job_payload: dict):
    email_id = job_payload.get("email_id")
    user_id = job_payload.get("user_id")
    job_id = job_payload.get("job_id")
    t0 = time.perf_counter()
    logw("start", user_id=user_id, email_id=email_id, job_id=job_id)

    if not email_id or not user_id:
        logw("malformed_job", job_payload=job_payload)
        return

    try:
        q_len = redis_client.llen("email_queue")
        logw("job_info", user_id=user_id, email_id=email_id, job_id=job_id, queue_len=q_len)
    except Exception as e:
        logw("redis_llen_failed", error=str(e))

    try:
        n = await asyncio.to_thread(Newsletter.get_or_none, (Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
        if not n:
            logw("missing_record", user_id=user_id, email_id=email_id)
            return
        if n.enriched:
            logw("already_enriched_and_tagged", user_id=user_id, email_id=email_id)
            return

        # --- INIZIO FIX CORRETTO ---
        # Ricarica le credenziali dal file ogni volta
        try:
            with open(CREDENTIALS_PATH, "r") as f:
                all_creds = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            all_creds = {}
        creds_dict = all_creds.get(user_id)

        if not creds_dict:
            logw("missing_credentials", user_id=user_id, email_id=email_id)
            return
        # --- FINE FIX CORRETTO ---
        refreshed_creds = await asyncio.to_thread(_refresh_credentials, creds_dict)
        if refreshed_creds:
            logw("creds_refreshed", user_id=user_id)
            all_creds[user_id] = refreshed_creds
            # Salva le nuove credenziali per tutti i processi futuri
            await asyncio.to_thread(_save_credentials_all, all_creds)
            creds_dict = refreshed_creds

        creds = Credentials.from_authorized_user_info(creds_dict)
        gmail = build('gmail', 'v1', credentials=creds, cache_discovery=False)
        
        message = await _gmail_get_message_with_retries(gmail, email_id)
        
        # MODIFICA: Evita futuri conflitti di thread_id
        tid = message.get("threadId")
        if tid and THREAD_DEDUP_MODE == "skip":
            dup = await asyncio.to_thread(
                Newsletter.get_or_none,
                (Newsletter.user_id == user_id) & (Newsletter.thread_id == tid) & (Newsletter.email_id != email_id)
            )
            if dup:
                logw("skip_due_to_thread_duplicate", user_id=user_id, email_id=email_id, thread_id=tid)
                _ = (cast(Any, Newsletter)
                    .update(enriched=True, is_complete=False)
                    .where((Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
                    .execute())
                return
        
        label_ids = set(message.get('labelIds', []))
        if 'SPAM' in label_ids or 'TRASH' in label_ids:
            _ = (cast(Any, Newsletter)
               .update(is_deleted=True, enriched=True, is_complete=False)
               .where((Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
               .execute())
            return

        html_content = extract_html_from_payload(message.get("payload", {}))
        headers = message.get('payload', {}).get('headers', [])
        header_map = {h['name'].lower(): h['value'] for h in headers}
        
        internal_date_ms = message.get('internalDate')
        received_dt_utc = datetime.fromtimestamp(int(internal_date_ms) / 1000, tz=timezone.utc) if internal_date_ms else datetime.now(timezone.utc)

        preliminary_data: dict[str, Any] = {
            "sender_name": parse_sender(header_map.get('from', '')),
            "sender_email": parseaddr(header_map.get('from', ''))[1].lower(),
            "original_subject": header_map.get('subject', ''),
            "full_content_html": html_content,
            "received_date": received_dt_utc,
            "source_domain": root_domain_py(extract_domain_from_from_header(header_map.get('from', ''))),
            "thread_id": message.get("threadId"),
            "rfc822_message_id": header_map.get("message-id"),
        }
        _ = (cast(Any, Newsletter)
           .update(**preliminary_data)
           .where((Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
           .execute())
        
        update_data: dict[str, Any] = {"enriched": True, "is_complete": False}

        try:
            # --- INIZIO FIX: USARE L'HTML PULITO ---
            cleaned_content = clean_html(html_content)
            content_for_ai = cleaned_content  # Usa sempre il contenuto pulito

            if not content_for_ai:
                subj = header_map.get('subject', '')
                snip = message.get('snippet', '')
                content_for_ai = f"Oggetto: {subj}\n\nAnteprima: {snip}"
                logw("content_fallback_used", email_id=email_id, reason="Empty HTML body")

            async with ENRICH_SEM:
                ai_summary = await get_ai_summary(content_for_ai, SHARED_HTTP_CLIENT)
                ai_keyword = await get_ai_keyword(content_for_ai, SHARED_HTTP_CLIENT)

                logw("ai_results", 
                 email_id=email_id, 
                 title_chars=len(ai_summary.get('title','')), 
                 summary_chars=len(ai_summary.get('summary_markdown','')),
                 keyword=ai_keyword)
                
                # Usa cache + semaforo + gestione 429/403 attorno alla chiamata
                image_url = None
                kw = (ai_keyword or "").strip()
                if not kw:
                    subj = header_map.get('subject') or ''
                    kw = ' '.join(subj.split()[:6]) or 'newsletter'
                cache_key = _pixabay_cache_key(kw)
                cached = redis_client.get(cache_key)
                if cached:
                    image_url = cached
                else:
                    async with PIXABAY_SEM:
                        await _pixabay_rate_gate()
                        try:
                            logw("pixabay_fetch", email_id=email_id, keyword=kw)
                            image_url = await get_pixabay_image_by_query(SHARED_HTTP_CLIENT, kw)
                        except httpx.HTTPStatusError as e:
                            sc = e.response.status_code
                            if sc == 429:
                                ra = e.response.headers.get("Retry-After")
                                delay = int(ra) if ra and ra.isdigit() else 5
                                await asyncio.sleep(delay)
                                await _pixabay_rate_gate()
                                image_url = await get_pixabay_image_by_query(SHARED_HTTP_CLIENT, kw)
                            elif sc == 403:
                                # blocca per un po' per evitare martellamento
                                until = int(time.time()) + PIXABAY_BLOCK_SEC
                                redis_client.setex("pixabay:block_until_epoch", PIXABAY_BLOCK_SEC, until)
                                image_url = None
                        if image_url:
                            redis_client.setex(cache_key, PIXABAY_CACHE_TTL, image_url)
                            logw("pixabay_hit", email_id=email_id, image_url=image_url)
                        else:
                            logw("pixabay_miss", email_id=email_id, keyword=kw, reason="API returned no results or error occurred")

                meta = f"FROM: {header_map.get('from','')}\nSUBJECT: {header_map.get('subject','')}\n\n"
                tags = await classify_type_and_topic(meta + content_for_ai, SHARED_HTTP_CLIENT)

            sender_email = parseaddr(header_map.get('from',''))[1].lower()
            sender_domain = (sender_email.split('@')[-1]).lower()
            
            if sender_domain:
                override = await asyncio.to_thread(DomainTypeOverride.get_or_none, (DomainTypeOverride.user_id == user_id) & (DomainTypeOverride.domain == sender_domain))
                if override:
                    tags["type_tag"] = override.type_tag
                    logw("type_override_applied", domain=sender_domain, new_type=override.type_tag)
            
            is_complete = bool(ai_summary.get('title') and ai_summary.get('summary_markdown') and image_url)

            logw("completeness_check", 
             email_id=email_id, 
             is_complete=is_complete,
             has_title=bool(ai_summary.get('title')),
             has_summary=bool(ai_summary.get('summary_markdown')),
             has_image=bool(image_url))

            update_data.update({
                "ai_title": ai_summary.get('title'),
                "ai_summary_markdown": ai_summary.get('summary_markdown'),
                "image_url": image_url,
                "is_complete": is_complete,
                "type_tag": tags.get("type_tag"),
                "topic_tag": tags.get("topic_tag"),
            })

            if not n.tag and ai_keyword:
                update_data["tag"] = ai_keyword.strip()[:32]
        
        except Exception as e:
            logw("enrichment_error", user_id=user_id, email_id=email_id, error=str(e), exc_info=True)
        
        finally:
            feed_visible = bool(update_data.get("is_complete"))
            logw("db_update_fields", email_id=email_id, keys=list(update_data.keys()))
            logw("about_to_save", email_id=email_id, thread_id=tid, will_be_visible=feed_visible)
            _ = (cast(Any, Newsletter)
               .update(**update_data)
               .where((Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
               .execute())
            
            logw("saved", user_id=user_id, email_id=email_id, updated_rows=1,
                 is_complete=update_data.get("is_complete", False))

        if job_id:
            try:
                update_channel = f"sse:update:{job_id}"
                update_payload = json.dumps({"email_id": email_id})
                redis_client.publish(update_channel, update_payload)

                progress_channel = f"sse:progress:{job_id}"
                redis_client.publish(progress_channel, "progress")
                
                logw("redis_notify_ok", job_id=job_id, email_id=email_id)
            except Exception as e:
                logw("redis_notify_err", job_id=job_id, email_id=email_id, error=str(e))

    except Exception as e:
        logw("critical_error", user_id=user_id, email_id=email_id, error=str(e), exc_info=True)
    finally:
        logw("end", user_id=user_id, email_id=email_id, dur_ms=int((time.perf_counter() - t0) * 1000))


async def main_worker_loop():
    logging.info("Worker avviato. In attesa di lavoro...")
    while True:
        try:
            job_json_tuple: Optional[Tuple[str, str]] = cast(
                Optional[Tuple[str, str]],
                await asyncio.to_thread(redis_client.blpop, ['email_queue'], 0)
            )
            if job_json_tuple:
                _, job_json = job_json_tuple
                job_payload = json.loads(job_json)
                logging.info(f"Nuovo lavoro ricevuto: {job_payload.get('email_id')}")
                asyncio.create_task(process_job(job_payload))
        except RedisConnectionError as e:
            logging.error(f"Connessione a Redis persa: {e}. Riprovo tra 5s.")
            await asyncio.sleep(5)
        except Exception as e:
            logging.error(f"Errore nel ciclo worker: {e}", exc_info=True)
            await asyncio.sleep(1)

if __name__ == "__main__":
    if db.is_closed():
        db.connect()
    initialize_db()

    try:
        asyncio.run(main_worker_loop())
    except KeyboardInterrupt:
        logging.info("Ricevuto segnale di interruzione. Chiusura del Worker in corso...")
    finally:
        if not db.is_closed():
            db.close()
        logging.info("Worker fermato.")