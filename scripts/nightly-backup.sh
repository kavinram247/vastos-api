#!/usr/bin/env bash
# Nightly backup: Postgres dump + MinIO objects -> Backblaze B2.
# Installed on the VPS at /usr/local/bin/nightly-backup, run by cron at 03:15.
# rclone remotes required (set up once with `rclone config`):
#   b2      -> Backblaze B2 (native backend), bucket: vastos-backups
#   minio   -> the local MinIO S3 API (http://127.0.0.1:9000)
set -euo pipefail

STAMP="$(date +%F-%H%M)"
BACKUP_DIR=/data/backups
DB_RETENTION_DAYS=30
LOCAL_RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

PG="$(docker ps --filter name=vastos-api-postgres --format '{{.Names}}' | head -1)"
[ -n "$PG" ] || { echo "postgres container not found"; exit 1; }

# 1. Postgres — custom-format dump (compressed, parallel-restorable)
docker exec "$PG" pg_dump -U vastos -Fc vastos > "$BACKUP_DIR/db-$STAMP.dump"

# 2. Ship the dump offsite
rclone copy "$BACKUP_DIR/db-$STAMP.dump" b2:vastos-backups/db/

# 3. Mirror MinIO objects offsite (via the S3 API, NOT the raw disk layout)
rclone sync minio:vastos-files b2:vastos-backups/files/ --fast-list

# 4. Prune old offsite DB dumps
rclone delete --min-age "${DB_RETENTION_DAYS}d" b2:vastos-backups/db/

# 5. Prune old local dumps
find "$BACKUP_DIR" -name 'db-*.dump' -mtime +"$LOCAL_RETENTION_DAYS" -delete

echo "backup ok: db-$STAMP.dump + files sync"
