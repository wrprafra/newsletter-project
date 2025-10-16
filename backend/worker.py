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
load_dotenv()
from logging_config import setup_logging
import logging
import redis
import asyncio
import httpx
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleAuthRequest
from googleapiclient.discovery import build
from email.utils import parsedate_to_datetime, parseaddr
from datetime import datetime

from database import db, Newsletter, initialize_db, DomainTypeOverride
from backend.processing_utils import (
            extract_html_from_payload, parse_sender, clean_html, # <-- AGGIUNTA QUI
            get_ai_summary, get_ai_keyword, get_pixabay_image_by_query, extract_dominant_hex, classify_type_and_topic,
            root_domain_py, extract_domain_from_from_header,
            SHARED_HTTP_CLIENT
        )

# --- CONFIGURAZIONE ---
setup_logging("WORKER")

BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:8000")

CREDENTIALS_PATH = "user_credentials.json"
try:
    with open(CREDENTIALS_PATH, "r") as f:
        ALL_USER_CREDENTIALS = json.load(f)
except FileNotFoundError:
    logging.error(f"File credenziali '{CREDENTIALS_PATH}' non trovato. Il worker non può partire.")
    exit()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
try:
    redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    logging.info("Connesso a Redis.")
except redis.exceptions.ConnectionError as e:
    logging.error(f"Impossibile connettersi a Redis: {e}.")
    exit()

# Limita il numero di elaborazioni pesanti in parallelo per non sovraccaricare il sistema
ENRICH_SEM = asyncio.Semaphore(10)

# --- FUNZIONI HELPER PER OPERAZIONI BLOCCANTI ---

def _db_get_newsletter(email_id, user_id):
    """Funzione sincrona per ottenere la newsletter dal DB."""
    try:
        return Newsletter.get(Newsletter.email_id == email_id, Newsletter.user_id == user_id)
    except Newsletter.DoesNotExist:
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
        n = await asyncio.to_thread(Newsletter.get_or_none, (Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
        if not n:
            logw("missing_record", user_id=user_id, email_id=email_id)
            return
        if n.enriched:
            logw("already_enriched_and_tagged", user_id=user_id, email_id=email_id)
            return

        creds_dict = ALL_USER_CREDENTIALS.get(user_id)
        creds = Credentials.from_authorized_user_info(creds_dict)
        gmail = build('gmail', 'v1', credentials=creds, cache_discovery=False)
        
        message = await _gmail_get_message_with_retries(gmail, email_id)
        
        label_ids = set(message.get('labelIds', []))
        if 'SPAM' in label_ids or 'TRASH' in label_ids:
            (Newsletter
               .update(is_deleted=True, enriched=True, is_complete=False)
               .where((Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
               .execute())
            return

        html_content = extract_html_from_payload(message.get("payload", {}))
        headers = message.get('payload', {}).get('headers', [])
        header_map = {h['name'].lower(): h['value'] for h in headers}
        
        internal_date_ms = message.get('internalDate')
        received_dt_utc = datetime.fromtimestamp(int(internal_date_ms) / 1000, tz=timezone.utc) if internal_date_ms else datetime.now(timezone.utc)

        preliminary_data = {
            "sender_name": parse_sender(header_map.get('from', '')),
            "sender_email": parseaddr(header_map.get('from', ''))[1].lower(),
            "original_subject": header_map.get('subject', ''),
            "full_content_html": html_content,
            "received_date": received_dt_utc,
            "source_domain": root_domain_py(extract_domain_from_from_header(header_map.get('from', ''))),
            "thread_id": message.get("threadId"),
            "rfc822_message_id": header_map.get("message-id"),
        }
        (Newsletter
           .update(**preliminary_data)
           .where((Newsletter.email_id == email_id) & (Newsletter.user_id == user_id))
           .execute())
        
        update_data = {"enriched": True, "is_complete": False}

        try:
            content_for_ai = html_content
            if not clean_html(content_for_ai):
                subj = header_map.get('subject', '')
                snip = message.get('snippet', '')
                content_for_ai = f"Oggetto: {subj}\n\nAnteprima: {snip}"
                logw("content_fallback_used", email_id=email_id, reason="Empty HTML body")

            async with ENRICH_SEM:
                ai_summary = await get_ai_summary(content_for_ai, SHARED_HTTP_CLIENT)
                ai_keyword = await get_ai_keyword(content_for_ai, SHARED_HTTP_CLIENT)
                image_url = await get_pixabay_image_by_query(SHARED_HTTP_CLIENT, ai_keyword)
                
                meta = f"FROM: {header_map.get('from','')}\nSUBJECT: {header_map.get('subject','')}\n\n"
                tags = await classify_type_and_topic(meta + content_for_ai, SHARED_HTTP_CLIENT)

            # --- INIZIO FIX ---
            sender_email = parseaddr(header_map.get('from',''))[1].lower()
            sender_domain = (sender_email.split('@')[-1]).lower()
            
            if sender_domain:
                override = await asyncio.to_thread(DomainTypeOverride.get_or_none, (DomainTypeOverride.user_id == user_id) & (DomainTypeOverride.domain == sender_domain))
                if override:
                    tags["type_tag"] = override.type_tag
                    logw("type_override_applied", domain=sender_domain, new_type=override.type_tag)
            
            is_complete = bool(ai_summary.get('title') and ai_summary.get('summary_markdown') and image_url)

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
            (Newsletter
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
            # Esegui la chiamata bloccante in un thread separato per non bloccare l'event loop
            job_json_tuple = await asyncio.to_thread(redis_client.blpop, 'email_queue', timeout=0)
            
            if job_json_tuple:
                # blpop restituisce una tupla (nome_coda, valore)
                _, job_json = job_json_tuple
                job_payload = json.loads(job_json)
                logging.info(f"Nuovo lavoro ricevuto: {job_payload.get('email_id')}")
                # Crea il task che ora può essere eseguito dall'event loop
                asyncio.create_task(process_job(job_payload))
        except redis.exceptions.ConnectionError as e:
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