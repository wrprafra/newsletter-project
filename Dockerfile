# Dockerfile
FROM python:3.12-slim

# Dipendenze native comuni; aggiungi/rimuovi se build fallisce
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc git curl \
    libffi-dev libssl-dev \
    libxml2-dev libxslt1-dev zlib1g-dev \
    libjpeg-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY requirements.txt /app/
RUN python -m pip install -U pip setuptools wheel && pip install -r requirements.txt

COPY . /app

# Non root
RUN useradd -m appuser && \
    mkdir -p /app/logs && \
    chown -R appuser:appuser /app/logs

# Uvicorn
EXPOSE 8000
CMD ["uvicorn","backend.main:app","--host","0.0.0.0","--port","8000","--proxy-headers","--forwarded-allow-ips","*"]