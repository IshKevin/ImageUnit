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
PG_PASS="$(rand 36 40)"; REDIS_PASS="$(rand 36 40)"
MINIO_USER="iu$(rand 12 12)"; MINIO_PASS="$(rand 36 40)"
ADMIN_PASS="$(rand 24 20)aA1!"

umask 077
cat > "$OUT" <<ENV
# ImageUnit production environment — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# KEEP SECRET. Not committed to git. Back this file up somewhere safe (password manager):
# losing SESSION_SECRET signs everyone out and invalidates every website's signed media links.

NODE_ENV=production
PORT=4000
LOG_LEVEL=info

# ---- Public hostnames (DNS A/AAAA records for all three must point at this server) ----
DOMAIN=$DOMAIN
PUBLIC_WEB_URL=https://photos.$DOMAIN
API_PUBLIC_URL=https://api.$DOMAIN
S3_PUBLIC_ENDPOINT=https://media.$DOMAIN

# ---- Behind Caddy (TLS terminates there) ----
COOKIE_SECURE=true
TRUST_PROXY=true

# ---- Secrets ----
SESSION_SECRET=$(openssl rand -hex 32)
METRICS_TOKEN=$(rand 36 40)
LOGIN_RATE_LIMIT=10

# ---- First administrator (created on first boot only when no admin exists; remove both lines afterwards) ----
BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASS

# ---- Self-hosted infrastructure (compose profile "selfhosted"). For managed services, replace the URLs below
# ---- and run without the profile.
POSTGRES_PASSWORD=$PG_PASS
REDIS_PASSWORD=$REDIS_PASS
MINIO_ROOT_USER=$MINIO_USER
MINIO_ROOT_PASSWORD=$MINIO_PASS

DATABASE_URL=postgres://imageunit:$PG_PASS@postgres:5432/imageunit
REDIS_URL=redis://:$REDIS_PASS@redis:6379

S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=imageunit-media
S3_ACCESS_KEY=$MINIO_USER
S3_SECRET_KEY=$MINIO_PASS
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
