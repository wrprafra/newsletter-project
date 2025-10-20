# backend/database.py

import logging
import os
from pathlib import Path
from peewee import (
    SqliteDatabase,
    Model,
    CharField,
    TextField,
    BooleanField,
    DateTimeField,
    CompositeKey  # <-- 1. DEVI IMPORTARE CompositeKey
)

DATA_DIR = Path("/app/data")

# 2. Assicurati che questa directory esista all'interno del container.
#    Questo comando è sicuro da eseguire ogni volta.
DATA_DIR.mkdir(parents=True, exist_ok=True)

# 3. Definisci il percorso completo del file del database.
DB_PATH = DATA_DIR / "newsletter.db"

print(f"*** Inizializzazione del database in: {DB_PATH} ***")

# Il database viene creato nella cartella principale del progetto
# NOTA: ../newsletter.db significa che il file sarà FUORI dalla cartella 'backend'.
# Se è quello che vuoi, va bene. Altrimenti, usa 'newsletter.db' per tenerlo dentro 'backend'.
db = SqliteDatabase(DB_PATH, pragmas={
    "journal_mode": "wal",      # scritture non bloccano letture
    "synchronous": 1,           # NORMAL
    "temp_store": "memory",
    "cache_size": -20000        # ~20MB cache
})

class BaseModel(Model):
    class Meta:
        database = db

# --- INIZIO MODIFICHE ---

# 2. QUESTA CLASSE Meta ERA FUORI POSTO E VA CANCELLATA
# class Meta:
#         database = db
#         primary_key = CompositeKey('email_id', 'user_id')

class Newsletter(BaseModel):
    # 3. RIMUOVI unique=True DA QUI
    # email_id = CharField(unique=True)
    email_id = CharField()
    user_id = CharField(index=True)
    sender_name = CharField(null=True)
    sender_email = CharField(null=True)
    original_subject = TextField(null=True)
    ai_title = TextField(null=True)
    ai_summary_markdown = TextField(null=True)
    image_url = TextField(null=True)
    full_content_html = TextField(null=True)
    received_date = DateTimeField()
    is_favorite = BooleanField(default=False)
    enriched = BooleanField(default=False)
    is_complete = BooleanField(default=False)
    is_deleted = BooleanField(default=False)
    accent_hex = CharField(null=True)
    tag = CharField(max_length=32, null=True, index=True)
    type_tag = CharField(max_length=24, null=True, index=True)
    topic_tag = CharField(max_length=32, null=True, index=True)
    source_domain = CharField(null=True, index=True)
    thread_id = CharField(null=True, index=True)
    rfc822_message_id = CharField(null=True) # Rimosso index=True se non necessario per query

    # 4. LA CLASSE Meta VA MESSA QUI, DENTRO la classe Newsletter
    class Meta:
        database = db
        primary_key = CompositeKey('email_id', 'user_id')
        indexes = (
            # Indice UNICO per prevenire duplicati di thread per utente
            (('user_id', 'thread_id'), True),
        )

class DomainTypeOverride(BaseModel):
    user_id = CharField(index=True)
    domain = CharField()
    type_tag = CharField(max_length=24)

    class Meta:
        primary_key = CompositeKey('user_id', 'domain')

# --- FINE MODIFICHE ---

def initialize_db():
    """Crea la tabella, aggiunge le nuove colonne e crea gli indici se non esistono."""
    try:
        logging.info("DB: Tentativo di creare la tabella 'Newsletter' (safe=True)...")
        db.create_tables([Newsletter, DomainTypeOverride], safe=True)
        
        # Migrazione leggera per aggiungere le nuove colonne
        cols = {c.name for c in db.get_columns('newsletter')}
        if 'type_tag' not in cols:
            logging.info("DB: Aggiungo colonna 'type_tag'...")
            db.execute_sql('ALTER TABLE newsletter ADD COLUMN type_tag VARCHAR(24);')
        if 'topic_tag' not in cols:
            logging.info("DB: Aggiungo colonna 'topic_tag'...")
            db.execute_sql('ALTER TABLE newsletter ADD COLUMN topic_tag VARCHAR(32);')
        if 'source_domain' not in cols:
            logging.info("DB: Aggiungo colonna 'source_domain'...")
            db.execute_sql('ALTER TABLE newsletter ADD COLUMN source_domain TEXT;')
        if 'thread_id' not in cols:
            logging.info("DB: Aggiungo colonna 'thread_id'...")
            db.execute_sql('ALTER TABLE newsletter ADD COLUMN thread_id TEXT;')
        if 'rfc822_message_id' not in cols:
            logging.info("DB: Aggiungo colonna 'rfc822_message_id'...")
            db.execute_sql('ALTER TABLE newsletter ADD COLUMN rfc822_message_id TEXT;')
        if 'is_deleted' not in cols:
            logging.info("DB: Aggiungo colonna 'is_deleted'...")
            db.execute_sql('ALTER TABLE newsletter ADD COLUMN is_deleted BOOLEAN DEFAULT 0;')

        logging.info("DB: Assicuro la presenza degli indici ottimizzati...")

        # 1. Indice principale per la paginazione del feed (sostituisce idx_feed e altri).
        db.execute_sql("""
            CREATE INDEX IF NOT EXISTS idx_feed_seek
            ON newsletter(user_id, is_complete, is_deleted, received_date DESC, email_id DESC);
        """)

        # 2. Indice ottimizzato per la vista "Preferiti".
        db.execute_sql("""
            CREATE INDEX IF NOT EXISTS idx_feed_favorites
            ON newsletter(user_id, is_favorite, received_date DESC, email_id DESC);
        """)
        
        # 3. Pulizia una tantum dei vecchi indici ridondanti.
        #    Questi comandi sono sicuri e non fanno nulla se gli indici non esistono.
        db.execute_sql("DROP INDEX IF EXISTS idx_news_user_complete_date_id;")
        db.execute_sql("DROP INDEX IF EXISTS idx_feed;")
        db.execute_sql("DROP INDEX IF EXISTS idx_news_user_fav;")
        db.execute_sql("DROP INDEX IF EXISTS idx_news_user_complete_domain_date;")

        logging.info("DB: Inizializzazione e migrazione completate.")
    except Exception as e:
        logging.error(f"DB: Errore durante l'inizializzazione o la migrazione: {e}")