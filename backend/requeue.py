import os
import sys
import json
import redis
from dotenv import load_dotenv

# Carica le configurazioni come fa il resto dell'app
load_dotenv()
from backend.database import db, Newsletter, initialize_db

def requeue_pending_jobs(user_id: str):
    """
    Trova tutte le newsletter non arricchite per un utente e le aggiunge alla coda di Redis.
    """
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    
    try:
        redis_client = redis.from_url(REDIS_URL, decode_responses=True)
        redis_client.ping()
        print("Connesso a Redis.")
    except redis.exceptions.ConnectionError as e:
        print(f"ERRORE: Impossibile connettersi a Redis: {e}")
        return

    if db.is_closed():
        db.connect()
        print("Connesso al Database.")

    try:
        pending_newsletters = Newsletter.select().where(
            (Newsletter.user_id == user_id) & (Newsletter.enriched == False)
        )

        count = 0
        for nl in pending_newsletters:
            job_payload = json.dumps({"email_id": nl.email_id, "user_id": user_id})
            redis_client.rpush('email_queue', job_payload)
            print(f"Accodando: {nl.email_id}")
            count += 1
        
        print(f"\nOperazione completata. {count} lavori aggiunti alla coda.")

    except Exception as e:
        print(f"ERRORE durante l'esecuzione: {e}")
    finally:
        if not db.is_closed():
            db.close()
            print("Connessione al Database chiusa.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("ERRORE: Fornisci l'ID utente come argomento.")
        print("Esempio: python backend/requeue.py MIO_USER_ID")
        sys.exit(1)
    
    target_user_id = sys.argv[1]
    print(f"--- Avvio ri-accodamento per l'utente: {target_user_id} ---")
    requeue_pending_jobs(target_user_id)