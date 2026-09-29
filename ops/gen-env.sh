#!/usr/bin/env bash
# Generates .env.production with strong random secrets for a self-hosted deployment.
# Usage: ops/gen-env.sh <domain> [admin-email]      e.g. ops/gen-env.sh photos-company.com admin@company.com
# Never overwrites an existing file (rotating secrets would lock out sessions and website keys).
set -euo pipefail
cd "$(dirname "$0")/.."
DOMAIN="${1:?usage: gen-env.sh <domain> [admin-email]}"
ADMIN_EMAIL="${2:-admin@$DOMAIN}"
OUT=".env.production"
[ -e "$OUT" ] && { echo "$OUT already exists. Delete it first if you really want new secrets."; exit 1; }

rand() { openssl rand -base64 "$1" | tr -d '=+/\n' | cut -c1-"$2"; }
ADMIN_PASS="$(rand 24 20)aA1!"

umask 077
cat > "$OUT" <<ENV
# ImageUnit production environment — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# KEEP SECRET. Not committed to git. Back this file up somewhere safe (password manager):
# losing SESSION_SECRET signs everyone out and invalidates every website's signed media links.
# Used by:  make prod-up   (compose builds internal URLs for Postgres/Redis/S3 from the passwords below)

NODE_ENV=production
LOG_LEVEL=info

# ---- Public hostnames (DNS A/AAAA records for all three must point at this server) ----
DOMAIN=$DOMAIN
PUBLIC_WEB_URL=https://photos.$DOMAIN
API_PUBLIC_URL=https://api.$DOMAIN
S3_PUBLIC_ENDPOINT=https://media.$DOMAIN

# ---- Behind Caddy (TLS terminates there); infrastructure ports stay on 127.0.0.1 ----
COOKIE_SECURE=true
TRUST_PROXY=true
BIND_ADDR=127.0.0.1

# ---- Secrets ----
SESSION_SECRET=$(openssl rand -hex 32)
METRICS_TOKEN=$(rand 36 40)
POSTGRES_PASSWORD=$(rand 36 40)
REDIS_PASSWORD=$(rand 36 40)
S3_ACCESS_KEY=iu$(rand 12 12)
S3_SECRET_KEY=$(rand 36 40)
LOGIN_RATE_LIMIT=10

# ---- First administrator (created on first boot only when no admin exists; remove both lines afterwards) ----
BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASS

# ---- Application ----
S3_BUCKET=imageunit-media
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
# Capacity used for the storage dashboard and alerts (bytes). 1 TB = 1099511627776.
STORAGE_TOTAL_BYTES=1099511627776
MAX_UPLOAD_BYTES=104857600
WORKER_CONCURRENCY=4
ENV
chmod 600 "$OUT"
echo "Wrote $OUT (mode 600)."
echo "  Web:    https://photos.$DOMAIN"
echo "  API:    https://api.$DOMAIN   (for company websites: /api/v1/*)"
echo "  Media:  https://media.$DOMAIN (browser uploads/downloads via presigned URLs)"
echo "  Admin:  $ADMIN_EMAIL  — initial password is in $OUT (BOOTSTRAP_ADMIN_PASSWORD); change it after first login."
echo "Next: make prod-up"
