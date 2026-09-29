#!/usr/bin/env bash
# Proves a backup is restorable: restores the DB dump into a throwaway database, checks integrity,
# and confirms every non-pending photograph's original still exists in the media backup.
# Usage: ops/restore-test.sh <backup_dir/STAMP>     A backup that has never been restored is not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?usage: restore-test.sh <backup dir>}"
SCRATCH="restore_test_$(date +%s)"
PSQL=(docker compose exec -T postgres psql -U imageunit -v ON_ERROR_STOP=1)

echo "==> Verifying checksum"
( cd "$SRC" && sha256sum -c db.dump.sha256 )

echo "==> Restoring into scratch database $SCRATCH"
"${PSQL[@]}" -d postgres -c "create database $SCRATCH" >/dev/null
trap '"${PSQL[@]}" -d postgres -c "drop database if exists $SCRATCH" >/dev/null' EXIT
docker compose exec -T postgres pg_restore -U imageunit --no-owner -d "$SCRATCH" < "$SRC/db.dump"

echo "==> Integrity checks"
users=$("${PSQL[@]}" -d "$SCRATCH" -Atc "select count(*) from users")
events=$("${PSQL[@]}" -d "$SCRATCH" -Atc "select count(*) from events")
photos=$("${PSQL[@]}" -d "$SCRATCH" -Atc "select count(*) from photos")
audit=$("${PSQL[@]}" -d "$SCRATCH" -Atc "select count(*) from audit_logs")
admins=$("${PSQL[@]}" -d "$SCRATCH" -Atc "select count(*) from users where role='admin' and status='active'")
echo "users=$users events=$events photos=$photos audit_logs=$audit active_admins=$admins"
[ "$admins" -ge 1 ] || { echo "FAIL: no active administrator in restored data"; exit 1; }

echo "==> Media cross-check"
missing=0
while IFS= read -r key; do
  [ -f "$SRC/media/$key" ] || { echo "MISSING original: $key"; missing=$((missing+1)); }
done < <("${PSQL[@]}" -d "$SCRATCH" -Atc "select original_key from photos where status <> 'pending_upload'")
[ "$missing" -eq 0 ] || { echo "FAIL: $missing originals missing from media backup"; exit 1; }

echo "OK: backup restored and verified (scratch database dropped)."
