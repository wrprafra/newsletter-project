#!/usr/bin/env bash
set -Eeuo pipefail

# Newsletter diagnostics collector (server-side)
TS="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="/tmp/newsletter_diag_${TS}"
mkdir -p "$OUT_DIR" "$OUT_DIR/nginx" "$OUT_DIR/docker" "$OUT_DIR/app" || true

log() { echo "[diag] $*"; }
run() { local name="$1"; shift; { echo "# cmd: $*"; echo; "$@"; } >"$OUT_DIR/${name}" 2>&1 || true; }

mask_env() {
  sed -E 's/(password|passwd|secret|token|key|cookie|session|apikey|api_key|jwt|private|auth|credential)\s*=\s*[^#\r\n]*/\1=[REDACTED]/Ig'
}

log "Output: $OUT_DIR"

# System info
run system_info.txt bash -lc 'whoami; hostname -f || hostname; uname -a; [ -f /etc/os-release ] && cat /etc/os-release || true; uptime; date -u'

# Project tree
run ls_opt_newsletter.txt ls -la /opt/newsletter
run find_opt_newsletter.txt bash -lc "find /opt/newsletter -maxdepth 2 -mindepth 1 -printf '%y %p\n' | sort"

# Sanitize app env
if [ -f /opt/newsletter/.env ]; then
  mask_env < /opt/newsletter/.env > "$OUT_DIR/app/.env.masked.txt" || true
fi

# Docker
if command -v docker >/dev/null 2>&1; then
  run docker/ps.txt docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  for s in newsletter-app-1 newsletter-worker-1 newsletter-ingestor-1 newsletter-redis-1; do
    docker logs --tail=1000 "$s" > "$OUT_DIR/docker/${s}_logs.txt" 2>&1 || true
    docker inspect "$s" > "$OUT_DIR/docker/${s}_inspect.json" 2>&1 || true
  done
fi

# Nginx
if [ -d /etc/nginx ]; then
  run nginx_test.txt nginx -t
  run nginx_site_gist.txt bash -lc 'sed -n "1,200p" /etc/nginx/sites-enabled/gist'
  run nginx_server_name.txt bash -lc 'grep -Rni "server_name" /etc/nginx/sites-enabled/gist || true'
  tail -n 200 /var/log/nginx/access.log > "$OUT_DIR/nginx/access.log.tail" 2>/dev/null || true
  tail -n 200 /var/log/nginx/access.log.1 > "$OUT_DIR/nginx/access.log.1.tail" 2>/dev/null || true
  tail -n 200 /var/log/nginx/error.log > "$OUT_DIR/nginx/error.log.tail" 2>/dev/null || true
  awk '/\/(api\/auth\/me)/ {print $9}' /var/log/nginx/access.log 2>/dev/null | sort | uniq -c | sort -nr > "$OUT_DIR/nginx/auth_me_status_counts.txt" || true
fi

# Summary
{
  echo "== SUMMARY =="
  echo "Auth ME status counts (latest access.log):"
  [ -f "$OUT_DIR/nginx/auth_me_status_counts.txt" ] && cat "$OUT_DIR/nginx/auth_me_status_counts.txt" || echo "(no data)"
  echo
  echo "Cookie policy expected: host-only domain (SESSION_DOMAIN empty), SameSite=None; Secure"
} > "$OUT_DIR/summary.txt"

tar czf /tmp/newsletter_diag_latest.tgz -C / tmp/$(basename "$OUT_DIR") >/dev/null 2>&1 || true
echo "$OUT_DIR"
