import logging
import sys
import os # Importiamo os per una piccola modifica

def setup_logging(process_name: str):
    """
    Configura il logging per scrivere su file separati per ogni processo.
    Ogni volta che un processo parte, il suo file di log specifico viene CANCELLATO
    e riscritto da capo.
    """
    # 1. Crea un nome di file univoco basato sul nome del processo.
    log_filename = f"{process_name.lower()}.txt"

    # 2. Definisci un formato di log.
    log_formatter = logging.Formatter(
        f"[%(asctime)s] [%(levelname)s] [{process_name}] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    # --- INIZIO MODIFICA CHIAVE ---

    # 3. Usa il normale FileHandler con mode='w' (write).
    #    Questo dice al logger di aprire il file in modalità scrittura,
    #    CANCELLANDO il contenuto precedente se il file esiste già.
    #    È il modo più semplice e sicuro per avere un log pulito a ogni avvio.
    file_handler = logging.FileHandler(log_filename, mode='w', encoding='utf-8')
    
    # --- FINE MODIFICA CHIAVE ---
    
    file_handler.setFormatter(log_formatter)

    # 4. Configura l'handler per la console (stdout) come prima.
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(log_formatter)

    # 5. Configura il logger root.
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    
    # Pulisci eventuali handler pre-esistenti per evitare output duplicati
    root_logger.handlers = [] 
    
    # Aggiungi i nuovi handler
    root_logger.addHandler(file_handler)
    root_logger.addHandler(stream_handler)

    logging.info(f"Logging configurato. L'output verrà scritto da capo su '{log_filename}'.")