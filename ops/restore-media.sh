#!/usr/bin/env bash
# Copies the media of a backup (ops/backup.sh) back into the object storage bucket. Safe to re-run.
# Usage: ops/restore-media.sh <backup_dir/STAMP>     (ENV_FILE=.env.production for production)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] && set -a && . "./$ENV_FILE" && set +a
SRC="${1:?usage: restore-media.sh <backup dir>}"
docker run --rm --network host -v "$(cd "$SRC/media" && pwd):/backup:ro" \
  -e RCLONE_CONFIG_DST_TYPE=s3 -e RCLONE_CONFIG_DST_PROVIDER=Other \
  -e RCLONE_CONFIG_DST_ACCESS_KEY_ID="$S3_ACCESS_KEY" -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
  -e RCLONE_CONFIG_DST_ENDPOINT="${S3_BACKUP_ENDPOINT:-http://127.0.0.1:8333}" -e RCLONE_CONFIG_DST_FORCE_PATH_STYLE=true \
  rclone/rclone copy /backup "dst:${S3_BUCKET}" --checksum --stats-one-line
echo "Media restored into bucket ${S3_BUCKET}."
