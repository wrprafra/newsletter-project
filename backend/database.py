import logging
import os
from pathlib import Path
from peewee import (
    SqliteDatabase, Model, CharField, TextField, BooleanField, DateTimeField, CompositeKey
)

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "newsletter.db"
print(f"*** Inizializzazione del database in: {DB_PATH} ***")

# Aggiunto str() per coerenza con la documentazione di Peewee
db = SqliteDatabase(str(DB_PATH), pragmas={
    "journal_mode": "wal",
    "synchronous": 1,
    "temp_store": "memory",
    "cache_size": -20000,
})

class BaseModel(Model):
    class Meta:
        database = db

class Newsletter(BaseModel):
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
    rfc822_message_id = CharField(null=True)

    # --- INIZIO FIX ---
    # La classe Meta non eredita più da BaseModel.Meta per evitare crash.
    # L'attributo 'database = db' viene ereditato automaticamente da BaseModel.
    class Meta:
        table_name = "newsletter"
        primary_key = CompositeKey("email_id", "user_id")
        indexes = ((("user_id", "thread_id"), False),)
    # --- FINE FIX ---

class DomainTypeOverride(BaseModel):
    user_id = CharField(index=True)
    domain = CharField()
    type_tag = CharField(max_length=24)

    # --- INIZIO FIX ---
    # Anche qui, la classe Meta non eredita più.
    class Meta:
        table_name = "domain_type_override"
        primary_key = CompositeKey("user_id", "domain")
    # --- FINE FIX ---

def initialize_db():
    try:
        logging.info("DB: Tentativo di creare le tabelle (safe=True)...")
        db.create_tables([Newsletter, DomainTypeOverride], safe=True)

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

        db.execute_sql("""
            CREATE INDEX IF NOT EXISTS idx_feed_seek
            ON newsletter(user_id, is_complete, is_deleted, received_date DESC, email_id DESC);
        """)
        db.execute_sql("""
            CREATE INDEX IF NOT EXISTS idx_feed_favorites
            ON newsletter(user_id, is_favorite, received_date DESC, email_id DESC);
        """)
        db.execute_sql("DROP INDEX IF EXISTS idx_news_user_complete_date_id;")
        db.execute_sql("DROP INDEX IF EXISTS idx_feed;")
        db.execute_sql("DROP INDEX IF EXISTS idx_news_user_fav;")
        db.execute_sql("DROP INDEX IF EXISTS idx_news_user_complete_domain_date;")

        logging.info("DB: Inizializzazione e migrazione completate.")
    except Exception as e:
        logging.error(f"DB: Errore durante l'inizializzazione o la migrazione: {e}")