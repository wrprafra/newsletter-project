import sqlite3

DB_PATH = "/app/data/newsletter.db"
con = sqlite3.connect(DB_PATH)
cur = con.cursor()

# Esegue il comando per cancellare TUTTE le righe dalla tabella newsletter
cur.execute("DELETE FROM newsletter")

# Salva le modifiche e stampa il risultato
con.commit()
print(f"Cancellate {cur.rowcount} email dal database.")

con.close()