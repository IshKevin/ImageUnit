#!/usr/bin/env bash
# Backs up the database (pg_dump, custom format) and the media bucket (mirror).
# Usage: ops/backup.sh [backup_dir]      Defaults suit the local docker-compose stack.
# Production: set PG_URL / S3_* and run from cron or your scheduler; ship $BACKUP_DIR off-site.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] && set -a && . "./$ENV_FILE" && set +a

BACKUP_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/$STAMP"
mkdir -p "$TARGET/media"

echo "==> Database dump"
if [ -n "${PG_URL:-}" ]; then
  pg_dump --format=custom --no-owner "$PG_URL" > "$TARGET/db.dump"
else
  docker compose exec -T postgres pg_dump -U imageunit --format=custom --no-owner imageunit > "$TARGET/db.dump"
fi

echo "==> Media mirror ($S3_BUCKET)"
# rclone (maintained, storage-agnostic) talks S3 to whatever backs the platform. --network host reaches the
# published S3 port on this machine; set S3_BACKUP_ENDPOINT if the storage lives elsewhere.
docker run --rm --network host -v "$(cd "$TARGET/media" && pwd):/backup" \
  -e RCLONE_CONFIG_SRC_TYPE=s3 -e RCLONE_CONFIG_SRC_PROVIDER=Other \
  -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID="$S3_ACCESS_KEY" -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
  -e RCLONE_CONFIG_SRC_ENDPOINT="${S3_BACKUP_ENDPOINT:-http://127.0.0.1:8333}" -e RCLONE_CONFIG_SRC_FORCE_PATH_STYLE=true \
  rclone/rclone sync "src:${S3_BUCKET}" /backup --checksum --stats-one-line

# Manifest lets restore-test.sh verify the backup without trusting it blindly.
DB_ROWS_PHOTOS="$(docker compose exec -T postgres psql -U imageunit -Atc 'select count(*) from photos' imageunit 2>/dev/null || echo unknown)"
MEDIA_FILES="$(find "$TARGET/media" -type f | wc -l | tr -d ' ')"
cat > "$TARGET/manifest.json" <<JSON
{ "createdAt": "$STAMP", "photosInDatabase": "$DB_ROWS_PHOTOS", "mediaFiles": $MEDIA_FILES, "dbDumpBytes": $(stat -c %s "$TARGET/db.dump") }
JSON
( cd "$TARGET" && sha256sum db.dump > db.dump.sha256 )
echo "==> Backup complete: $TARGET"
cat "$TARGET/manifest.json"
