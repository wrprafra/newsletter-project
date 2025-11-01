# Agents Guide — newsletter-project

Questo file guida l'agent (e te) per sviluppare, fare deploy e diagnosticare questo progetto in autonomia.

## Server & Ops Runbook
- SSH: `ssh root@65.108.84.121` (chiave, no password in chat).
- Deploy dir: `/opt/newsletter` (Docker Compose; non è un repo git sul server).
- Domain: `app.thegist.tech` via Nginx → proxy su `127.0.0.1:8000`.
- Cookie di sessione: host‑only (nessun Domain) + `SameSite=None; Secure`.
  - Nginx deve avere: `proxy_cookie_flags nl_sess SameSite=None Secure;`

### Quick Checks
- Stato container: `ssh root@65.108.84.121 "cd /opt/newsletter && docker compose ps"`
- Log app live: `ssh root@65.108.84.121 "cd /opt/newsletter && docker compose logs -f app"`
- Nginx test: `ssh root@65.108.84.121 "nginx -t && tail -n 200 /var/log/nginx/error.log"`
- Endpoint utili: `/debug/oauth-config`, `/debug/auth-state` (richiede cookie `nl_sess`).

### Domain & Proxy
- Site: `/etc/nginx/sites-enabled/gist` (server_name `app.thegist.tech`).
- Blocchi fondamentali nella `location /`:
  - `proxy_pass http://127.0.0.1:8000;`
  - `proxy_set_header Host $host;`
  - `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
  - `proxy_set_header X-Forwarded-Proto $scheme;`
  - `proxy_set_header X-Forwarded-Host $host;`
  - `proxy_cookie_flags nl_sess SameSite=None Secure;`

## CI/CD (Build & Deploy)
- Repo locale: `CWD: /mnt/c/Users/francesco.prandi_web/Desktop/newsletter` (questo è un repo Git con remoto GitHub).
- Workflow: `.github/workflows/deploy.yml`
  - Build & push immagine su GHCR: `ghcr.io/wrprafra/newsletter-project`.
  - Deploy: copia `docker-compose.yml` su `/opt/newsletter` e poi, via SSH:
    - login a GHCR (pull immagine)
    - imposta `.env` con chiavi base:
      - `FRONTEND_ORIGIN=https://app.thegist.tech`
      - `REDIRECT_URI=https://app.thegist.tech/auth/callback`
      - `SESSION_DOMAIN=""` (vuoto = host‑only cookie)
      - `SESSION_HTTPS_ONLY=True`
    - assicura in Nginx: `proxy_cookie_flags nl_sess SameSite=None Secure;` e `nginx -t && reload`
    - `docker compose up -d`

### Secrets richiesti (GitHub Actions)
- Build:
  - `GHCR_USERNAME`, `GHCR_TOKEN`
- Deploy:
  - `SERVER_HOST` (65.108.84.121), `SERVER_USER` (es. `root`), `SSH_KEY` (chiave privata)

## Incident Playbook
- Mobile fa login → splash → torna a home
  - Controlla `/var/log/nginx/access.log` per `/api/auth/me 401` ripetuti.
  - Verifica `.env` sul server: `grep '^SESSION_DOMAIN=' /opt/newsletter/.env` → deve essere vuoto.
  - Verifica header Set‑Cookie: `curl -sSik https://app.thegist.tech/auth/login | grep -i '^set-cookie: nl_sess'` → non deve avere `domain=`.
  - Se manca, forza in Nginx: `proxy_cookie_flags nl_sess SameSite=None Secure;` e reload.
  - Prova da mobile in anonimo / cancella dati sito (PWA/Service Worker può cacheare).

## Diagnostica rapida
- Script: `scripts/collect_newsletter_diagnostics.sh`
  - Upload: `scp scripts/collect_newsletter_diagnostics.sh root@65.108.84.121:/tmp/collect.sh`
  - Run: `ssh root@65.108.84.121 'bash /tmp/collect.sh'`
  - Output: `/tmp/newsletter_diag_YYYYMMDD_HHMMSS` e `/tmp/newsletter_diag_latest.tgz` (scaricalo con `scp`)

## Bootstrap sessione (da incollare in Codex)
- Progetto: newsletter. CWD: /mnt/c/Users/francesco.prandi_web/Desktop/newsletter. Leggi AGENTS.md e segui “Server & Ops Runbook”. Primo task: verifica docker compose ps e tail dei log app via SSH su /opt/newsletter; se login mobile in loop, valida cookie host‑only e proxy_cookie_flags; poi riassumi stato e next steps.

## Note
- Non committare segreti. Usa Secrets GitHub e `.env` sul server.
- I container mappano `127.0.0.1:8000` solo in loopback (dietro Nginx).
