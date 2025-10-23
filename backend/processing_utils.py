# backend/processing_utils.py

import os
import base64
import re
import json
import logging
from typing import Optional, Mapping, Any
import httpx
import io
import asyncio
from PIL import Image
from bs4 import BeautifulSoup
from collections import Counter
from email.utils import parseaddr
from html import escape as html_escape
import random
import httpx

SHARED_HTTP_CLIENT = httpx.AsyncClient(timeout=30.0)

# --- CONFIGURAZIONE ---
MODEL_SUMMARY = "gpt-5-nano"
MODEL_JSON = "gpt-4o-mini"
MODEL_CLASSIFY = "gpt-4o-mini"
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
PIXABAY_KEY = os.getenv("PIXABAY_KEY")
MODEL_SUMMARY = "gpt-5-nano"

ALLOWED_TYPE_TAGS = ["newsletter", "promo", "personali", "informative"]
TOPIC_VOCAB = [
    "tecnologia", "ai", "coding", "design", "marketing", "ecommerce", "finanza",
    "investimenti", "legale", "fiscale", "lavoro", "carriera", "formazione",
    "salute", "fitness", "benessere", "cibo", "viaggi", "moda", "bellezza",
    "casa", "immobiliare", "energia", "sostenibilita", "automotive", "mobilita",
    "gaming", "fotografia", "musica", "cinema", "cultura", "sport", "eventi",
    "istruzione", "politica", "attualita", "analisi", "approfondimento", "generico"
]

CLASSIFY_PROMPT_TEMPLATE = (
    "Sei un classificatore di email. Devi restituire SOLO un JSON valido con due chiavi: "
    "'type_tag' e 'topic_tag'. Niente testo extra.\n\n"

    "Definizione 'type_tag' (scegline UNA):\n"
    "- 'newsletter': invio editoriale/ricorrente (articoli, analisi, raccolte link, blog/press recap) "
    "senza call-to-action commerciale predominante. Include Substack, Morning/Marketing Brew, Techpresso, "
    "digest/issue/weekly recap, 'read in browser', sommari con sezioni, toni giornalistici.\n"
    "- 'promo': sconti/offerte/coupon, % di sconto, 'offerta', 'saldi', 'deal', 'spedizione gratuita', "
    "scadenze e CTA di acquisto (compra ora, usa il codice, carrello, black friday, cyber monday, flash sale).\n"
    "- 'personali': email chiaramente indirizzate a una persona o al team (amici, colleghi, clienti). "
    "Riferimenti a conversazioni, richieste, appuntamenti, task, preventivi, follow-up. "
    "Segnali: toni diretti ('ciao <nome>'), thread RE/FW, saluti personali, firme personali, allegati citati.\n"
    "- 'informative': comunicazioni neutre/di servizio/istituzionali, aggiornamenti prodotto, policy, "
    "notifiche, conferme (registrazione, ricevuta, tracking), comunicati senza taglio editoriale né vendita.\n\n"

    "Regole di disambiguazione (priorità): se ci sono sconti/codici/CTA di acquisto → 'promo'. "
    "Se è editoriale ricorrente (digest/issue/recap) e NON prevale la vendita → 'newsletter'. "
    "Se è conversazionale o indirizzata chiaramente a una persona/teams → 'personali'. "
    "Altrimenti → 'informative'.\n\n"

    "Regole per 'topic_tag': UNA sola parola, minuscola, scelta tra: "
    "{topic_vocab}. Se nessuna è adatta usa 'generico'.\n"
    "Mappa veloce: "
    "ai/coding/data/cloud/security → tecnologia; "
    "ecommerce/ads/social/crm → marketing; "
    "startup/management/legale/fiscale/compliance → business; "
    "investimenti/mercati/crypto → finanza; "
    "hr/recruiting/crescita professionale/formazione → lavoro; "
    "fitness/benessere/psicologia/nutrizione → salute; "
    "viaggi/cibo/moda/bellezza/casa/immobiliare → lifestyle; "
    "automotive/trasporti/micromobilità → mobilita; "
    "energia/clima/esg → sostenibilita; "
    "gaming/musica/cinema/fotografia → intrattenimento; "
    "politica/attualita/analisi/approfondimento → cultura; "
    "sport → sport.\n\n"

    "Output SOLO JSON, es.: {{\"type_tag\":\"newsletter\",\"topic_tag\":\"cultura\"}}\n\n"
    "Contenuto da classificare:\n{content}"
)

__all__ = [
    "b64_urlsafe_decode", "_walk_parts", "extract_html_from_payload", "clean_html",
    "parse_sender", "_cheap_fallback_keyword_from_text", "_extract_json_from_string",
    "_extract_output_text", "extract_domain_from_from_header", "_decode_body",
    "root_domain_py", "get_ai_summary", "classify_type_and_topic",
    "get_ai_keyword", "get_pixabay_image_by_query", "extract_dominant_hex",
    "SHARED_HTTP_CLIENT"
]

_BANNED_KW = {
    "news", "newsletter", "update", "story", "blog", "article", "notizie", "aggiornamenti",
    "email", "mail", "contenuto", "contenuti", "informazioni", "information", "comunicazione",
    "report", "weekly", "daily", "monthly", "post", "pubblicazione"
}

# --- FUNZIONI DI SUPPORTO HTML E TESTO ---

def b64_urlsafe_decode(s: str) -> bytes:
    s = s.replace('-', '+').replace('_', '/')
    pad = (-len(s)) % 4
    if pad: s += '=' * pad
    return base64.b64decode(s)

def _walk_parts(p):
    yield p
    for part in (p.get('parts') or []):
        yield from _walk_parts(part)

def extract_html_from_payload(payload: dict) -> str:
    """
    Estrae il contenuto HTML da un payload di Gmail. Se non presente,
    effettua un fallback al contenuto text/plain, wrappandolo in tag <pre> sicuri.
    """
    if not payload:
        return ""
    
    html_part, plain_part = None, None
    
    # Cerca la prima parte HTML e la prima parte di testo semplice
    for part in _walk_parts(payload):
        mime_type = (part.get("mimeType") or "").lower()
        if mime_type == "text/html" and html_part is None:
            html_part = _decode_body(part)
        elif mime_type == "text/plain" and plain_part is None:
            plain_part = _decode_body(part)

    # Dai priorità all'HTML se esiste
    if html_part:
        return html_part
    
    # Altrimenti, usa il testo semplice come fallback, escapando l'HTML
    if plain_part:
        return f"<pre>{html_escape(plain_part)}</pre>"
        
    return ""

def clean_html(html_content: str) -> str:
    if not html_content: return ""
    soup = BeautifulSoup(html_content, 'html.parser')
    for element in soup(["script", "style", "head", "title", "meta", "header", "footer", "nav", "form"]):
        element.extract()
    return ' '.join(soup.get_text(separator=' ', strip=True).split())

def parse_sender(sender_header: str) -> str:
    """Estrae il nome del mittente in modo sicuro usando parseaddr."""
    name, _ = parseaddr(sender_header or "")
    return (name or "Sconosciuto").strip().strip('"')

def _cheap_fallback_keyword_from_text(text: str) -> str:
    """Estrae una parola chiave di fallback dal testo, gestendo un range di caratteri latini più ampio."""
    if not text:
        return "newsletter"
    # Range completo di caratteri latini (inclusi accenti), parole di 5+ lettere
    tokens = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ]{5,}", text.lower())
    stop = {
        "questo", "questa", "dopo", "prima", "anche", "solo", "molto",
        "about", "there", "their", "which", "while", "after", "before",
        "email", "mail", "contenuto", "newsletter", "notizie", "news",
        "aggiornamenti", "update", "articolo", "article", "report"
    }
    cand = [w for w in tokens if w not in stop]
    if not cand:
        return "newsletter"
    kw, _ = Counter(cand).most_common(1)[0]
    return kw

def _extract_json_from_string(text: str) -> str:
    """Estrae il primo oggetto JSON da una stringa, rispettando virgolette e caratteri di escape."""
    if not text:
        return ""
    start = text.find("{")
    if start == -1:
        return ""
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

def _extract_output_text(d: Mapping[str, Any] | None) -> Optional[str]:
    if not isinstance(d, dict):
        return None

    out = d.get("output")
    outputs = out if isinstance(out, list) else ([out] if isinstance(out, dict) else [])

    for item in outputs:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "message":
            content = item.get("content")
            parts = content if isinstance(content, list) else ([content] if isinstance(content, dict) else [])
            for part in parts:
                if not isinstance(part, dict):
                    continue
                t = part.get("type")
                txt = part.get("text")
                if t in ("output_text", "text") and isinstance(txt, str) and txt.strip():
                    return txt

    txt = d.get("text")
    if isinstance(txt, str) and txt.strip():
        return txt

    ch = d.get("choices")
    if isinstance(ch, list) and ch:
        msg = ch[0]["message"] if isinstance(ch[0], dict) and isinstance(ch[0].get("message"), dict) else {}
        content = msg.get("content")
        if isinstance(content, str):
            return content

    return None


def extract_domain_from_from_header(h: Optional[str]) -> str:
    """Estrae in modo sicuro il dominio da un header 'From' o indirizzo email."""
    if not h:
        return ""
    _, addr = parseaddr(h)
    s = (addr or h or "").strip().strip("<>").strip()
    if not s:
        return ""
    host = s.split("@", 1)[1] if "@" in s else s
    return (host or "").strip().strip(">").lower()
    
# --- FUNZIONI DI ARRICCHIMENTO (AI E IMMAGINI) ---

async def get_ai_summary(content: str, client: httpx.AsyncClient) -> dict:
    raw = content or ""
    clean_content = clean_html(raw)[:4000]

    instructions = """
Developer: # Ruolo e Obiettivo

Sintetizzare il contenuto delle newsletter in un riassunto adatto a un feed in stile Instagram. Obiettivo: dare subito un’idea chiara del tema e un beneficio pratico per il lettore (es. come applicarlo in UX/copy/design).

Istruzioni

Analizza e riassumi il contenuto principale della newsletter.

Descrivi chiaramente di cosa parla, senza gergo inutile.

Escludi contenuti accessibili solo tramite abbonamento o paywall.

Contesto

Il riassunto verrà usato come anteprima in feed visuali tipo Instagram.

Evita link, CTA ed emoji.

Vincoli di stile

Italiano naturale; evita anglicismi (“skippiamo” → “saltiamo”).

Se compaiono termini tecnici, spiegali in 1–3 parole oppure omettili.

Includi almeno un takeaway/uso pratico.

Se citi numeri, max 2 e con contesto.

Niente parentesi lunghe o note fuori flusso.

Modalità di esecuzione

Esegui internamente una checklist di 3–5 passi (identifica tema → seleziona 2–3 punti chiave → formula takeaway → pulizia linguaggio → controllo caratteri).

Non stampare la checklist: l’output deve essere solo JSON.

Requisiti di Output (Obbligatori)

Rispondi esclusivamente con un oggetto JSON valido.

Chiavi richieste: "title" (stringa) e "summary_markdown" (stringa).

"title": massimo 10 parole, in italiano.

"summary_markdown": massimo 300 caratteri, diviso in 2–3 paragrafi separati da una riga vuota; metti in grassetto parole o concetti importanti.

Non inserire link, emoji o checklist.

Output Format

Esempio previsto:

{
  "title": "Illusione della parola ripetuta",
  "summary_markdown": "Perché il cervello **salta** parole comuni.\n\nCos’è (breve), come influisce su **lettura** e **attenzione**. Indicazioni di **layout** applicabili."
}
"""

    user_input = f"Testo da analizzare:\n---\n{clean_html(content)[:4000]}\n---"

    try:
        if not OPENAI_API_KEY:
            raise ValueError("OpenAI API Key non trovata.")
        
        payload = {
            "model": MODEL_SUMMARY,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": instructions}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_input}]}
            ],
            "text": {"format": {"type": "json_object"}, "verbosity": "low"},
            "reasoning": {"effort": "minimal"},
            "max_output_tokens": 600
        }

        # Usa il client condiviso
        resp = await SHARED_HTTP_CLIENT.post(
            "https://api.openai.com/v1/responses",
            json=payload,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"}
        )
        resp.raise_for_status()
        data = resp.json()
        
        text = _extract_output_text(data)
        if not text:
            raise ValueError("Risposta AI senza testo utile.")
        json_str = _extract_json_from_string(text)
        obj = json.loads(json_str) if json_str else {}

        if not isinstance(obj, dict) or "title" not in obj or "summary_markdown" not in obj:
            raise ValueError("JSON non valido o chiavi richieste mancanti.")

        obj["title"] = str(obj["title"])[:200]
        obj["summary_markdown"] = str(obj["summary_markdown"])[:1200]
        return obj

    except Exception as e:
        logging.error(f"Errore in get_ai_summary (OpenAI): {e}", exc_info=True)
        return {"title": "Elaborazione in corso...", "summary_markdown": "Il riassunto sarà presto disponibile."}

def build_classify_prompt(clean_content: str) -> str:
    """Costruisce il prompt completo per la classificazione."""
    return CLASSIFY_PROMPT_TEMPLATE.format(
        topic_vocab=", ".join(TOPIC_VOCAB),
        content=clean_content.strip()[:12000]  # Limite di sicurezza sulla lunghezza
    )

def _extract_json(text: str) -> dict:
    """Estrae un oggetto JSON da una stringa, anche se circondato da altro testo."""
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Tenta di estrarre il primo blocco JSON valido
        m = re.search(r"\{.*\}", text, flags=re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    return {}

def _sanitize_value(value: str) -> str:
    """Pulisce e normalizza una stringa."""
    return (value or "").strip().lower()

def _coerce_tags(obj: dict) -> dict:
    """Valida i tag restituiti dall'LLM e applica fallback sicuri."""
    ttype = _sanitize_value(obj.get("type_tag", ""))
    topic = _sanitize_value(obj.get("topic_tag", ""))

    if ttype not in ALLOWED_TYPE_TAGS:
        ttype = "informative"

    if topic not in TOPIC_VOCAB:
        topic = "generico"

    return {"type_tag": ttype, "topic_tag": topic}

# --- FUNZIONE PRINCIPALE DI CLASSIFICAZIONE (SOSTITUITA) ---

async def classify_type_and_topic(content: str, client: httpx.AsyncClient) -> dict:
    clean_content = clean_html(content)
    prompt = build_classify_prompt(clean_content)
    
    try:
        if not OPENAI_API_KEY:
            raise ValueError("OpenAI API Key non trovata.")
        
        payload = {
            "model": MODEL_CLASSIFY,
            "messages": [
                {"role": "system", "content": "Sei un classificatore rigoroso che risponde solo con JSON."},
                {"role": "user", "content": prompt}
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.0,
            "max_tokens": 120
        }
        
        # Usa il client condiviso
        resp = await SHARED_HTTP_CLIENT.post(
            "https://api.openai.com/v1/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"}
        )
        resp.raise_for_status()
        
        data = resp.json()
        raw_content = data["choices"][0]["message"]["content"]
        
        obj = _extract_json(raw_content)
        return _coerce_tags(obj)
        
    except Exception as e:
        logging.error(f"Errore in classify_type_and_topic: {e}")
        return {"type_tag": "informative", "topic_tag": "generico"}
    
def _decode_body(part_or_body) -> str:
    """
    Decodifica il contenuto in UTF-8.
    - Se riceve un 'part' Gmail (dict), apre part['body']['data'] (base64url).
    - Se riceve str/bytes, prova a decodificarli.
    """
    if not part_or_body:
        return ""

    # Caso 1: Gmail part (dict con body->data base64url)
    if isinstance(part_or_body, dict):
        try:
            body = (part_or_body.get('body') or {})
            data = body.get('data')
            if isinstance(data, str) and data:
                return b64_urlsafe_decode(data).decode("utf-8", "replace")
        except Exception:
            return ""
        return ""

    # Caso 2: bytes -> utf-8 safe
    if isinstance(part_or_body, (bytes, bytearray)):
        try:
            return bytes(part_or_body).decode("utf-8", "ignore")
        except Exception:
            return ""

    # Caso 3: str -> assumiamo base64url (fallback: ritorna la stringa)
    if isinstance(part_or_body, str):
        try:
            return b64_urlsafe_decode(part_or_body).decode("utf-8", "ignore")
        except Exception:
            return part_or_body  # già testo

    return ""


def root_domain_py(url: str) -> str:
    """
    Restituisce il domain "radice" (e.g. example.com, example.co.uk) da una URL o hostname.
    - Se è un IP o localhost, restituisce quello.
    - Prova ad usare tldextract se installato; altrimenti fallback naive.
    """
    if not url:
        return ""
    try:
        # Prima prova con tldextract (se presente)
        import tldextract  # type: ignore
        ext = tldextract.extract(url)
        if ext.domain and ext.suffix:
            return f"{ext.domain}.{ext.suffix}".lower()
        # Se manca suffix (es. localhost), cade al fallback
    except Exception:
        pass

    from urllib.parse import urlparse
    import ipaddress

    host = urlparse(url).netloc or url
    host = host.split("@")[-1].split(":")[0].strip("[]").lower()
    if not host:
        return ""

    # IP o localhost
    if host == "localhost":
        return "localhost"
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass

    # Rimuovi www.
    if host.startswith("www."):
        host = host[4:]

    # Fallback semplice: ultime due etichette (non perfetto per tutti i TLD es. co.uk)
    parts = [p for p in host.split(".") if p]
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return host

async def get_ai_keyword(content: str, client: httpx.AsyncClient) -> str:
    base = clean_html(content)[:2000]
    instructions = """
    Analizza il testo di una newsletter. Restituisci un oggetto JSON con una singola chiave "keyword".
    Il valore deve essere una frase di 1-3 parole in inglese, concreta e visivamente rappresentabile.
    Evita termini generici come "news" o "update" e nomi di brand.
    """ # Il prompt rimane invariato
    try:
        if not OPENAI_API_KEY: raise ValueError("OpenAI API Key non trovata.")
        payload = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "system", "content": instructions}, {"role": "user", "content": base}],
            "response_format": {"type": "json_object"}
        }
        # Usa il client condiviso
        resp = await SHARED_HTTP_CLIENT.post(
            "https://api.openai.com/v1/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"}
        )
        resp.raise_for_status()
        data = resp.json()
        obj = json.loads(data["choices"][0]["message"]["content"])
        kw = (obj.get("keyword") or "").strip()
        if not kw or kw.lower() in _BANNED_KW: return _cheap_fallback_keyword_from_text(base)
        return kw
    except Exception as e:
        logging.error(f"Errore in get_ai_keyword (OpenAI): {e}", exc_info=True)
        return _cheap_fallback_keyword_from_text(base)

async def get_pixabay_image_by_query(client: httpx.AsyncClient, query: str) -> str | None:
    """
    Interroga l'API di Pixabay e restituisce l'URL della migliore immagine trovata.
    Versione corretta e robusta.
    """
    if not PIXABAY_KEY:
        logging.warning("PIXABAY_KEY non è impostata, impossibile cercare immagini.")
        return None

    # Pulisce e prepara la query
    q = (query or "newsletter").strip()
    
    params = {
        "key": PIXABAY_KEY,
        "q": q,
        "image_type": "photo",
        "orientation": "horizontal",
        "safesearch": "true",
        "order": "popular",
        "per_page": 10,
    }

    try:
        r = await client.get("https://pixabay.com/api/", params=params, timeout=15.0)
        r.raise_for_status()
        data = r.json()
        
        hits = data.get("hits", [])
        
        if not hits:
            logging.warning(f"Nessun risultato da Pixabay per la query: '{q}'")
            return None

        # Scegli un'immagine a caso tra i primi risultati per avere più varietà
        best_hit = random.choice(hits)
        
        # Estrai l'URL, con fallback
        image_url = best_hit.get("largeImageURL") or best_hit.get("webformatURL")

        if not image_url:
            logging.error(f"Trovato risultato da Pixabay per '{q}', ma manca 'largeImageURL'. Dati: {best_hit}")
            return None
            
        logging.info(f"Trovato URL da Pixabay per '{q}': {image_url}")
        return image_url

    except httpx.HTTPStatusError as e:
        logging.error(f"Errore HTTP da Pixabay per query '{q}': {e.response.status_code} - {e.response.text}")
        return None
    except Exception as e:
        logging.error(f"Errore imprevisto durante la ricerca su Pixabay per '{q}': {e}", exc_info=True)
        return None

def extract_dominant_hex(img_bytes: bytes) -> str:
    try:
        im = Image.open(io.BytesIO(img_bytes)).convert("RGBA").resize((64, 64))
        pal = im.convert("P", palette=Image.Palette.ADAPTIVE, colors=8)
        palette = pal.getpalette() or []
        counts = pal.getcolors() or []
        counts = sorted(counts, reverse=True)
        if not counts or not palette:
            return "#374151"
        for _, idx in counts:
            base = idx * 3
            if base + 2 >= len(palette):
                continue
            r, g, b = palette[base: base+3]
            if (0.299*r + 0.587*g + 0.114*b) < 20: continue
            dark_r, dark_g, dark_b = int(r*0.7), int(g*0.7), int(b*0.7)
            if 25 <= (0.299*dark_r + 0.587*dark_g + 0.114*dark_b) <= 120:
                return f"#{dark_r:02x}{dark_g:02x}{dark_b:02x}"
    except Exception as e:
        logging.warning(f"[COLOR] Errore estrazione colore: {e}")
    return "#374151"