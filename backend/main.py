import os
import base64
import re
import secrets
import time
import asyncio
import httpx
import json
import ssl
import http.client as http_client
import io
from email.utils import parseaddr
from PIL import Image
import redis
from fastapi.responses import HTMLResponse
from bs4 import BeautifulSoup
import logging
from fastapi.middleware.gzip import GZipMiddleware
from google.auth.transport.requests import Request as GoogleAuthRequest
from database import db, initialize_db, Newsletter, DomainTypeOverride
from collections import defaultdict
import uuid
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import Header, BackgroundTasks, Request, HTTPException, Response, APIRouter, Query, FastAPI
import socket
import ipaddress
import hashlib
from urllib.parse import quote, urlparse, unquote, urljoin
from collections import OrderedDict, Counter, deque
import random
import bleach
from peewee import fn
from datetime import datetime, timezone
from starlette.middleware.sessions import SessionMiddleware
from fastapi.responses import StreamingResponse, RedirectResponse, JSONResponse
import typing as t
from pydantic import BaseModel, Field
from typing import Dict, Any, Tuple
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from google.auth.exceptions import RefreshError
from oauthlib.oauth2.rfc6749.errors import InvalidGrantError
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)
import openai
from html import escape as html_escape
import sys
import boto3
from botocore.config import Config as BotoConfig
from googleapiclient.errors import HttpError
from processing_utils import (
    _walk_parts, 
    _decode_body, 
    root_domain_py, 
    extract_domain_from_from_header,
    get_ai_keyword,
    get_pixabay_image_by_query,
)

# --- GESTIONE CICLO DI VITA APP ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.info("Evento STARTUP: Inizio avvio applicazione...")
    load_settings_store()
    # --- INIZIO MODIFICA ---
    # Assicurati che questa riga sia presente. È il pezzo mancante.
    load_credentials_store()
    # --- FINE MODIFICA ---
    if db.is_closed():
        logging.info("Evento STARTUP: Connessione al database...")
        db.connect()
    initialize_db()
    logging.info("Evento STARTUP: Avvio completato.")
    yield
    logging.info("Evento SHUTDOWN: Inizio spegnimento applicazione...")
    try:
        await PROXY_HTTP_CLIENT.aclose()
    except Exception:
        pass

    if not db.is_closed():
        logging.info("Evento SHUTDOWN: Chiusura connessione al database.")
        db.close()
    logging.info("Evento SHUTDOWN: Spegnimento completato.")

app = FastAPI(lifespan=lifespan)
router_settings = APIRouter(prefix="/api/settings", tags=["settings"])
router_auth = APIRouter(prefix="/auth", tags=["authentication"])
router_api = APIRouter(prefix="/api", tags=["api"])
AUTH_PENDING_TTL = 1800

@app.get("/debug/auth-state")
def debug_auth_state(request: Request):
    sid = request.session.get("sid")
    pa = _load_pending_auth(request)
    return {"sid": sid, "pending_keys": list(pa.keys()), "has_session_pending": bool(request.session.get("pending_auth"))}
    
def _get_pending_auth_nonce_key(sid: str, nonce: str) -> str:
    return f"pending_auth:{sid}:{nonce}"

def _load_pending_auth(request: Request) -> dict:
    sid = request.session.get("sid")
    if sid and redis_client:
        try:
            raw = redis_client.get(_get_pending_auth_key(sid))
            if raw:
                d = json.loads(raw)
                logging.info(f"[AUTH] load_pending_auth sid={sid} keys={list(d.keys())}")
                return d
        except Exception as e:
            logging.warning(f"[AUTH] redis get failed: {e}")
    d = request.session.get("pending_auth") or {}
    logging.info(f"[AUTH] load_pending_auth(session) sid={sid} keys={list(d.keys())}")
    return d

def _clear_pending_auth(request: Request) -> None:
    sid = request.session.get("sid")
    if sid and redis_client:
        try: redis_client.delete(_get_pending_auth_key(sid))
        except Exception as e: logging.warning(f"[AUTH] redis del failed: {e}")
    request.session.pop("pending_auth", None)

def _add_gmail_deep_link_fields(item_dict: dict) -> dict:
    """
    Aggiunge i campi necessari per il deep link di Gmail a un dizionario di item.
    Assume che i dati provengano dal record del database.
    """
    # Il message_id di Gmail è il nostro email_id primario.
    item_dict["gmail_message_id"] = item_dict.get("email_id")
    
    # Il thread_id dovrebbe essere salvato nel DB dal worker.
    item_dict["gmail_thread_id"] = item_dict.get("thread_id")
    
    # L'header Message-ID (RFC 822) dovrebbe essere salvato nel DB.
    item_dict["rfc822_message_id"] = item_dict.get("rfc822_message_id")
    
    # Indice dell'account, default a 0 per il primo account loggato.
    item_dict["gmail_account_index"] = item_dict.get("gmail_account_index", 0)
    
    return item_dict

def _derive_source_domain(item: dict) -> str:
    """Estrae in modo affidabile il dominio principale da un'email."""
    sender_email = item.get("sender_email") or ""
    # La funzione extract_domain_from_from_header è robusta per l'header "From"
    # e funziona bene anche solo con un indirizzo email.
    domain = extract_domain_from_from_header(sender_email)
    # root_domain_py lo riduce a "example.com" da "mail.example.com"
    return root_domain_py(domain)

def log_feed(rid, stage, **kv):
    try:
        logging.info(json.dumps({
            "type": "feed",
            "rid": rid,
            "stage": stage,
            **{k: (str(v) if not isinstance(v, (str, int, float, bool, type(None))) else v)
               for k, v in kv.items()}
        }))
    except Exception:
        # Mai fallire sul logging
        logging.info(f"[feed][{stage}] {kv}")

def extract_dominant_hex(img_bytes: bytes) -> str:
    """Estrae il colore dominante, lo scurisce, e garantisce un contrasto minimo evitando il nero puro."""
    try:
        im = Image.open(io.BytesIO(img_bytes)).convert("RGBA").resize((64, 64))
        pal = im.convert("P", palette=Image.Palette.ADAPTIVE, colors=8)
        palette = pal.getpalette()
        counts = sorted(pal.getcolors(), reverse=True)
        
        for _, idx in counts:
            r, g, b = palette[idx*3: idx*3+3]

            # --- INIZIO MODIFICA ---

            # 1. Ignora i colori che sono già quasi neri in partenza per evitare di accentuarli.
            original_luminance = (0.299 * r + 0.587 * g + 0.114 * b)
            if original_luminance < 20:
                continue # Prova il prossimo colore, questo è troppo scuro.

            # 2. Scurisci il colore in modo leggermente meno aggressivo (es. 70% invece di 60%).
            dark_r = int(r * 0.7)
            dark_g = int(g * 0.7)
            dark_b = int(b * 0.7)
            
            # Calcola la luminosità percepita del colore scurito.
            final_luminance = (0.299 * dark_r + 0.587 * dark_g + 0.114 * dark_b)
            
            # 3. Definisci un range di luminosità accettabile per il background.
            #    - Non troppo scuro (< 25) per evitare il nero profondo.
            #    - Non troppo chiaro (> 120) per garantire il contrasto con il testo bianco.
            if final_luminance < 25 or final_luminance > 120:
                continue # Prova il prossimo colore, questo non ha il contrasto giusto.

            # --- FINE MODIFICA ---

            return f"#{dark_r:02x}{dark_g:02x}{dark_b:02x}"
            
    except Exception as e:
        logging.warning(f"[COLOR] Errore durante l'estrazione del colore: {e}")

    # Se nessun colore dominante ha abbastanza contrasto o c'è un errore, usa il fallback.
    return "#374151" # Questo fallback è già un grigio scuro, non nero.



if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    
# image_cache: dict[str, tuple[bytes, str]] = {}

from logging_config import setup_logging
setup_logging("BACKEND")

logger = logging.getLogger("app")
# os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

GOOGLE_CLIENT_ID_WEB = os.getenv("GOOGLE_CLIENT_ID_WEB")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
logging.info("[CFG] OPENAI key present=%s len=%d", bool(OPENAI_API_KEY), len(OPENAI_API_KEY))
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
PIXABAY_KEY = os.getenv("PIXABAY_KEY")
SETTINGS_PATH = "user_settings.json"
CREDENTIALS_PATH = "user_credentials.json"
SETTINGS_STORE: Dict[str, Dict[str, Any]] = {}
CREDENTIALS_STORE: Dict[str, dict] = {}
R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET = os.getenv("R2_BUCKET", "newsletter-images-dev")
R2_PUBLIC_BASE_URL = (os.getenv("R2_PUBLIC_BASE_URL") or "").rstrip("/")

INGEST_JOBS: dict[str, dict] = {}
PENDING_AUTH: dict = {}  # job_id -> {"state": "...", "total": 0, "done": 0, "errors": 0}
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
INDEX = FRONTEND_DIR / "index.html"
SSE_LISTENERS = defaultdict(list)
print(f"[BOOT] Serving frontend from: {FRONTEND_DIR}")
print(f"[BOOT] index.html exists? {INDEX.exists()}")
IMG_PROXY_MAX_ITEMS = int(os.getenv("IMG_PROXY_MAX_ITEMS", "1024"))
IMG_PROXY_TTL       = int(os.getenv("IMG_PROXY_TTL", str(24*3600)))  # 24h
IMG_PROXY_MAX_BYTES = int(os.getenv("IMG_PROXY_MAX_BYTES", str(5*1024*1024)))  # 5MB
PHOTOS_CACHE_MAX_ITEMS = int(os.getenv("PHOTOS_CACHE_MAX_ITEMS", "200"))
photos_cache: "OrderedDict[str, dict]" = OrderedDict()
PHOTOS_CACHE_TTL       = int(os.getenv("PHOTOS_CACHE_TTL", str(30*60)))  # 30m
SESSION_EMAIL: dict[str, str] = {}
# ⬇️ UNICA istanza FastAPI
_proxy_limits = httpx.Limits(max_connections=200, max_keepalive_connections=100)
_proxy_timeout = httpx.Timeout(15.0, connect=5.0)
_proxy_transport = httpx.AsyncHTTPTransport(retries=2)
PROXY_HTTP_CLIENT = httpx.AsyncClient(
    http2=True,
    limits=_proxy_limits,
    timeout=_proxy_timeout,
    transport=_proxy_transport,
    follow_redirects=True # Gestisce i redirect automaticamente
)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
try:
    redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    logging.info("API connessa a Redis con successo.")
except redis.exceptions.ConnectionError as e:
    logging.error(f"API: Impossibile connettersi a Redis: {e}. Il kickstart potrebbe non funzionare.")
    redis_client = None # Imposta a None se la connessione fallisce

_TRANSPARENT_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII="
)
# AUTH_STATE_STORE: dict[str, list[tuple[str, float]]] = defaultdict(list)  # sid -> [(state, ts), ...]
# AUTH_STATE_TTL = 10 * 60  # 10 minuti
PHOTOS_POOLS: dict[str, list[dict]] = defaultdict(list)   # user_id -> [mediaItems]
PHOTOS_BEARERS: dict[str, str] = {}      
_BANNED_KW = {
    "news", "newsletter", "update", "story", "blog", "article", "notizie", "aggiornamenti",
    "email", "mail", "contenuto", "contenuti", "informazioni", "information", "comunicazione",
    "report", "weekly", "daily", "monthly", "post", "pubblicazione"
}

ALLOWED_TAGS = [
    "p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "blockquote",
    "a", "span", "div", "img", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code",
    "table", "thead", "tbody", "tr", "th", "td"  # <-- Aggiunti tag per le tabelle
]
ALLOWED_ATTRS = {
    "*": ["class"],
    "a": ["href","title","name","target","rel"],
    "img": ["src","alt","title","width","height"],
}
ALLOWED_PROTOCOLS = ["http","https"]

def enforce_safe_anchor_rel(html: str) -> str:
    """Assicura rel='noopener noreferrer' su <a target="_blank"> senza alterare altro."""
    try:
        soup = BeautifulSoup(html or "", "html.parser")
        for a in soup.find_all("a"):
            if a.get("target") == "_blank":
                rel = set(a.get("rel") or [])
                rel.update({"noopener", "noreferrer"})
                a["rel"] = sorted(list(rel)) # BeautifulSoup gestisce la conversione a stringa
        return str(soup)
    except Exception:
        return html
    
def _sanitize_view_html(raw_html: str) -> str:
    if not raw_html:
        return ""
    soup = BeautifulSoup(raw_html, "html.parser")
    # 1) rimuovi tutti gli <script>
    for s in soup.find_all("script"):
        s.decompose()
    # 2) ripulisci handler inline e javascript:*
    for tag in soup.find_all(True):
        for a in list(tag.attrs):
            if a.lower().startswith("on"):  # onload, onclick, ecc.
                del tag.attrs[a]
        if tag.has_attr("href") and str(tag["href"]).strip().lower().startswith("javascript:"):
            del tag["href"]
        if tag.has_attr("src") and str(tag["src"]).strip().lower().startswith("javascript:"):
            del tag["src"]
    return str(soup)

def sanitize_html(html: str) -> str:
    return bleach.clean(
        html or "",
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        protocols=ALLOWED_PROTOCOLS,
        strip=True
    )

# def _purge_auth_states(sid: str):
#     now = time.time()
#     AUTH_STATE_STORE[sid] = [(s,t) for (s,t) in AUTH_STATE_STORE.get(sid, []) if now - t < AUTH_STATE_TTL]
#     # tieni gli ultimi 5
#     AUTH_STATE_STORE[sid] = AUTH_STATE_STORE[sid][-5:]

class LogEntry(BaseModel):
    level: str = "INFO"
    message: str

def json_serial(obj):
    """Serializer JSON per oggetti non serializzabili di default, come datetime."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Il tipo {type(obj)} non è serializzabile in JSON")

def create_reader_view_html(body_html: str, msg_id: str) -> str:
    """
    Prende l'HTML grezzo di un'email, lo pulisce, lo ottimizza per la lettura
    e lo inserisce in un documento HTML completo e sicuro.
    """
    soup = BeautifulSoup(body_html, 'html.parser')

    # 1. Riscrivi tutte le immagini (http, https, cid) per usare il proxy
    for img in soup.find_all('img'):
        src = img.get('src', '').strip()
        if src.startswith('cid:'):
            cid = src[4:]
            img['src'] = f"/api/gmail/messages/{msg_id}/cid/{cid}"
        elif src.startswith('http'):
            img['src'] = f"/api/img?u={quote(src, safe='')}"
            img['referrerpolicy'] = 'no-referrer'
            img['loading'] = 'lazy'
            # hardening: rimuovi eventuali handler inline
            for attr in list(img.attrs):
                if attr.lower().startswith('on'):
                    del img[attr]
        # Rimuovi attributi di tracking
        img.attrs = {k: v for k, v in img.attrs.items() if k in ['src', 'alt', 'title', 'width', 'height', 'style']}

    # 2. Comprimi le citazioni di Gmail usando <details>
    for quote in soup.select('blockquote, .gmail_quote'):
        details = soup.new_tag('details', attrs={'class': 'email-quote'})
        summary = soup.new_tag('summary')
        summary.string = "Mostra citazione"
        details.append(summary)
        quote.wrap(details)

    safe_body = bleach.clean(
        str(soup),
        tags=ALLOWED_TAGS + ['details', 'summary', 'table', 'tr', 'td', 'th', 'tbody', 'thead'],
        attributes={**ALLOWED_ATTRS, '*': ['class']},
        strip=True
    )

    styles = """
    :root { color-scheme: light dark; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        margin: 0 auto; padding: 24px; max-width: 720px;
        font-size: 17px; line-height: 1.7; color: #202124;
        background-color: #ffffff; word-wrap: break-word;
    }
    img, video { max-width: 100%; height: auto; }
    table { max-width: 100%; border-collapse: collapse; border: 1px solid #e0e0e0; }
    td, th { padding: 8px; border: 1px solid #e0e0e0; }
    a { color: #1a73e8; text-decoration: underline; }
    pre, code { white-space: pre-wrap; font-family: monospace; }
    .email-quote summary { cursor: pointer; color: #5f6368; font-size: 14px; padding: 8px 0; }
    @media (prefers-color-scheme: dark) {
        body { background-color: #121212; color: #e8eaed; }
        a { color: #8ab4f8; }
        table, td, th { border-color: #444; }
        .email-quote summary { color: #9aa0a6; }
    }
    """

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email</title>
  <style>{styles}</style>
</head>
<body>{safe_body}</body>
</html>"""

@router_api.post("/feed/{email_id}/type")
async def set_type_and_override(email_id: str, payload: dict, request: Request):
    uid = _current_user_id(request)
    t = (payload.get("type_tag") or "").lower().strip()
    if t not in {"newsletter", "promo", "personali", "informative"}:
        raise HTTPException(status_code=400, detail="Invalid type_tag")

    try:
        n = Newsletter.get((Newsletter.email_id == email_id) & (Newsletter.user_id == uid))
    except Newsletter.DoesNotExist:
        raise HTTPException(status_code=404, detail="Newsletter not found")

    # --- INIZIO FIX ---
    # Trova il dominio in modo robusto, con fallback e normalizzazione
    domain = None
    if n.sender_email:
        domain = n.sender_email.split('@')[-1].lower()
    elif n.source_domain:
        domain = n.source_domain.lower()
    # --- FINE FIX ---

    # 1. Salva il tipo sulla singola mail
    n.type_tag = t
    n.save()

    # 2. Salva/Aggiorna la regola per il dominio (specifica per l'utente)
    if domain:
        DomainTypeOverride.insert(user_id=uid, domain=domain, type_tag=t).on_conflict(
            conflict_target=[DomainTypeOverride.user_id, DomainTypeOverride.domain],
            update={DomainTypeOverride.type_tag: t}
        ).execute()
        
        # 3. Aggiorna in batch tutte le altre email dello stesso utente e dominio
        (Newsletter.update(type_tag=t)
         .where((Newsletter.user_id == uid) &
                ((Newsletter.sender_email.endswith("@" + domain)) | (Newsletter.source_domain == domain)))
         .execute())

    return {"ok": True, "email_id": email_id, "domain": domain, "type_tag": t}

@router_api.get("/gmail/thread-url/{msg_id}")
def get_gmail_thread_url(msg_id: str, request: Request):
    """
    Dato un ID di messaggio, restituisce l'URL diretto per aprirlo in Gmail.
    """
    svc = _gmail_service_for(request)
    try:
        # Recupera il messaggio per ottenere il suo threadId
        msg = svc.users().messages().get(userId='me', id=msg_id, format='metadata').execute()
        thread_id = msg.get('threadId')
        if not thread_id:
            raise HTTPException(status_code=404, detail="Thread ID non trovato per questo messaggio.")

        # Costruisce l'URL di Gmail. u/0/ è l'indice dell'account, di solito 0 per il primo.
        # Usare #all invece di #inbox è più robusto se l'email è stata archiviata.
        gmail_url = f"https://mail.google.com/mail/u/0/#all/{thread_id}"
        
        return {"url": gmail_url}

    except HttpError as e:
        raise HTTPException(status_code=e.resp.status, detail="Impossibile recuperare i dati del messaggio da Gmail.")
    except Exception as e:
        logging.error(f"Errore nella creazione dell'URL di Gmail: {e}")
        raise HTTPException(status_code=500, detail="Errore interno del server.")
    
@app.get("/api/gmail/messages/{msg_id}/view", response_class=HTMLResponse)
def gmail_message_view(msg_id: str, request: Request):
    """
    Endpoint dedicato alla lettura. Restituisce un documento HTML completo,
    sanificato e ottimizzato per essere visualizzato in un <iframe>.
    """
    svc = _gmail_service_for(request)
    try:
        msg = svc.users().messages().get(userId='me', id=msg_id, format='full').execute()
    except HttpError as e:
        raise HTTPException(status_code=e.resp.status, detail="Impossibile recuperare il messaggio da Gmail.")

    html_content = extract_html_from_payload(msg.get('payload', {}))
    if not html_content:
        # Fallback a testo semplice se non c'è HTML
        txt_content = _decode_body(next((p for p in _walk_parts(msg.get('payload', {})) if p.get("mimeType") == "text/plain"), None))
        html_content = f"<pre>{html_escape(txt_content)}</pre>"

    final_html = create_reader_view_html(html_content, msg_id)

    # Imposta header di sicurezza e caching
    headers = {
            "Content-Security-Policy":
                "default-src 'none'; "
                "img-src http: https: data: blob:; "
                "style-src 'unsafe-inline'; "
                "font-src http: https: data:; "
                "media-src http: https: data:; "
                "connect-src 'none'; "
                "object-src 'none'; "
                "base-uri 'none'; "
                "form-action 'none'; "
                "frame-ancestors 'self';",
            "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
            "ETag": f'W/"{hashlib.sha1(final_html.encode("utf-8")).hexdigest()}"',
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
        }
    final_html = _sanitize_view_html(final_html)
    return HTMLResponse(content=final_html, headers=headers)

def clean_text_for_ai(html_content: str) -> str:
    """Pulisce l'HTML, rimuove disclaimer/firme e lo tronca."""
    if not html_content:
        return ""
    
    # Rimuovi disclaimer e firme comuni con regex (case-insensitive)
    patterns = [
        r'unsubscribe from this list',
        r'view in browser',
        r'questo messaggio è confidenziale',
        r'non rispondere a questa email',
        r'sent from my iphone',
    ]
    text = html_content
    for pattern in patterns:
        text = re.sub(pattern, '', text, flags=re.IGNORECASE)

    # Pulizia HTML di base
    soup = BeautifulSoup(text, 'html.parser')
    for element in soup(["script", "style", "head", "title", "meta", "header", "footer", "nav", "form"]):
        element.extract()
    
    return ' '.join(soup.get_text(separator=' ', strip=True).split())

def load_credentials_store():
    global CREDENTIALS_STORE
    if os.path.exists(CREDENTIALS_PATH):
        try:
            with open(CREDENTIALS_PATH, "r", encoding="utf-8") as f:
                CREDENTIALS_STORE = json.load(f)
                logging.info(f"[CREDENTIALS] Caricate {len(CREDENTIALS_STORE)} credenziali da file.")
        except Exception as e:
            logging.warning(f"[CREDENTIALS] Impossibile caricare le credenziali: {e}")
            CREDENTIALS_STORE = {}
    else:
        CREDENTIALS_STORE = {}

def save_credentials_store() -> None:
    try:
        # Definisci il percorso del file temporaneo
        tmp_path = CREDENTIALS_PATH + ".tmp"

        # 1. Scrivi i dati nel file temporaneo
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(CREDENTIALS_STORE, f, ensure_ascii=False, indent=2)

        # 2. Rinomina atomicamente il file temporaneo a quello definitivo
        # Questa operazione è molto più veloce e sicura di una scrittura diretta.
        os.replace(tmp_path, CREDENTIALS_PATH)

        # 3. Tenta di impostare permessi restrittivi (best-effort)
        try:
            # Imposta i permessi a lettura/scrittura solo per il proprietario
            os.chmod(CREDENTIALS_PATH, 0o600)
        except (OSError, AttributeError):
            # Ignora l'errore: non è critico se fallisce (es. su Windows
            # o in ambienti con permessi limitati).
            pass

    except Exception as e:
        # Se qualcosa va storto durante la scrittura o la rinomina, logga l'errore.
        # Il file originale non sarà stato toccato.
        logging.error(f"[CREDENTIALS] Salvataggio credenziali fallito: {e}")

def _get_pending_auth_key(sid: str) -> str:
    """Restituisce la chiave Redis per un dato session ID."""
    return f"pending_auth:{sid}"

def _pending_auth(request: Request) -> dict:
    """Ritorna la mappa pending per il sid corrente (in-memory, non in cookie)."""
    sid = request.session.get("sid")
    if not sid:
        sid = str(uuid.uuid4())
        request.session["sid"] = sid
    return PENDING_AUTH.setdefault(sid, {})

def _save_pending_auth(request: Request, data: dict):
    sid = request.session.get("sid")
    if not sid: return
    ok = False
    if redis_client:
        try:
            redis_client.set(_get_pending_auth_key(sid), json.dumps(data), ex=AUTH_PENDING_TTL)
            ok = True
        except Exception as e:
            logging.error(f"[AUTH] redis set failed: {e}")
    # fallback sempre
    request.session["pending_auth"] = data
    logging.info(f"[AUTH] save_pending_auth sid={sid} via={'redis+session' if ok else 'session-only'} keys={list(data.keys())}")

def _cleanup_pending_auth(request: Request):
    """
    Non fa più nulla. La pulizia è gestita automaticamente dal TTL di Redis.
    Manteniamo la funzione per non rompere le chiamate esistenti.
    """
    pass

def _gmail_service_for(request: Request):
    # Usa sempre l'user_id salvato in sessione (non più il sid)
    user_id = get_user_id_from_session(request)
    if not user_id or user_id == "anonymous":
        raise HTTPException(status_code=401, detail="Non autenticato")

    creds_dict = CREDENTIALS_STORE.get(user_id)

    # Fallback di migrazione: se in passato avevi salvato su 'sid', prova a recuperare e migrare
    if not creds_dict:
        sid = request.session.get("sid")
        old = CREDENTIALS_STORE.get(sid or "")
        if old:
            creds_dict = old
            # migra le credenziali alla chiave user_id e salva su disco
            CREDENTIALS_STORE[user_id] = old
            CREDENTIALS_STORE.pop(sid, None)
            save_credentials_store()

    if not creds_dict:
        raise HTTPException(status_code=401, detail="Credenziali mancanti. Esegui di nuovo il login.")

    creds = Credentials.from_authorized_user_info(creds_dict, SCOPES)

    # Refresh trasparente se necessario
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GoogleAuthRequest())
            CREDENTIALS_STORE[user_id] = json.loads(creds.to_json())
            save_credentials_store()
        except Exception as e:
            logging.warning(f"[GMAIL] Refresh token fallito per {user_id}: {e}")
            raise HTTPException(status_code=401, detail="Sessione scaduta. Esegui di nuovo il login.")

    return build("gmail", "v1", credentials=creds, cache_discovery=False)

def _extract_json_from_string(text: str) -> str:
    """Estrae il primo oggetto JSON da una stringa, rispettando virgolette e caratteri di escape."""
    if not text: return ""
    start = text.find("{")
    if start == -1: return ""
    depth, in_string, escaped = 0, False, False
    for i, char in enumerate(text[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return ""

def _extract_output_text(d: dict) -> str | None:
    """Estrae il testo utile dalla risposta dell'API /v1/responses."""
    if not isinstance(d, dict):
        return None

    # --- NUOVO: Percorso primario per l'API /v1/responses ---
    # Cerca in output -> message -> content -> {type: "output_text"} -> text
    try:
        for item in d.get("output", []):
            if item.get("type") == "message":
                for content_part in item.get("content", []):
                    if content_part.get("type") == "output_text":
                        text = content_part.get("text")
                        if isinstance(text, str) and text.strip():
                            return text
    except (TypeError, AttributeError):
        pass # Ignora errori se la struttura non corrisponde

    # --- VECCHI FALLBACK (mantenuti per robustezza) ---
    # 1) Testo diretto
    txt = d.get("text")
    if isinstance(txt, str) and txt.strip():
        return txt

    # 2) Chiavi legacy
    for k in ("output_text", "content"):
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v

    # 3) Vecchio formato chat.completions
    ch = d.get("choices")
    if isinstance(ch, list) and ch:
        msg = (ch[0] or {}).get("message") or {}
        if isinstance(msg.get("content"), str):
            return msg["content"]
    
    return None

def _cheap_fallback_keyword_from_text(text: str) -> str:
    """Estrae una parola “concreta” ricorrente dal testo pulito."""
    if not text:
        return "newsletter"

    # Set di parole comuni o generiche da ignorare.
    # Include termini italiani, inglesi e specifici del dominio "newsletter".
    STOP_WORDS = {
        "questo", "questa", "queste", "quello", "quella", "quelle", "oltre",
        "dalla", "dalle", "dello", "della", "delle", "comunque", "sempre",
        "ancora", "mentre", "dopo", "prima", "entro", "anche", "solo", "molto",
        "poche", "poco", "tanto", "nella", "nelle", "negli", "dove", "quando",
        "quale", "quali", "oggi", "ieri", "domani", "settimana", "mese",
        "about", "there", "their", "which", "while", "after", "before", "still",
        "always", "today", "yesterday", "tomorrow", "email", "mail", "contenuto",
        "contenuti", "newsletter", "notizie", "news", "aggiornamenti", "update",
        "blog", "articolo", "article", "report"
    }

    # 1. Tokenizza il testo: trova tutte le parole di almeno 5 caratteri
    #    che contengono lettere latine, inclusi gli accenti.
    #    Il testo viene prima convertito in minuscolo per uniformità.
    tokens = re.findall(r"[a-zà-öø-ÿ]{5,}", text.lower())

    # 2. Filtra i token rimuovendo le stop words.
    candidates = [word for word in tokens if word not in STOP_WORDS]

    # 3. Se non rimangono parole candidate, restituisci il fallback predefinito.
    if not candidates:
        return "newsletter"

    # 4. Altrimenti, conta la frequenza delle parole rimanenti e restituisci la più comune.
    #    Counter(...).most_common(1) restituisce una lista con una tupla: [('parola', conteggio)]
    most_common_word, _ = Counter(candidates).most_common(1)[0]
    
    return most_common_word

def _current_user_id(request: Request) -> str:
    uid = get_user_id_from_session(request)
    if not uid or uid == "anonymous":
        raise HTTPException(status_code=401, detail="Utente non autenticato.")
    return uid

def _user_pool(uid: str) -> list[dict]:
    return PHOTOS_POOLS.setdefault(uid, [])

def _user_bearer(uid: str) -> str | None:
    return PHOTOS_BEARERS.get(uid)

def _pkey(photo_id: str, w: int, h: int, mode: str) -> str:
    return f"{photo_id}:{w}:{h}:{mode}"

def _photos_cache_get(k: str):
    ent = photos_cache.get(k)
    if not ent:
        return None
    if (time.time() - ent["ts"]) > PHOTOS_CACHE_TTL:
        photos_cache.pop(k, None)
        return None
    photos_cache.move_to_end(k, last=True)
    return ent

def _photos_cache_put(k: str, ent: dict):
    photos_cache[k] = ent
    photos_cache.move_to_end(k, last=True)
    while len(photos_cache) > PHOTOS_CACHE_MAX_ITEMS:
        photos_cache.popitem(last=False)

# R2_PUBLIC_BASE_URL è già definita nel file: lo riutilizziamo per la whitelist
def _host_or_none(u: str) -> str | None:
    try:
        return urlparse(u).hostname
    except Exception:
        return None

IMG_ALLOWED_HOSTS = {h for h in [
    _host_or_none(R2_PUBLIC_BASE_URL),
    "picsum.photos",   # usato nel fallback front-end
    "pixabay.com", "cdn.pixabay.com",  # permetti proxy di immagini dirette quando R2 non c'è
    "images.unsplash.com",
    "i.imgur.com",
    "lh3.googleusercontent.com",
] if h}

image_cache = OrderedDict()  # url -> {"ts": float, "bytes": bytes, "ct": str, "etag": str|None}

def _cache_get(url: str) -> dict | None:
    """Recupera un'immagine dalla cache se è valida."""
    ent = image_cache.get(url)
    if not ent:
        return None
    # Rimuovi se scaduta (TTL è in IMG_PROXY_TTL)
    if (time.time() - ent["ts"]) > IMG_PROXY_TTL:
        image_cache.pop(url, None)
        return None
    # Sposta in cima per la logica LRU (Least Recently Used)
    image_cache.move_to_end(url, last=True)
    return ent

def _cache_put(url: str, ent: dict):
    """Aggiunge un'immagine alla cache e rimuove gli elementi più vecchi se necessario."""
    image_cache[url] = ent
    image_cache.move_to_end(url, last=True)
    # Mantieni la cache entro i limiti di dimensione
    while len(image_cache) > IMG_PROXY_MAX_ITEMS:
        image_cache.popitem(last=False)

def _is_private_host(host: str) -> bool:
    if not host: return True
    host_l = host.lower()
    if host_l in {"localhost"} or host_l.endswith(".local"): return True
    try:
        ip_obj = ipaddress.ip_address(host)
        return ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local
    except ValueError:
        # Se non è un IP, procedi con la risoluzione DNS
        pass
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        for ai in infos:
            ip_obj = ipaddress.ip_address(ai[4][0])
            if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local:
                logging.warning(f"[PROXY] Bloccato tentativo di accesso a IP privato: {host} -> {ai[4][0]}")
                return True
    except socket.gaierror:
        logging.warning(f"[PROXY] Impossibile risolvere l'host: {host}")
        return True
    return False

def _r2_client():
    if not (R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and R2_BUCKET and R2_PUBLIC_BASE_URL):
        raise RuntimeError("Config R2 incompleta. Verifica ENV R2_*")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )

# Lazy init: R2 è opzionale. Crealo solo al primo uso.
_R2_CLIENT = None
def _get_r2():
    global _R2_CLIENT
    if _R2_CLIENT is None:
        try:
            _R2_CLIENT = _r2_client()
        except Exception as e:
            logging.warning("[R2] client non disponibile o config mancante: %s", e)
            _R2_CLIENT = None
    return _R2_CLIENT

PIXABAY_KW_CACHE: dict[str, tuple[float, str]] = {}  # {kw_lower: (ts, cdn_url)}
KW_CACHE_TTL = 24 * 3600
RECENT_PXB_IDS = deque(maxlen=200)


def load_settings_store():
    global SETTINGS_STORE
    if os.path.exists(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                SETTINGS_STORE = json.load(f)
        except Exception:
            SETTINGS_STORE = {}
    else:
        SETTINGS_STORE = {}


def save_settings_store():
    try:
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(SETTINGS_STORE, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def slugify_kw(s: str) -> str:
    s = re.sub(r"\s+", " ", (s or "").strip().lower())
    s = s.replace("&", " e ")
    s = re.sub(r"[^a-z0-9\- ]", "", s)
    s = s.replace(" ", "-")
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or "news"

def r2_public_url(key: str) -> str:
    return f"{R2_PUBLIC_BASE_URL}/{key.lstrip('/')}"

def make_r2_key_from_kw(keyword: str, ext: str = "jpg") -> str:
    ts = datetime.utcnow()
    slug = slugify_kw(keyword)
    return f"{ts:%Y/%m}/{uuid.uuid4().hex}_{slug}.{ext}"

def upload_bytes_to_r2(data: bytes, key: str, content_type: str = "image/jpeg") -> str:
    r2 = _get_r2()
    if r2 is None:
        raise RuntimeError("R2 non configurato (manca ENV R2_*)")
    r2.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    return r2_public_url(key)

def placeholder_svg_bytes(text: str = "newsletter") -> tuple[bytes, str]:
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
<rect width="100%" height="100%" fill="#f2f2f2"/>
<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
      font-family="Inter,system-ui,Segoe UI,Arial" font-size="72" fill="#777">{text}</text>
</svg>'''
    return svg.encode("utf-8"), "image/svg+xml"


def get_user_id_from_session(request) -> str:
    """
    Ricava un identificatore utente (es. email). Adatta questa funzione
    al modo in cui salvi l’utente in sessione.
    """
    # Esempio: se salvi l'email in request.session["user_email"]
    # oppure se usi un dict request.state.user etc.
    try:
        user_id = request.session.get("user_id")
        return user_id or "anonymous"
    except Exception:
        return "anonymous"

@app.middleware("http")
async def add_request_id(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = rid
    start = time.perf_counter()
    try:
        resp = await call_next(request)
        dur_ms = int((time.perf_counter() - start) * 1000)
        resp.headers["X-Request-Id"] = str(rid)
        logging.info(json.dumps({
            "type": "http_request",
            "rid": str(rid),
            "method": request.method,
            "path": request.url.path,
            "query": str(request.url.query),
            "status": resp.status_code,
            "dur_ms": dur_ms
        }))
        return resp
    except Exception as e:
        logging.exception(f"[req {rid}] unhandled backend error")
        raise

app.add_middleware(GZipMiddleware, minimum_size=1000)

def _iso_utc(value):
    """Rende una stringa ISO-8601 in UTC da datetime o stringa ISO-like."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, str):
        try:
            s = value.strip()
            # supporta formati "2025-09-21T22:23:00Z" o con offset
            if s.endswith("Z"):
                s = s.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return value  # se non parsabile, restituisci com’è
    return str(value)


@app.get("/api/feed/item/{email_id}")
async def get_feed_item(email_id: str, request: Request):
    """Restituisce i dati completi di un singolo elemento del feed (solo del proprietario)."""
    uid = _current_user_id(request)
    try:
        n = (Newsletter
             .select()
             .where((Newsletter.email_id == email_id) & (Newsletter.user_id == uid))
             .get())
    except Newsletter.DoesNotExist:
        raise HTTPException(status_code=404, detail="Item not found")

    item = {
        "id": n.id,
        "email_id": n.email_id,
        "user_id": n.user_id,
        "sender_name": n.sender_name,
        "sender_email": n.sender_email,
        "subject": n.original_subject,  # <-- CORREZIONE CHIAVE
        "received_date": _iso_utc(n.received_date),
        "ai_title": n.ai_title,
        "ai_summary_markdown": n.ai_summary_markdown,
        "image_url": n.image_url,
        "accent_hex": n.accent_hex,
        "is_favorite": n.is_favorite,
        "is_complete": n.is_complete,
        "tag": n.tag,
        "type_tag": n.type_tag,
        "topic_tag": n.topic_tag,
        "source_domain": n.source_domain,
        "thread_id": n.thread_id,
        "rfc822_message_id": n.rfc822_message_id,
    }
    item = _add_gmail_deep_link_fields(item)
    return JSONResponse(item)

    
@app.get("/api/img")
async def api_img(request: Request, u: str = Query(..., description="URL assoluto dell'immagine")):
    return await proxy_image(u, request)

async def proxy_image(u: str, request: Request):
    """
    Proxy per immagini con cache in memoria, retry con backoff esponenziale,
    e gestione degli header di caching.
    """
    url = unquote(u)
    
    # Controllo di sicurezza per evitare loop
    if "/api/img" in url:
        raise HTTPException(status_code=400, detail="Loop di proxy rilevato")

    # Controlla prima la cache
    cached_item = _cache_get(url)
    if cached_item:
        inm = (request.headers.get("if-none-match") or "").strip()
        if inm and cached_item.get("etag") and inm == cached_item["etag"]:
            return Response(status_code=304, headers={
                "ETag": inm,
                "Cache-Control": "public, max-age=31536000, immutable"
            })
        
        headers = {
            "Content-Type": cached_item["ct"],
            "Cache-Control": f"public, max-age={IMG_PROXY_TTL}, immutable",
            "ETag": cached_item.get("etag") or "",
            "X-Cache-Status": "HIT"
        }
        return Response(content=cached_item["bytes"], headers=headers)

    # Validazione dell'URL
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ("http", "https"):
            raise HTTPException(status_code=400, detail="Schema non supportato")
        if not parsed.hostname or _is_private_host(parsed.hostname):
            raise HTTPException(status_code=400, detail="Host non consentito")
    except Exception:
        raise HTTPException(status_code=400, detail="URL non valido")

    # Logica di Retry con Backoff
    backoffs = [0.2, 0.6, 1.4]  # Secondi di attesa tra i tentativi
    last_error = None

    for i, wait in enumerate(backoffs):
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
                r = await client.get(url, headers={"User-Agent": "NewsletterFeedProxy/1.0"})
            
            # Se la richiesta ha successo (200 OK)
            if r.status_code == 200:
                content = r.content
                if len(content) > IMG_PROXY_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="Immagine troppo grande")

                ct = r.headers.get("content-type", "application/octet-stream").split(";", 1)[0].strip().lower()
                if not ct.startswith("image/"):
                    raise HTTPException(status_code=415, detail="Content-Type non supportato")

                etag = f'W/"{hashlib.sha1(content).hexdigest()}"'
                
                # Salva nella cache in memoria
                _cache_put(url, {"ts": time.time(), "bytes": content, "ct": ct, "etag": etag})
                
                # Restituisci la risposta al client
                response_headers = {
                    "Content-Type": ct,
                    "Cache-Control": f"public, max-age={IMG_PROXY_TTL}, immutable",
                    "ETag": etag,
                    "X-Cache-Status": "MISS"
                }
                return Response(content=content, headers=response_headers)

            # Se l'errore è temporaneo (429, 5xx), ritenta
            if r.status_code in {429, 500, 502, 503, 504}:
                logging.warning(f"[PROXY] Errore temporaneo {r.status_code} per {url}. Riprovo tra {wait:.1f}s...")
                last_error = f"Upstream error: {r.status_code}"
                await asyncio.sleep(wait + random.uniform(0, 0.2))
                continue
            
            # Se l'errore non è recuperabile (es. 404 Not Found), esci subito
            last_error = f"Upstream client error: {r.status_code}"
            break

        except httpx.RequestError as e:
            logging.warning(f"[PROXY] Errore di rete per {url}: {e}. Riprovo tra {wait:.1f}s...")
            last_error = f"Network error: {e}"
            await asyncio.sleep(wait + random.uniform(0, 0.2))
    
    # Se tutti i tentativi falliscono, restituisci un errore 502
    raise HTTPException(status_code=502, detail=last_error or "Impossibile recuperare l'immagine upstream")


@app.get("/api/gmail/messages/{msg_id}/html")
def gmail_message_html(msg_id: str, request: Request):
    svc = _gmail_service_for(request)
    msg = svc.users().messages().get(userId='me', id=msg_id, format='full').execute()
    payload = msg.get('payload', {}) or {}

    html = None
    had_html = False
    
    # Non è più necessaria una cid_map qui, dato che non viene usata
    # cid_map = {} 

    for p in _walk_parts(payload):
        mime = (p.get('mimeType') or '').lower()
        if mime == 'text/html' and html is None:
            html = _decode_body(p)
            had_html = True
            # Trovato l'HTML, possiamo interrompere il ciclo prima
            break 
    
    # Fallback a testo semplice se non è stato trovato HTML
    if not html:
        txt = None
        for p in _walk_parts(payload):
            if (p.get('mimeType') or '').lower() == 'text/plain':
                txt = _decode_body(p)
                break
        # html_escape è corretto qui, previene l'interpretazione di HTML nel testo semplice
        html = f"<pre style='white-space:pre-wrap;font:14px/1.5 system-ui'>{html_escape(txt or '')}</pre>"
        # Questo blocco è già sicuro, quindi non necessita di ulteriore sanificazione
    
    # --- Modifiche di Sicurezza Applicate Qui ---
    
    # Helper per la sostituzione
    def _replace_cid(m):
        # Pulisci il CID catturato da eventuali caratteri indesiderati
        cid = m.group(1).strip()
        return f"/api/gmail/messages/{msg_id}/cid/{cid}"

    # 1. Sostituisci i CID con una regex più robusta che gestisce i "<>" opzionali
    # Questo viene fatto PRIMA della sanificazione, così bleach può validare i percorsi relativi
    if had_html: # Applica solo se l'origine è vero HTML
        html = re.sub(r'cid:<?([^>\s"\'@]+@[^>\s"\']+)>?', _replace_cid, html)
        html = re.sub(r'cid:<?([^>\s"\']+)?>?', _replace_cid, html)


        # 2. Sanifica l'HTML per rimuovere script e tag pericolosi
        html = sanitize_html(html)
        html = enforce_safe_anchor_rel(html)

    return {"html": html, "had_html": had_html}


@app.get("/api/gmail/messages/{msg_id}/cid/{cid}")
def gmail_message_cid(msg_id: str, cid: str, request: Request):
    svc = _gmail_service_for(request)
    msg = svc.users().messages().get(userId='me', id=msg_id, format='full').execute()
    payload = msg.get('payload', {}) or {}

    # trova attachmentId corrispondente al Content-ID richiesto
    target_att = None
    ctype = "application/octet-stream"
    for p in _walk_parts(payload):
        headers = {h['name'].lower(): h['value'] for h in (p.get('headers') or [])}
        content_id = (headers.get('content-id') or '').strip().strip('<>')
        if content_id == cid:
            att_id = (p.get('body') or {}).get('attachmentId')
            if att_id:
                target_att = att_id
                ctype = (headers.get('content-type') or ctype).split(';', 1)[0]
                break

    if not target_att:
        raise HTTPException(404, "CID non trovato")

    att = svc.users().messages().attachments().get(
        userId='me', messageId=msg_id, id=target_att
    ).execute()
    data = b64_urlsafe_decode(att.get('data') or '')
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control":"public,max-age=31536000,immutable"})

SESSION_DOMAIN = os.getenv("SESSION_DOMAIN")  # es: ".thegist.tech"
IS_PROD = bool(SESSION_DOMAIN)

REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:8000/auth/callback")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
FRONTEND_ORIGINS = [
    FRONTEND_ORIGIN,
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:8000",
]
SESSION_HTTPS_ONLY = os.getenv("SESSION_HTTPS_ONLY", "False").strip().lower() in {"true","1","t","yes","y"}

logging.info("[CFG] REDIRECT_URI: %s", REDIRECT_URI)
logging.info("[CFG] FRONTEND_ORIGIN: %s", FRONTEND_ORIGIN)
logging.info("[CFG] SESSION_HTTPS_ONLY: %s", SESSION_HTTPS_ONLY)

# ⬇️ middleware DOPO aver creato l’app
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SESSION_SECRET", "dev-secret"),
    session_cookie="nl_sess",
    same_site="lax",
    https_only=SESSION_HTTPS_ONLY,
    max_age=60*60*24*7,
    domain=SESSION_DOMAIN if IS_PROD else None,
)

FRONTEND_ORIGINS = [
    os.getenv("FRONTEND_ORIGIN", "https://app.thegist.tech"),
    "http://localhost:5173",
    "http://localhost:3000",
    "http://localhost:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,   # lista già pronta
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Next-Cursor", "X-Has-More", "X-Items"],
)

# --- COSTANTI E VARIABILI GLOBALI ---
CLIENT_SECRETS_FILE = str(Path(__file__).resolve().parent / "credentials.json")
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly",
]
PHOTOS_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"
PHOTOS_PICKER_SESSIONS_URL = "https://photospicker.googleapis.com/v1/sessions"

openai.api_key = os.getenv("OPENAI_API_KEY")
logging.info("Configurazione iniziale caricata.")
from typing import Optional, List


class UserSettingsIn(BaseModel):
    preferred_image_source: t.Optional[str] = Field(default=None, description="pixabay | google_photos")
    hidden_domains: t.Optional[list[str]] = Field(default=None, description="lista domini da nascondere")

@router_api.get("/auth/me")  # Spostato su router_api per mantenere il prefisso /api
async def auth_me(request: Request):
    user_id = request.session.get("user_id")
    email = request.session.get("user_email")

    if not user_id or user_id not in CREDENTIALS_STORE:
        return JSONResponse({"email": None, "logged_in": False}, status_code=401)

    return {"email": email, "logged_in": True}

@router_settings.get("")
def get_settings(request: Request):
    user_id = get_user_id_from_session(request)
    settings = SETTINGS_STORE.get(user_id, {
        "preferred_image_source": "pixabay",
        "hidden_domains": []
    })
    return {
        "preferred_image_source": settings.get("preferred_image_source", "pixabay"),
        "hidden_domains": settings.get("hidden_domains", []),
        "user_id": user_id
    }

@app.get("/api/ingest/status/{job_id}")
async def ingest_status(job_id: str):
    st = INGEST_JOBS.get(job_id)
    if not st:
        raise HTTPException(404, "Job non trovato")
    return st

@router_settings.post("")
def update_settings(payload: UserSettingsIn, request: Request):
    user_id = get_user_id_from_session(request)
    current = SETTINGS_STORE.get(user_id, {
        "preferred_image_source": "pixabay",
        "hidden_domains": []
    })

    # aggiorna solo i campi presenti
    if payload.preferred_image_source is not None:
        # normalizza
        src = payload.preferred_image_source.strip().lower()
        if src not in ("pixabay", "google_photos"):
            src = "pixabay"
        current["preferred_image_source"] = src

    if payload.hidden_domains is not None:
        # normalizza i domini
        doms = [d.strip().lower() for d in payload.hidden_domains if d.strip()]
        current["hidden_domains"] = doms

    SETTINGS_STORE[user_id] = current
    save_settings_store()
    return {"ok": True, "settings": current}
    
app.include_router(router_settings)
app.include_router(router_auth)
app.include_router(router_api)

@app.get("/api/photos/pool/debug")
async def debug_photos_pool(request: Request):
    uid = _current_user_id(request)
    pool = _user_pool(uid)
    sample = pool[:5]
    return JSONResponse({"user_id": uid, "pool_size": len(pool), "sample": sample})

@app.get("/api/photos/proxy/{photo_id}")
async def proxy_photo(photo_id: str, request: Request, w: int = 1600, h: int = 900, mode: str = "no"):
    uid = _current_user_id(request)
    pool = _user_pool(uid)
    bearer = _user_bearer(uid)

    item = next((x for x in pool if (x.get("id") == photo_id)), None)
    if not item:
        raise HTTPException(status_code=404, detail="Foto non trovata in pool")

    base = (item.get("baseUrl") or "").strip()
    auth = (item.get("authUrl") or "").strip()
    suffix = f"=w{w}-h{h}-{mode}"

    key = f"{uid}:{photo_id}:{w}:{h}:{mode}"  # cache separata per utente
    hit = _photos_cache_get(key)
    if hit:
        return StreamingResponse(
            io.BytesIO(hit["bytes"]),
            media_type=hit["ct"],
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Cache": "HIT",
                "Access-Control-Allow-Origin": "*",
            },
        )
        
    urls_and_modes: list[tuple[str, dict]] = []
    if base: 
        urls_and_modes.append((base + suffix, {}))
    if base and bearer: 
        urls_and_modes.append((base + suffix, {"Authorization": bearer}))
    if base and bearer: 
        urls_and_modes.append((base, {"Authorization": bearer}))
    if base and bearer:
        sep = "&" if "?" in base else "?"
        urls_and_modes.append((base + f"{sep}alt=media", {"Authorization": bearer}))
    if auth and bearer:
        urls_and_modes.append((auth, {"Authorization": bearer}))

    tried = []
    async with httpx.AsyncClient(timeout=20.0) as c:
        for url, headers in urls_and_modes:
            r = await c.get(url, headers=headers, follow_redirects=True)
            tried.append((url, r.status_code))
            if r.headers.get("Content-Length") and int(r.headers["Content-Length"]) > IMG_PROXY_MAX_BYTES:
                raise HTTPException(413, "Immagine troppo grande")

            if r.status_code == 200:
                ct = r.headers.get("Content-Type", "image/jpeg")
                body = r.content
                _photos_cache_put(key, {"ts": time.time(), "bytes": body, "ct": ct})
                return StreamingResponse(io.BytesIO(body), media_type=ct,
                                         headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Cache": "MISS"})
    logging.warning("[BACKEND] proxy fallito. Tentativi: %s", tried)
    raise HTTPException(status_code=502, detail="Impossibile recuperare l'immagine dal provider")

@app.get("/api/photos/albums")
async def list_albums(authorization: str = Header(None), page_size: int = 50):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manca Authorization: Bearer <token>")
    url = "https://photoslibrary.googleapis.com/v1/albums"
    params = {"pageSize": min(page_size, 50)}
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.get(url, params=params, headers={"Authorization": authorization})
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()

class ImportLatestBody(BaseModel):
    limit: int = 500
    mode: t.Optional[str] = "replace"  # "replace" oppure "append"

@app.post("/api/log", status_code=204)
async def receive_log(log_entry: LogEntry):
    """
    Endpoint per ricevere log dal frontend e scriverli nel file di log del backend.
    """
    # Usa un logger specifico per i log del browser per distinguerli
    browser_logger = logging.getLogger("BROWSER")
    
    # Mappa i livelli di log (opzionale ma utile)
    level_map = {
        "error": logging.ERROR,
        "warn": logging.WARNING,
        "info": logging.INFO,
        "debug": logging.DEBUG
    }
    log_level = level_map.get(log_entry.level.lower(), logging.INFO)
    
    browser_logger.log(log_level, log_entry.message)

@app.post("/api/photos/import/latest")
async def import_latest(body: ImportLatestBody, request: Request, authorization: str = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manca Authorization: Bearer <token>")
    uid = _current_user_id(request)
    PHOTOS_BEARERS[uid] = authorization

    pool = _user_pool(uid)
    url = "https://photoslibrary.googleapis.com/v1/mediaItems"
    params = {"pageSize": min(max(body.limit, 1), 100)}
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.get(url, params=params, headers={"Authorization": authorization})
    if r.status_code != 200:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    if (body.mode or "append") == "replace":
        PHOTOS_POOLS[uid] = []
        pool = _user_pool(uid)

    added = 0
    for mi in (r.json().get("mediaItems") or []):
        base_url = _pick_base_url(mi)
        if not base_url: 
            continue
        mf = mi.get("mediaFile") or mi.get("media_file") or {}
        auth_url = (mf.get("downloadUrl") or mf.get("download_url") or
                    (mf.get("image") or {}).get("downloadUrl") or
                    (mf.get("photo") or {}).get("downloadUrl"))
        pool.append({
            "id": mi.get("id"),
            "baseUrl": base_url,
            "authUrl": auth_url,
            "mimeType": mi.get("mimeType"),
            "filename": mi.get("filename"),
        })
        added += 1
    return {"ok": True, "cached": added, "pool_size": len(pool)}

@app.delete("/api/photos/pool/clear")
async def clear_photos_pool(request: Request):
    uid = _current_user_id(request)
    n = len(PHOTOS_POOLS.get(uid, []))
    PHOTOS_POOLS[uid] = []
    return {"ok": True, "removed": n}

class CacheFromSessionBody(BaseModel):
    session_id: str
    mode: t.Optional[str] = "replace"

async def _photos_list_media_items(session_id: str, authorization: str) -> dict:
    """
    Nuova Photos Picker API:
    usare GET /v1/mediaItems?sessionId=... (NON sessions/{id}:listMediaItems)
    """
    url = "https://photospicker.googleapis.com/v1/mediaItems"
    params = {"sessionId": session_id, "pageSize": 100}
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.get(url, params=params, headers={
            "Authorization": authorization,
        })
    # Quando l'utente non ha ancora premuto "Seleziona"/"Done",
    # il servizio può rispondere con FAILED_PRECONDITION (400).
    if r.status_code == 400 and "FAILED_PRECONDITION" in r.text:
        return {"mediaItems": []}
    if r.status_code != 200:
        logging.error("[BACKEND] mediaItems.list failed: %s %s", r.status_code, r.text)
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()

@app.get("/api/photos/picker/session/{session_id}")
async def get_photos_picker_session(session_id: str, request: Request, authorization: str = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manca Authorization: Bearer <token>")
    uid = _current_user_id(request)
    PHOTOS_BEARERS[uid] = authorization
    url = f"https://photospicker.googleapis.com/v1/sessions/{session_id}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get(url, headers={"Authorization": authorization})
        if r.status_code != 200:
            logging.error("[BACKEND] GET session failed: %s %s", r.status_code, r.text)
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return r.json()
    except httpx.HTTPError as e:
        logging.exception("[BACKEND] Network error GET session: %s", e)
        raise HTTPException(status_code=502, detail="Errore di rete verso PhotosPicker")
    
async def _assert_token_has_scope(creds, *required_scopes: str):
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get("https://oauth2.googleapis.com/tokeninfo",
                        params={"access_token": creds.token})
        if r.status_code != 200 and creds.refresh_token:
            creds.refresh(GoogleAuthRequest())
            r = await c.get("https://oauth2.googleapis.com/tokeninfo",
                            params={"access_token": creds.token})
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail="Token non valido. Esegui di nuovo il login.")

        data = r.json() if "application/json" in r.headers.get("content-type", "") else {}
        scopes = set((data.get("scope") or "").split())
        if not any(rs in scopes for rs in required_scopes):
            raise HTTPException(
                status_code=403,
                detail=f"Token privo degli scope richiesti: {', '.join(required_scopes)}"
            )

class PhotoItem(BaseModel):
    id: Optional[str] = None
    baseUrl: str
    mimeType: Optional[str] = None
    filename: Optional[str] = None

class PickerItem(BaseModel):
    id: str = Field(..., description="mediaItemId restituito dal Picker")
    baseUrl: str | None = Field(None, description="URL dell’immagine (se disponibile)")
    mimeType: str | None = None
    filename: str | None = None

class CachePhotosRequest(BaseModel):
    items: list[PickerItem]
    mode: Optional[str] = "append"

def _pick_base_url(mi: dict) -> str:
    """
    Estrae un URL immagine dai diversi formati del nuovo Photos Picker.
    Supporta campi piatti, annidati (mediaItem) e soprattutto mediaFile{...}.
    Ritorna '' se non trova nulla.
    """
    if not isinstance(mi, dict):
        return ""

    candidates: list[str | None] = []

    # ---- candidati “piatti” al top-level ----
    candidates += [
        mi.get("baseUrl"),
        mi.get("base_url"),
        mi.get("url"),
        mi.get("contentUrl"),
        mi.get("imageUrl"),
        mi.get("mediaUrl"),
        mi.get("downloadUrl"),
    ]

    # ---- se c'è mediaItem annidato ----
    for key in ("mediaItem", "media_item"):
        sub = mi.get(key)
        if isinstance(sub, dict):
            candidates += [
                sub.get("baseUrl"), sub.get("base_url"),
                sub.get("url"), sub.get("contentUrl"),
                sub.get("imageUrl"), sub.get("mediaUrl"), sub.get("downloadUrl"),
            ]
            thumbs = sub.get("thumbnails") or []
            if isinstance(thumbs, list) and thumbs:
                candidates.append((thumbs[0] or {}).get("url"))

    # ---- *** NUOVO: struttura moderna mediaFile {...} *** ----
    for key in ("mediaFile", "media_file"):
        mf = mi.get(key)
        if isinstance(mf, dict):
            # campi diretti
            candidates += [
                mf.get("baseUrl"), mf.get("base_url"),
                mf.get("url"), mf.get("contentUrl"),
                mf.get("imageUrl"), mf.get("mediaUrl"), mf.get("downloadUrl"),
            ]
            # thumbnails
            thumbs = mf.get("thumbnails") or []
            if isinstance(thumbs, list) and thumbs:
                for t in thumbs:
                    if isinstance(t, dict):
                        candidates.append(t.get("url"))

            # possibili sotto-oggetti tipizzati
            for subkey in ("image", "photo", "video"):
                sub = mf.get(subkey)
                if isinstance(sub, dict):
                    candidates += [
                        sub.get("baseUrl"), sub.get("base_url"),
                        sub.get("url"), sub.get("contentUrl"),
                        sub.get("imageUrl"), sub.get("mediaUrl"), sub.get("downloadUrl"),
                    ]
                    # sorgenti multiple
                    for listkey in ("sources", "variants"):
                        lst = sub.get(listkey) or []
                        if isinstance(lst, list):
                            for s in lst:
                                if isinstance(s, dict):
                                    candidates += [
                                        s.get("url"), s.get("downloadUrl"),
                                        s.get("contentUrl"), s.get("src"),
                                    ]

    # ---- thumbnails anche al top-level ----
    thumbs = mi.get("thumbnails") or []
    if isinstance(thumbs, list) and thumbs:
        candidates.append((thumbs[0] or {}).get("url"))

    # scegli il primo valido
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return ""

@app.post("/api/photos/cache")
async def cache_photos(payload: CachePhotosRequest, request: Request):
    uid = _current_user_id(request)
    pool = _user_pool(uid)

    client_ip = request.client.host if request and request.client else "?"
    logging.info(f"/api/photos/cache: uid={uid} from {client_ip}, items={len(payload.items)}, mode={payload.mode}")

    if payload.mode == "replace":
        PHOTOS_POOLS[uid] = []
        pool = _user_pool(uid)

    before, added = len(pool), 0
    for it in payload.items:
        if not it.baseUrl:
            logging.warning("/api/photos/cache: item senza baseUrl → skip")
            continue
        pool.append({
            "id": it.id,
            "baseUrl": it.baseUrl,
            "mimeType": it.mimeType,
            "filename": it.filename
        })
        added += 1

    after = len(pool)
    return JSONResponse({"ok": True, "added": added, "pool_size": after})

@app.post("/api/photos/picker/session/cache")
async def cache_from_session(body: CacheFromSessionBody, request: Request, authorization: str = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manca Authorization: Bearer <token>")
    uid = _current_user_id(request)
    PHOTOS_BEARERS[uid] = authorization
    pool = _user_pool(uid)

    attempts, media_items = 0, []
    while attempts < 20 and not media_items:
        attempts += 1
        try:
            payload = await _photos_list_media_items(body.session_id, authorization)
            media_items = payload.get("mediaItems") or []
            if media_items:
                break
        except HTTPException as he:
            logging.warning("[BACKEND] mediaItems.list errore (%s). Retry breve.", he.status_code)
        await asyncio.sleep(1.0)

    if not media_items:
        return JSONResponse({"ok": False, "cached": 0, "reason": "no_media_yet"}, status_code=202)

    if (body.mode or "append") == "replace":
        PHOTOS_POOLS[uid] = []
        pool = _user_pool(uid)

    added = 0
    for mi in media_items:
        base_url = _pick_base_url(mi)
        if not base_url:
            continue
        mf = mi.get("mediaFile") or mi.get("media_file") or {}
        auth_url = (
            mf.get("downloadUrl") or mf.get("download_url") or
            (mf.get("image") or {}).get("downloadUrl") or
            (mf.get("photo") or {}).get("downloadUrl")
        )
        pool.append({
            "id": mi.get("id") or (mi.get("mediaItem") or {}).get("id"),
            "baseUrl": base_url,
            "authUrl": auth_url,
            "mimeType": mi.get("mimeType") or mi.get("mime_type") or (mi.get("mediaItem") or {}).get("mimeType"),
            "filename": mi.get("filename") or (mi.get("mediaItem") or {}).get("filename"),
        })
        added += 1

    return {"ok": True, "cached": added, "pool_size": len(pool)}

# --- FUNZIONI HELPER ---
async def get_google_photos(user_id: str, count=25):
    pool = _user_pool(user_id)
    if not pool:
        raise HTTPException(status_code=409, detail="Foto non selezionate. Apri il Picker.")
    take = min(count, len(pool))
    return random.sample(pool, take) if len(pool) >= take else pool[:take]
def extract_html_from_payload(payload: dict) -> str:
    if not payload:
        return ""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {}) or {}
    data = body.get("data")

    if mime == "text/html" and data:
        try:
            return b64_urlsafe_decode(data).decode("utf-8", "ignore")
        except Exception:
            return ""

    # Se multipart: cerca ricorsivamente
    for part in (payload.get("parts") or []):
        html = extract_html_from_payload(part)
        if html:
            return html
    return ""

def b64_urlsafe_decode(s: str) -> bytes:
    s = s.replace('-', '+').replace('_', '/')
    pad = (-len(s)) % 4
    if pad:
        s += '=' * pad
    return base64.b64decode(s)

def clean_html(html_content):
    html_content = html_content or ""  # <— garantisce stringa
    soup = BeautifulSoup(html_content, 'html.parser')
    for element in soup(["script", "style", "head", "title", "meta", "header", "footer", "nav"]):
        element.extract()
    return ' '.join(soup.get_text(separator=' ', strip=True).split())

async def get_ai_summary(content: str, client: httpx.AsyncClient):
    raw = content or ""
    clean_content = clean_html(raw)[:4000]

    # Istruzioni aggiornate per includere la parola "JSON"
    instructions = """
Developer: # Ruolo e Obiettivo
- Sintetizzare il contenuto delle newsletter, generando un riassunto adatto a un feed in stile Instagram, mettendo in evidenza l'obiettivo principale della mail per l'utente.

# Istruzioni
- Analizza e riassumi il contenuto principale della newsletter.
- Scrivi una descrizione conforme ai requisiti di output sotto riportati, assicurandoti di chiarire l'obiettivo della mail all'utente.
- Escludi informazioni disponibili solo tramite abbonamento.

# Contesto
- Il riassunto sarà usato come anteprima su feed visuali tipo Instagram.
- Il prompt non deve includere né fare riferimento a contenuti protetti da paywall o sottoscrizione.

# REQUISITI DI OUTPUT (OBBLIGATORI)
- Rispondi SOLO con un oggetto JSON valido. Il formato deve essere un JSON object.
- Chiavi richieste: "title" (stringa) e "summary_markdown" (stringa).
- "title": massimo 10 parole, in italiano.
- "summary_markdown": massimo 400 caratteri totali, diviso in 2–3 paragrafi. Ogni paragrafo separato da UNA riga vuota e con una **parola chiave** in grassetto.
- Vietato includere testo extra fuori dal JSON.
"""
    user_input = f"Testo da analizzare:\n---\n{clean_content}\n---"

    try:
        if not openai.api_key:
            raise ValueError("La chiave API di OpenAI non è stata impostata nel file .env")

        # Payload aggiornato al formato moderno e con più token
        payload = {
            "model": "gpt-5-nano",
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": instructions}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_input}]}
            ],
                    "text": {
            "format": {"type": "json_object"},
            "verbosity": "low"
                },
                "reasoning": {"effort": "minimal"},
            "max_output_tokens": 600
        }

        resp = await client.post(
            "https://api.openai.com/v1/responses",
            json=payload,
            headers={
                "Authorization": f"Bearer {openai.api_key}",
                "Content-Type": "application/json",
            },
            timeout=15.0,
        )
        
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logging.error("[AI Summary] OpenAI error body: %s", e.response.text)
            raise

        data = resp.json()
        text = _extract_output_text(data)
        if not text:
            raise ValueError(f"Risposta senza testo utile: {data}")

        clean_json_str = _extract_json_from_string(text)
        obj = json.loads(clean_json_str) if clean_json_str else {}

        if not isinstance(obj, dict) or "title" not in obj or "summary_markdown" not in obj:
            raise ValueError("JSON non valido o chiavi richieste mancanti.")

        obj["title"] = obj["title"][:200]
        obj["summary_markdown"] = obj["summary_markdown"][:1200]
        return obj

    except Exception as e:
        logging.error(f"Errore critico in get_ai_summary: {e}", exc_info=True)
        return {"title": "Errore Elaborazione AI", "summary_markdown": "Si è verificato un problema durante l'analisi."}
    
async def _pixabay_search(client: httpx.AsyncClient, query: str) -> list[dict]:
    if not PIXABAY_KEY:
        return []
    params = {
        "key": PIXABAY_KEY,
        "q": query,
        "image_type": "photo",
        "orientation": "horizontal",
        "safesearch": "true",
        "order": "popular",
        "per_page": 10,
    }
    backoffs = [0.2, 0.6, 1.2]
    for i, b in enumerate(backoffs):
        try:
            r = await client.get("https://pixabay.com/api/", params=params, timeout=15.0)
            if r.status_code == 429:
                await asyncio.sleep(b)
                continue
            r.raise_for_status()
            data = r.json()
            return data.get("hits") or []
        except httpx.HTTPError:
            if i < len(backoffs) - 1:
                await asyncio.sleep(b)
            else:
                return []
    return []

def _pick_best_hit(hits: list[dict]) -> dict | None:
    if not hits:
        return None
    # Evita duplicati recenti, poi ordina per "likes" e dimensione
    filtered = [h for h in hits if str(h.get("id")) not in RECENT_PXB_IDS]
    candidates = filtered or hits
    def score(h):
        likes = h.get("likes") or 0
        w = h.get("imageWidth") or 0
        hgt = h.get("imageHeight") or 0
        return (likes, w*hgt)
    best = sorted(candidates, key=score, reverse=True)[0]
    return best

async def _download_image_bytes(client: httpx.AsyncClient, hit: dict) -> tuple[bytes, str]:
    url = hit.get("largeImageURL") or hit.get("webformatURL")
    if not url:
        return b"", "image/jpeg"
    r = await client.get(url, timeout=25.0, follow_redirects=True)
    r.raise_for_status()
    ct = r.headers.get("content-type", "image/jpeg").split(";")[0]
    return r.content, ct

@app.post("/api/photos/picker/session")
async def create_photos_picker_session(request: Request, authorization: str = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manca Authorization: Bearer <token>")

    # Body corretto per la nuova API: NIENTE wrapper "session", NIENTE origin/client.
    picking_session = {
        "pickingConfig": {
            "maxItemCount": 500  # imposta qui il limite voluto
        }
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.post(
                "https://photospicker.googleapis.com/v1/sessions",
                headers={
                    "Authorization": authorization,  # Bearer <access_token GIS con scope photospicker>
                    "Content-Type": "application/json",
                },
                json=picking_session,
            )
        if r.status_code != 200:
            logging.error("[BACKEND] PhotosPicker CREATE SESSION failed: %s", r.status_code)
            logging.error("[BACKEND] Response body: %s", r.text)
            raise HTTPException(status_code=r.status_code, detail=r.text)

        resp = r.json()
        # La risposta contiene "pickerUri" che il frontend deve aprire in popup
        if not resp.get("pickerUri"):
            logging.error("[BACKEND] Nessuna pickerUri nella risposta: %s", resp)
            raise HTTPException(status_code=500, detail="Nessuna pickerUri nella risposta di Google.")
        return resp

    except httpx.HTTPError as e:
        logging.exception("[BACKEND] Errore di rete verso PhotosPicker: %s", e)
        raise HTTPException(status_code=502, detail="Errore di rete verso PhotosPicker")
    
# --- ENDPOINTS ---
@app.get("/auth/login")
async def auth_login(request: Request):
    ua = request.headers.get("user-agent","-")
    logging.info("[AUTH/LOGIN] ua=%s scheme=%s host=%s", ua, request.url.scheme, request.url.hostname)
    sid = request.session.get("sid")
    if not sid:
        sid = str(uuid.uuid4())
        request.session["sid"] = sid

    # L'URL di reindirizzamento viene costruito dinamicamente a partire dalla richiesta.
    # Grazie a --proxy-headers e Caddy, questo genererà https://app.thegist.tech/auth/callback
    
    _cleanup_pending_auth(request)
    pa = _pending_auth(request)

    if pa:
        existing_nonce, data = next(reversed(list(pa.items())))
        auth_url = data.get("auth_url")
        if auth_url:
            logging.info("[AUTH/LOGIN] Riutilizzo auth in sospeso per sid=%s", sid)
            return RedirectResponse(auth_url, status_code=302)

    nonce = secrets.token_urlsafe(24)
    state = f"{sid}.{nonce}"

    flow = Flow.from_client_secrets_file(CLIENT_SECRETS_FILE, scopes=SCOPES, redirect_uri=REDIRECT_URI)
    
    # <-- INIZIO MODIFICA PKCE -->
    # 1. Genera il code_verifier e il code_challenge per PKCE
    code_verifier = secrets.token_urlsafe(96)[:128]
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b'=').decode()

    # 2. Genera l'URL di base
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
        state=state,
        code_challenge=code_challenge,
        code_challenge_method="S256"
    )

    pa[nonce] = {
        "pkce": code_verifier,   # <— salva davvero il verifier
        "auth_url": auth_url,
        "ts": time.time(),
    }
    _save_pending_auth(request, pa)

    # 3. Salva il code_verifier su Redis per il recupero nel callback
    if not redis_client:
        logging.error("[AUTH/LOGIN] Redis non disponibile: impossibile salvare il nonce.")
        raise HTTPException(status_code=500, detail="Auth store non disponibile")
    try:
        entry = {"pkce": code_verifier}
        # NOTA: Uso redis_client.setex (sincrono), non await redis.setex
        redis_client.setex(_get_pending_auth_nonce_key(sid, nonce), AUTH_PENDING_TTL, json.dumps(entry))
    except Exception as e:
        logging.error(f"[AUTH/LOGIN] Redis setex failed: {e}")
        raise HTTPException(status_code=500, detail="Auth store non disponibile")
    # <-- FINE MODIFICA PKCE -->

    logging.info("[AUTH/LOGIN] saved sid=%s nonce=%s redirect_uri=%s", sid, nonce, REDIRECT_URI)
    
    # 4. Prepara la risposta con il cookie di backup (logica invariata ma ora corretta)
    response = RedirectResponse(auth_url, status_code=303, headers={"Cache-Control":"no-store"})
    response.set_cookie(
        "__Host-nl_pkce",
        value=code_verifier,
        max_age=600,      # 10 minuti bastano
        path="/",
        secure=True,
        httponly=True,
        samesite="none",
    )

    return response

@app.get("/auth/callback")
async def auth_callback(request: Request, bg: BackgroundTasks):
    ua = request.headers.get("user-agent","-")
    logging.info("[AUTH/CALLBACK] ua=%s scheme=%s cookies_present=%s", ua, request.url.scheme, bool(request.cookies))
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    if not code:
        raise HTTPException(400, "Missing code")

    logging.info("[AUTH/CALLBACK] code_present=%s, cookies_present=%s", bool(code), bool(request.cookies))

    sid_from_state, nonce = (state.split(".", 1) if "." in state else (None, None))
    sid_from_session = request.session.get("sid")

    if not sid_from_session and sid_from_state:
        request.session["sid"] = sid_from_state
        sid_from_session = sid_from_state
        logging.info("[AUTH/CALLBACK] SID ripristinato dallo 'state': %s", sid_from_session)
    
    if not sid_from_session:
        logging.error("[AUTH/CALLBACK] ERRORE CRITICO: SID non trovato né in sessione né nello 'state'. Impossibile procedere.")
        return RedirectResponse("/?auth_error=session_lost", status_code=303)

    if sid_from_state and sid_from_session != sid_from_state:
        logging.warning("[AUTH/CALLBACK] Mismatch di SID tra sessione (%s) e state (%s). Potenziale attacco CSRF o sessione corrotta.", sid_from_session, sid_from_state)
        return RedirectResponse("/?auth_error=state_mismatch", status_code=303)

    _cleanup_pending_auth(request)
    pa = _pending_auth(request)
    pending_entry = pa.get(nonce or "")

    if not nonce or not pending_entry:
        logging.warning("[AUTH/CALLBACK] Nonce non valido o scaduto. sid=%s, nonce_fornito=%s, pending_keys=%s", sid_from_session, nonce, list(pa.keys()))
        # Se le credenziali esistono già, potrebbe essere un doppio callback, lo permettiamo.
        if CREDENTIALS_STORE.get(request.session.get("user_id")):
             logging.info("[AUTH/CALLBACK] Nonce non valido ma utente già loggato. Procedo.")
             return RedirectResponse("/?authenticated=true", status_code=303)
        return RedirectResponse("/?auth_error=invalid_nonce", status_code=303)

    try:
        flow = Flow.from_client_secrets_file(CLIENT_SECRETS_FILE, scopes=SCOPES, redirect_uri=REDIRECT_URI)
        
        pkce_verifier = pending_entry.get("pkce")
        if pkce_verifier:
            flow.code_verifier = pkce_verifier

        logging.info(
            "OAUTH: Inizio scambio token.",
            extra={
                "redirect_uri": REDIRECT_URI,
                "state_prefix": state[:8],
                "has_verifier": bool(pkce_verifier),
            },
        )

        # Esegui lo scambio del token
        flow.fetch_token(authorization_response=str(request.url))
        creds = flow.credentials

        # Ottieni il profilo utente per avere email e user_id
        profile_service = build('oauth2', 'v2', credentials=creds, cache_discovery=False)
        profile = profile_service.userinfo().get().execute()
        
        email = profile.get("email")
        user_id = profile.get("id") # L'ID numerico di Google è un identificatore stabile

        if not email or not user_id:
            raise ValueError("Impossibile recuperare email o ID utente dal profilo Google.")

        # Salva le informazioni corrette nella sessione
        request.session["user_email"] = email
        request.session["user_id"] = user_id

        # Salva le credenziali usando l'ID UTENTE come chiave
        CREDENTIALS_STORE[user_id] = json.loads(creds.to_json())
        save_credentials_store()
        
        # Pulisci il nonce usato
        pa.pop(nonce, None)
        
        # Avvia i processi in background se è un nuovo utente
        is_new_user = not any(Newsletter.select().where(Newsletter.user_id == user_id).limit(1))
        if is_new_user:
            logging.info(f"Nuovo utente registrato: {email} (ID: {user_id}). Avvio ingestione iniziale.")
            bg.add_task(kickstart_initial_ingestion, user_id)
        
        await ensure_user_defaults(user_id)

        logging.info("[AUTH/CALLBACK] Autenticazione completata con successo per %s", email)
        return RedirectResponse("/?authenticated=true", status_code=303)

    except InvalidGrantError as e:
        client_id_from_flow = flow.client_config.get("client_id", "N/A")
        logging.error(
            "OAUTH: InvalidGrantError durante lo scambio del token.",
            extra={
                "reason": getattr(e, "description", str(e))[:200],
                "hint": getattr(e, "uri", None),
                "redirect_uri_usato": REDIRECT_URI,
                "has_verifier": bool(pkce_verifier),
                "client_id_tail": client_id_from_flow[-6:],
            },
        )
        # In caso di errore, reindirizza alla pagina di login con un messaggio chiaro
        return RedirectResponse("/?auth_error=invalid_grant", status_code=303)

    except Exception as e:
        logging.error(f"[AUTH/CALLBACK] ERRORE CRITICO DURANTE FETCH_TOKEN: {e}", exc_info=True)
        return RedirectResponse(f"/?auth_error=unknown_error", status_code=303)

    finally:
        # Pulisci sempre lo stato temporaneo dalla sessione per evitare riutilizzi
        request.session.pop("_code_in_flight", None)
        request.session.pop("_oauth_lock", None)

async def get_user_settings(user_id: str) -> dict | None:
    # usa lo store già esistente su file (SETTINGS_STORE)
    return SETTINGS_STORE.get(user_id)

async def upsert_user_settings(user_id: str, **kwargs):
    cur = SETTINGS_STORE.get(user_id, {"preferred_image_source": "pixabay", "hidden_domains": []})
    cur.update(kwargs)
    SETTINGS_STORE[user_id] = cur
    save_settings_store()  # persisti su disco
    return cur

async def ensure_user_defaults(user_id: str):
    # se è il primo login (nessun record) → imposta pixabay
    if user_id not in SETTINGS_STORE:
        SETTINGS_STORE[user_id] = {"preferred_image_source": "pixabay", "hidden_domains": []}
        save_settings_store()


@app.get("/debug/tokeninfo")
async def debug_tokeninfo(request: Request):
    user_id = request.session.get("user_id")
    if not user_id or user_id not in CREDENTIALS_STORE:
        raise HTTPException(status_code=401, detail="Non autenticato")

    creds_dict = CREDENTIALS_STORE.get(user_id)
    creds = Credentials.from_authorized_user_info(creds_dict, SCOPES)

    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"access_token": creds.token}
        )

    ctype = r.headers.get("content-type", "")
    body = r.json() if ctype.startswith("application/json") else r.text
    return JSONResponse({"status": r.status_code, "body": body})

@app.get("/config")
async def get_config(request: Request):
    backend_base = str(request.base_url).rstrip("/")
    return {
        "GOOGLE_CLIENT_ID": GOOGLE_CLIENT_ID_WEB,
        "GOOGLE_API_KEY": GOOGLE_API_KEY,
        "BACKEND_BASE": backend_base,
    }

async def kickstart_initial_ingestion(user_id: str, job_id: str | None = None):
    """
    Funzione speciale chiamata solo al primo login.
    Recupera le prime email e le mette direttamente in coda, bypassando l'attesa dell'ingestor.
    """
    if redis_client:
        redis_client.set(f"kickstart_active:{user_id}", "1", ex=300)
    logging.info(f"Kickstart: Inizio recupero email per il nuovo utente {user_id} (Job: {job_id})")
    try:
        creds_dict = CREDENTIALS_STORE.get(user_id)
        if not creds_dict:
            logging.error(f"Kickstart fallito: credenziali non trovate per l'utente {user_id}")
            return

        creds = Credentials.from_authorized_user_info(creds_dict)
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleAuthRequest())
            CREDENTIALS_STORE[user_id] = json.loads(creds.to_json())
            save_credentials_store()

        gmail = build('gmail', 'v1', credentials=creds, cache_discovery=False)
        
        response = gmail.users().messages().list(userId='me', maxResults=10).execute()
        messages = response.get('messages', [])
        
        if not messages:
            logging.info(f"Kickstart: Nessuna email trovata per {user_id}.")
            if job_id and job_id in INGEST_JOBS:
                INGEST_JOBS[job_id]["state"] = "done"
            return

        existing_ids = {n.email_id for n in Newsletter.select(Newsletter.email_id).where(Newsletter.user_id == user_id)}
        new_messages = [msg for msg in messages if msg['id'] not in existing_ids]

        if job_id and job_id in INGEST_JOBS:
            INGEST_JOBS[job_id]["total"] = len(new_messages)
        
        if not new_messages:
            logging.info(f"Kickstart: Nessuna *nuova* email trovata per {user_id}.")
            if job_id and job_id in INGEST_JOBS:
                INGEST_JOBS[job_id]["state"] = "done"
            return

        for msg in new_messages:
            Newsletter.get_or_create(
                email_id=msg['id'],
                user_id=user_id,
                defaults={"received_date": datetime.now(timezone.utc)}
            )
            job_payload = {"email_id": msg['id'], "user_id": user_id, "job_id": job_id}
            if redis_client:
                redis_client.rpush('email_queue', json.dumps(job_payload))
        
        logging.info(f"Kickstart: Aggiunti {len(new_messages)} lavori alla coda per l'utente {user_id}. Il worker prenderà il controllo.")

    except Exception as e:
        logging.error(f"Kickstart fallito per l'utente {user_id}: {e}", exc_info=True)
        if job_id and job_id in INGEST_JOBS:
            INGEST_JOBS[job_id]["state"] = "failed"
        
@app.get("/debug/oauth-config")
def debug_oauth_config(request: Request):
    with open(CLIENT_SECRETS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    cfg = (data.get("web") or data.get("installed") or {})
    return {
        "client_id": cfg.get("client_id"),
        "has_client_secret": bool(cfg.get("client_secret")),
        "redirect_uri_effective": str(request.url_for("auth_callback")),
        "type": "web" if "web" in data else ("installed" if "installed" in data else "unknown"),
    }

@app.get("/debug/session")
def debug_session(request: Request):
    return JSONResponse({
        "sid": request.session.get("sid"),
        "user_email": request.session.get("user_email"),
        "user_id": request.session.get("user_id"),
        "has_creds": bool(CREDENTIALS_STORE.get(request.session.get("user_id") or "")),
    })

def _parse_cursor(cur: str | None) -> Tuple[datetime | None, str | None]:
    if not cur:
        return None, None
    try:
        date_part, id_part = cur.split("|", 1)
        # se non c’è offset, assume UTC
        if "Z" in date_part or "+" in date_part or "-" in date_part[10:]:
            dt = datetime.fromisoformat(date_part.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(date_part).replace(tzinfo=timezone.utc)
        return dt, id_part
    except Exception:
        return None, None

def get_ingestion_state(user_id: str) -> dict:
    """Restituisce lo stato di ingestione per un utente specifico."""
    active_job = next(
        (
            jid
            for jid, st in INGEST_JOBS.items()
            if st.get("user_id") == user_id and st.get("state") in ("queued", "running")
        ),
        None,
    )
    return {"running": bool(active_job), "job_id": active_job}

@app.get("/api/feed")
async def get_feed(
    request: Request,
    bg: BackgroundTasks,
    page_size: int = Query(20, ge=1, le=50),
    before: str | None = Query(None, description="cursor: 'ISOZ|<email_id>'"),
):
    rid = getattr(request.state, "request_id", "-")
    user_id = get_user_id_from_session(request)
    if not user_id or user_id == "anonymous":
        raise HTTPException(status_code=401, detail="Non autenticato")

    log_feed(rid, "in", user_id=user_id, before=before, limit=page_size)
    t0_total = time.perf_counter()

    settings = SETTINGS_STORE.get(user_id, {"hidden_domains": []})
    hidden = set(settings.get("hidden_domains", []))

    base_q = (Newsletter
        .select(
            Newsletter.email_id, Newsletter.user_id,
            Newsletter.sender_name, Newsletter.sender_email,
            Newsletter.original_subject, Newsletter.ai_title, Newsletter.ai_summary_markdown,
            Newsletter.image_url, Newsletter.received_date,
            Newsletter.is_favorite, Newsletter.accent_hex,
            Newsletter.tag, Newsletter.type_tag, Newsletter.topic_tag,
            Newsletter.source_domain, Newsletter.thread_id, Newsletter.rfc822_message_id,
            Newsletter.is_complete    
        )
        .where(
            (Newsletter.user_id == user_id) &
            (Newsletter.is_complete == True) &
            (Newsletter.is_deleted == False) &
            (Newsletter.received_date.is_null(False))
        )
        .order_by(Newsletter.received_date.desc(), Newsletter.email_id.desc())
    )

    if hidden:
        base_q = base_q.where(~(Newsletter.source_domain.in_(list(hidden))))

    if before:
        last_dt, last_email = _parse_cursor(before)
        if last_dt and last_email:
            base_q = base_q.where(
                (Newsletter.received_date < last_dt) |
                ((Newsletter.received_date == last_dt) & (Newsletter.email_id < last_email))
            )

    t0_db = time.perf_counter()
    rows = list(base_q.limit(page_size + 1).dicts())
    t_db_ms = (time.perf_counter() - t0_db) * 1000

    has_more = len(rows) > page_size
    # 1. Definisci page_raw con i dati della pagina corrente (prima della deduplica)
    page_raw = rows[:page_size]
    
    # 2. Esegui la deduplica partendo da page_raw
    seen_threads = set()
    page = [] # Questa sarà la lista finale e pulita
    for item in page_raw:
        tid = item.get("thread_id")
        if tid and tid in seen_threads:
            continue
        
        if tid:
            seen_threads.add(tid)
        page.append(item)
    
    # 3. Calcola il cursore basandoti sull'ultimo elemento di page_raw
    next_cursor = None
    if has_more:
        # Usiamo l'ultimo elemento *prima* della deduplica per garantire una paginazione corretta
        last_item_for_cursor = page_raw[-1]
        next_cursor = f"{_iso_utc(last_item_for_cursor['received_date'])}|{last_item_for_cursor['email_id']}"

    # 4. Prepara la pagina finale per la risposta JSON
    final_page = []
    for item in page: # Itera sulla lista 'page' già deduplicata
        item["received_date"] = _iso_utc(item.get("received_date"))
        item = _add_gmail_deep_link_fields(item)
        final_page.append(item)

    state = get_ingestion_state(user_id)
    
    dur_total_ms = (time.perf_counter() - t0_total) * 1000
    log_feed(rid, "out", has_more=has_more, page_len=len(page), dur_ms=int(dur_total_ms), db_ms=int(t_db_ms))

    resp = JSONResponse({
        "feed": final_page,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "ingest": state,
    })
    resp.headers["Server-Timing"] = f"db;dur={t_db_ms:.0f}"
    return resp

@app.get("/api/_diag/feed-stats")
def feed_stats(request: Request):
    rid = getattr(request.state, "request_id", "-")
    user_id = get_user_id_from_session(request)
    if not user_id or user_id == "anonymous":
        raise HTTPException(status_code=401, detail="Non autenticato")
        
    q_all = Newsletter.select().where(Newsletter.user_id == user_id)
    q_complete = q_all.where(Newsletter.is_complete == True)
    q_null_date = q_complete.where(Newsletter.received_date.is_null(True))
    
    counts = {
        "total": q_all.count(),
        "complete": q_complete.count(),
        "complete_null_date": q_null_date.count(),
        "distinct_domains": (q_complete.select(fn.COUNT(fn.DISTINCT(Newsletter.source_domain))).scalar()),
    }
    log_feed(rid, "diag", **counts)
    return counts

@app.post("/api/ingest/trigger")
async def trigger_ingest(request: Request):
    """
    Endpoint leggero che dice all'Ingestor di fare un controllo immediato.
    """
    user_id = get_user_id_from_session(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Non autenticato")
    
    # Invia un messaggio su un canale Redis a cui l'ingestor può iscriversi.
    # Per semplicità, possiamo anche solo aggiungere un job speciale alla coda.
    # Questo è un pattern avanzato, per ora possiamo ometterlo.
    # La cosa più semplice è che il pulsante "Aggiorna" sul frontend
    # faccia semplicemente un'altra chiamata a /api/feed.
    
    logging.info(f"Trigger di ingestione manuale richiesto per l'utente {user_id}")
    # In una versione futura, questo pubblicherebbe un messaggio su Redis.
    # Per ora, restituiamo solo un successo. L'ingestor controllerà comunque entro un minuto.
    return {"status": "Richiesta di aggiornamento ricevuta."}

class IngestPullBody(BaseModel):
    batch: int = Field(default=25, ge=1, le=100)
    image_source: str | None = Field(default=None)
    pages: int = Field(default=5, ge=1, le=20)
    target: int = Field(default=50, ge=1, le=500)

@app.post("/api/sse/notify/{job_id}/{email_id}")
async def sse_notify(job_id: str, email_id: str):
    """
    Notifica i client SSE in ascolto su un job_id specifico che un'email è stata aggiornata.
    """
    logging.info(f"[SSE NOTIFY] Ricevuta notifica per job_id={job_id}, email_id={email_id}")
    # Invia l'evento solo alle code associate a questo specifico job_id
    if job_id in SSE_LISTENERS:
        listeners = SSE_LISTENERS[job_id]
        logging.info(f"[SSE NOTIFY] Inoltro a {len(listeners)} listener per il job {job_id}.")
        for queue in listeners:
            await queue.put({"type": "update", "email_id": email_id})
    else:
        logging.warning(f"[SSE NOTIFY] Nessun listener trovato per il job_id {job_id}.")
        
    return {"ok": True, "notified": len(SSE_LISTENERS.get(job_id, []))}

@app.get("/api/ingest/events/{job_id}")
async def ingest_events(job_id: str, request: Request):
    client_ip = request.client.host if request.client else "?"
    logging.info(f"[SSE] connect job_id={job_id} from={client_ip}")

    queue = asyncio.Queue()
    SSE_LISTENERS.setdefault(job_id, []).append(queue)

    async def event_generator():
        ping_every = 15.0 # Aumentato a 15 secondi
        last_ping = time.time()
        try:
            while True:
                if await request.is_disconnected():
                    logging.info(f"[SSE] disconnect job_id={job_id}")
                    break

                try:
                    note = await asyncio.wait_for(queue.get(), timeout=1.0) # Timeout più breve
                    if note.get("type") == "update":
                        email_id = note.get("email_id")
                        yield f"event: update\ndata: {json.dumps({'state':'update','email_id':email_id})}\n\n"
                        logging.info(f"[SSE] update job_id={job_id} email_id={email_id}")
                except asyncio.TimeoutError:
                    pass

                st = INGEST_JOBS.get(job_id)
                if not st:
                    yield "data: {\"state\":\"unknown\"}\n\n"
                    break
                
                now = time.time()
                if now - last_ping >= ping_every:
                    last_ping = now
                    # --- INIZIO PATCH: Invia evento ping ---
                    yield "event: ping\ndata: {}\n\n"
                    # --- FINE PATCH ---
                    
                    yield f"event: progress\ndata: {json.dumps(st)}\n\n"
                    if st.get("state") in ("done","failed"):
                        logging.info(f"[SSE] end job_id={job_id} state={st.get('state')} done={st.get('done')}/{st.get('total')}")
                        yield f"data: {json.dumps(st)}\n\n"
                        break
        finally:
            lst = SSE_LISTENERS.get(job_id, [])
            if queue in lst: lst.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


async def run_ingest_job(job_id: str, user_id: str, batch: int, image_source: str | None, pages: int, target: int):
    """
    Ingestione on-demand per un singolo utente con paginazione.
    """
    global INGEST_JOBS, CREDENTIALS_STORE, redis_client

    try:
        INGEST_JOBS[job_id]["state"] = "running"
        user_id = user_id or INGEST_JOBS[job_id].get("user_id")

        if not redis_client:
            raise RuntimeError("Redis non disponibile")

        creds_dict = CREDENTIALS_STORE.get(user_id)
        if not creds_dict:
            raise RuntimeError(f"Credenziali mancanti per user_id={user_id}")

        creds = Credentials.from_authorized_user_info(creds_dict, SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleAuthRequest())
            CREDENTIALS_STORE[user_id] = json.loads(creds.to_json())
            save_credentials_store()

        gmail = build("gmail", "v1", credentials=creds, cache_discovery=False)
        existing_ids = {n.email_id for n in Newsletter.select(Newsletter.email_id).where(Newsletter.user_id == user_id)}

        # --- Logica di paginazione ---
        accum_ids = []
        page_token = None
        pages_fetched = 0
        max_pages = int(pages or 1)
        target_count = int(target or batch or 50)

        while len(accum_ids) < target_count and pages_fetched < max_pages:
            resp = await asyncio.to_thread(
                gmail.users().messages().list(
                    userId="me",
                    maxResults=max(10, int(batch or 25)),
                    pageToken=page_token
                ).execute
            )
            msgs = resp.get("messages", []) or []
            if not msgs:
                break

            for m in msgs:
                mid = m.get("id")
                if mid and mid not in existing_ids:
                    accum_ids.append(mid)
                    if len(accum_ids) >= target_count:
                        break
            
            page_token = resp.get("nextPageToken")
            pages_fetched += 1
            if not page_token:
                break
        
        to_process_ids = accum_ids
        # --- Fine logica di paginazione ---

        INGEST_JOBS[job_id]["total"] = len(to_process_ids)

        if not to_process_ids:
            logging.info("[JOB %s] Nessuna nuova email da processare per %s → chiudo.", job_id, user_id)
            INGEST_JOBS[job_id]["state"] = "done"
            return

        for email_id in to_process_ids:
            Newsletter.get_or_create(
                email_id=email_id, user_id=user_id,
                defaults={"received_date": datetime.now(timezone.utc), "is_complete": False, "enriched": False}
            )
            job_payload = {"email_id": email_id, "user_id": user_id, "job_id": job_id}
            redis_client.rpush("email_queue", json.dumps(job_payload))

        logging.info(
            "[JOB %s] Accodati %d messaggi per user_id=%s (pages=%d, target=%d).",
            job_id, len(to_process_ids), user_id, pages_fetched, target_count
        )

    except Exception as e:
        logging.exception("[JOB %s] Errore critico: %s", job_id, e)
        try:
            INGEST_JOBS[job_id]["state"] = "failed"
            INGEST_JOBS[job_id]["reason"] = str(e) or "exception"
        except Exception:
            pass

@app.post("/api/ingest/progress/{job_id}")
async def update_ingest_progress(job_id: str):
    """Endpoint chiamato dal worker per segnalare che un item è stato completato."""
    if job_id in INGEST_JOBS:
        job = INGEST_JOBS[job_id]
        job["done"] = job.get("done", 0) + 1
        
        # Se tutti gli item sono stati processati, il job è veramente "finito".
        if job["done"] >= job.get("total", 0):
            job["state"] = "done"
            logging.info(f"[JOB {job_id}] Tutti gli {job['done']}/{job['total']} item sono stati processati. Job completato.")
        else:
            logging.info(f"[JOB {job_id}] Progresso: {job['done']}/{job['total']}")
    return {"ok": True}


@app.post("/api/ingest/pull")
async def ingest_pull(body: IngestPullBody, request: Request, bg: BackgroundTasks):
    user_id = get_user_id_from_session(request)
    if not user_id or user_id == "anonymous":
        raise HTTPException(status_code=401, detail="Utente non autenticato.")

    active_job = next((jid for jid, st in INGEST_JOBS.items()
                       if st.get("state") in ("queued","running") and st.get("user_id")==user_id), None)
    if active_job:
        logging.warning(f"[PULL] already_running user={user_id} job_id={active_job}")
        return JSONResponse({"job_id": active_job, "status":"already_running"}, status_code=202)

    job_id = uuid.uuid4().hex
    INGEST_JOBS[job_id] = {"state":"queued","total":0,"done":0,"errors":0,"user_id":user_id}
    logging.info(f"[PULL] start user={user_id} job_id={job_id} batch={body.batch} img_src={body.image_source} pages={body.pages} target={body.target}")
    bg.add_task(run_ingest_job, job_id, user_id, body.batch, body.image_source, body.pages, body.target)
    return {"job_id": job_id, "status": "started"}

class IngestStartBody(BaseModel):
    batch: int = Field(default=8, ge=1, le=50)  # piccolo lotto iniziale
    image_source: str | None = None               # "google_photos" o "pixabay"

class UpdateImagesBody(BaseModel):
    email_ids: list[str]
    image_source: str | None = "pixabay"

async def _gmail_get_message_with_retries(gmail_or_creds, msg_id: str, max_attempts: int = 5):
    backoff = 0.5
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await asyncio.to_thread(
                gmail_or_creds.users().messages().get(userId='me', id=msg_id, format='full').execute
            )
        except (HttpError, http_client.IncompleteRead, ssl.SSLError, socket.timeout, ConnectionResetError) as e:
            last_exc = e
            logging.warning(f"[ingest] transient gmail get error for {msg_id} (attempt {attempt}/{max_attempts}): {e}")
            await asyncio.sleep(backoff)
            backoff *= 2
        except Exception as e:
            last_exc = e
            logging.warning(f"[ingest] gmail get unexpected error for {msg_id} (attempt {attempt}/{max_attempts}): {e}")
            if attempt >= max_attempts: 
                raise
            await asyncio.sleep(backoff)
            backoff *= 2
    raise last_exc or RuntimeError("_gmail_get_message_with_retries: unknown failure")

# ... (UpdateImagesRequest, /api/feed/update-images, /api/feed/{email_id}/favorite rimangono invariati)
class UpdateImagesRequest(BaseModel):
    email_ids: list[str]
    image_source: str | None = "pixabay"
    only_empty: bool = False 

class ImportAlbumBody(BaseModel):
    albumId: str
    mode: Optional[str] = "append"  # o "replace"

@app.post("/api/photos/import/album")
async def import_album(body: ImportAlbumBody, request: Request, authorization: str = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Manca Authorization: Bearer <token>")

    uid = _current_user_id(request)
    PHOTOS_BEARERS[uid] = authorization
    pool = _user_pool(uid)

    url = "https://photoslibrary.googleapis.com/v1/mediaItems:search"
    payload = {"albumId": body.albumId, "pageSize": 100}
    added = 0
    if (body.mode or "append") == "replace":
        PHOTOS_POOLS[uid] = []
        pool = _user_pool(uid)

    async with httpx.AsyncClient(timeout=20.0) as c:
        page_token = None
        while True:
            data = dict(payload)
            if page_token:
                data["pageToken"] = page_token
            r = await c.post(url, json=data, headers={"Authorization": authorization})
            if r.status_code != 200:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            out = r.json()
            for mi in (out.get("mediaItems") or []):
                base_url = _pick_base_url(mi)
                if not base_url:
                    continue
                mf = mi.get("mediaFile") or {}
                auth_url = mf.get("downloadUrl") or (mf.get("image") or {}).get("downloadUrl")
                pool.append({
                    "id": mi.get("id"),
                    "baseUrl": base_url,
                    "authUrl": auth_url,
                    "mimeType": mi.get("mimeType"),
                    "filename": mi.get("filename"),
                })
                added += 1
            page_token = out.get("nextPageToken")
            if not page_token:
                break

    return {"ok": True, "cached": added, "pool_size": len(pool)}

@app.post("/api/feed/update-images")
async def update_images(body: UpdateImagesRequest, request: Request):
    """
    Aggiorna le immagini delle email.
    - "google_photos": prende a giro dalla pool PER-UTENTE e usa il proxy /api/photos/proxy/{id}
    - altrimenti: Pixabay→R2 per ciascuna email
    """
    uid = _current_user_id(request) # Identifica l'utente che fa la richiesta
    logging.info(f"update_images: richiesta da uid={uid} con image_source={body.image_source}, email_ids={len(body.email_ids)}")
    
    try:
        updated_items = []
        failed_items = [] # <-- Aggiunto
        source = body.image_source or "pixabay"

        async with httpx.AsyncClient(timeout=30.0) as client:
            pool = _user_pool(uid)
            if source == "google_photos" and not pool:
                raise HTTPException(status_code=409, detail="La tua pool di Google Photos è vuota. Seleziona prima le foto.")

            start_index = random.randint(0, len(pool) - 1) if pool else 0

            for i, email_id in enumerate(body.email_ids):
                try:
                    n = Newsletter.get((Newsletter.email_id == email_id) & (Newsletter.user_id == uid))
                    if body.only_empty and n.image_url:
                        continue

                    new_image_url = ""
                    image_query = None
                    accent_hex = None

                    if source == "google_photos":
                        item = pool[(start_index + i) % len(pool)]
                        photo_id = (item.get("id") or "").strip()
                        if photo_id:
                            base = str(request.base_url).rstrip('/')
                            new_image_url = f"{base}/api/photos/proxy/{photo_id}?w=1600&h=900&mode=no"
                    else:  # Pixabay
                        image_query = await get_ai_keyword(n.full_content_html or "", client)
                        new_image_url = await get_pixabay_image_by_query(client, image_query, bypass_cache=True)

                    if not new_image_url:
                        failed_items.append({"email_id": email_id, "error": "no_image_found"})
                        continue

                    # Scarica l'immagine e estrai il colore
                    r = await client.get(new_image_url, timeout=15.0, follow_redirects=True)
                    r.raise_for_status()
                    body_bytes = r.content
                    accent_hex = extract_dominant_hex(body_bytes)

                    # ⬇️ RE-HOST SU R2 se configurato (evita 429 di Pixabay)
                    try:
                        r2_client = _get_r2()
                        if r2_client:
                            ct = r.headers.get("content-type", "image/jpeg").split(";", 1)[0].lower()
                            ext = "jpg"
                            if ct.endswith("png"): ext = "png"
                            elif ct.endswith("webp"): ext = "webp"
                            # usa query/ai_title/subject per la chiave
                            kw_for_key = (image_query or n.ai_title or n.original_subject or "newsletter")
                            key = make_r2_key_from_kw(kw_for_key, ext=ext)
                            r2_url = upload_bytes_to_r2(body_bytes, key, content_type=ct)
                            new_image_url = r2_url
                    except Exception as e:
                        logging.warning(f"[UPDATE-IMAGES] R2 upload failed, keep source URL: {e}")

                    is_complete = bool(n.ai_title and n.ai_summary_markdown and new_image_url and accent_hex)

                    (Newsletter.update(image_url=new_image_url, accent_hex=accent_hex, is_complete=is_complete)
                     .where((Newsletter.email_id == email_id) & (Newsletter.user_id == uid))
                     ).execute()
                    
                    updated_items.append({
                        "email_id": email_id,
                        "image_url": new_image_url,
                        "image_query": image_query,
                        "accent_hex": accent_hex
                    })

                except Exception as e:
                    logging.warning(f"[UPDATE-IMAGES] Fallimento per email {email_id}: {e}")
                    failed_items.append({"email_id": email_id, "error": str(e)})
                    continue # Continua con la prossima email

        logging.info(f"update_images: completato per uid={uid}. Aggiornati {len(updated_items)} elementi, falliti {len(failed_items)}.")
        return JSONResponse(content={"updated_items": updated_items, "failed_items": failed_items})

    except HTTPException as he:
        logging.error(f"update_images: HTTPException {he.status_code} per uid={uid}: {he.detail}")
        raise he
    except Exception as e:
        logging.error(f"update_images: errore imprevisto per uid={uid}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Errore interno durante l'aggiornamento immagini.")
    
@app.post("/api/r2/test-upload")
async def r2_test_upload(request: Request):
    # ✅ richiede sessione valida (altrimenti 401)
    _ = _current_user_id(request)

    try:
        data, ct = placeholder_svg_bytes("R2 OK")
        key = f"tests/{uuid.uuid4().hex}.svg"
        url = upload_bytes_to_r2(data, key, ct)
        return {"ok": True, "url": url, "bucket": R2_BUCKET}
    except Exception as e:
        logging.error(f"R2 test upload failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="R2 upload failed")

class BackfillBody(BaseModel):
    email_ids: list[str] | None = None
    limit: int = 50
    only_empty: bool = True

@app.post("/api/feed/backfill-images")
async def backfill_images(body: BackfillBody, request: Request):
    uid = _current_user_id(request)
    try:
        q = Newsletter.select().where(Newsletter.user_id == uid)

        if body.email_ids:
            q = q.where(Newsletter.email_id.in_(body.email_ids))
        elif body.only_empty:
            q = q.where(Newsletter.image_url.is_null(True) | (Newsletter.image_url == ""))

        q = q.limit(max(1, min(200, body.limit)))

        updated = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            for n in q:
                html = n.full_content_html or ""
                kw = await get_ai_keyword(html, client)
                url = await get_pixabay_image_by_query(client, kw)
                
                # Logga subito dopo aver ottenuto l'URL da Pixabay
                logging.info("[BF] uid=%s email_id=%s kw=%r url=%s", uid, n.email_id, kw, url)

                final_url = url
                try:
                    # Questo blocco per l'upload su R2 è opzionale ma lo manteniamo
                    r2_client = _get_r2()
                    if r2_client and url:
                        r = await client.get(url, timeout=20.0, follow_redirects=True)
                        r.raise_for_status()
                        body_bytes = r.content
                        ct = r.headers.get("content-type", "image/jpeg").split(";", 1)[0].lower()
                        ext = "jpg"
                        if ct.endswith("png"): ext = "png"
                        elif ct.endswith("webp"): ext = "webp"
                        
                        key = make_r2_key_from_kw(kw, ext=ext)
                        final_url = upload_bytes_to_r2(body_bytes, key, content_type=ct)
                except Exception as e:
                    logging.warning(f"[BF] R2 upload failed for {n.email_id}, keeping original URL: {e}")

                n.image_url = final_url
                n.save()
                updated.append({"email_id": n.email_id, "image_url": final_url, "image_query": kw})

        return {"ok": True, "updated_items": updated}
    except Exception as e:
        logging.error(f"Backfill error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Backfill failed")
    
@app.get("/api/feed/{email_id}/image-query")
async def get_image_query(email_id: str, request: Request):
    uid = _current_user_id(request)
    try:
        n = Newsletter.get(
            (Newsletter.email_id == email_id) & (Newsletter.user_id == uid)
        )
    except Newsletter.DoesNotExist:
        raise HTTPException(status_code=404, detail="Newsletter non trovata.")

    html = n.full_content_html or ""
    async with httpx.AsyncClient(timeout=20.0) as client:
        kw = await get_ai_keyword(html, client)
    logging.info("[DBG] image-query for %s (uid=%s) -> %r", email_id, uid, kw)
    return {"email_id": email_id, "image_query": kw}

@app.post("/api/feed/{email_id}/favorite")
async def toggle_favorite(email_id: str, request: Request):
    uid = _current_user_id(request)
    try:
        newsletter = Newsletter.get(
            (Newsletter.email_id == email_id) & (Newsletter.user_id == uid)
        )
    except Newsletter.DoesNotExist:
        raise HTTPException(status_code=404, detail="Newsletter non trovata.")

    newsletter.is_favorite = not newsletter.is_favorite
    newsletter.save()
    return {"email_id": email_id, "is_favorite": newsletter.is_favorite}
    
class TagIn(BaseModel):
    tag: str | None

@app.put("/api/feed/{email_id}/tag")
async def set_tag(email_id: str, payload: TagIn, request: Request):
    """Imposta o rimuove un tag per un elemento del feed."""
    uid = _current_user_id(request)
    try:
        n = Newsletter.get((Newsletter.email_id == email_id) & (Newsletter.user_id == uid))
    except Newsletter.DoesNotExist:
        raise HTTPException(status_code=404, detail="Newsletter non trovata.")

    t = (payload.tag or "").strip()
    if len(t) > 32:
        raise HTTPException(status_code=400, detail="Il tag non può superare i 32 caratteri.")
    
    n.tag = t or None
    n.save()
    
    return {"email_id": email_id, "tag": n.tag}

@router_auth.get("/logout") # Spostato su router_auth
async def logout(request: Request):
    user_id = request.session.get("user_id")

    if not user_id or user_id not in CREDENTIALS_STORE:
        raise HTTPException(status_code=401, detail="Non autenticato")

    # Rimuovi credenziali e persisti su disco
    CREDENTIALS_STORE.pop(user_id, None)
    save_credentials_store()

    # Pulisci pool e bearer per-utente
    PHOTOS_POOLS.pop(user_id, None)
    PHOTOS_BEARERS.pop(user_id, None)

    # Svuota la sessione
    try:
        request.session.clear()
    except Exception:
        pass

    return JSONResponse({"ok": True})

class EnrichBody(BaseModel):
    limit: int = 20
    only_missing: bool = True

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
