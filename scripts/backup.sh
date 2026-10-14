#!/usr/bin/env bash
# Logical backup of the CRM database: consistent (single transaction), includes triggers and routines (the append-only guarantees live in triggers),
# compressed, optionally encrypted. Usage:
#   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=reales BACKUP_DIR=/backups ./scripts/backup.sh
# Local Docker dev (the password must reach the container, so pass it with -e): MYSQL_EXEC="docker exec -i -e MYSQL_PWD=root_dev_password infrastructure-mysql-1" DB_USER=root DB_PASSWORD=root_dev_password ./scripts/backup.sh
# Optional: BACKUP_PASSPHRASE enables AES-256 encryption (openssl). Managed-database snapshots (see terraform) are the primary backup in production;
# this logical dump is the portable second copy and what the restore drill exercises.
set -euo pipefail

: "${DB_NAME:=reales}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_HOST:=127.0.0.1}"
: "${DB_PORT:=3306}"
: "${BACKUP_DIR:=./backups}"
MYSQL_EXEC="${MYSQL_EXEC:-}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/${DB_NAME}-${stamp}.sql.gz"

host_args=()
[ -z "$MYSQL_EXEC" ] && host_args=(-h "$DB_HOST" -P "$DB_PORT")

# shellcheck disable=SC2086
MYSQL_PWD="$DB_PASSWORD" $MYSQL_EXEC mysqldump "${host_args[@]}" -u "$DB_USER" \
  --single-transaction --routines --triggers --events --hex-blob --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$out"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -in "$out" -out "$out.enc"
  rm -f "$out"
  out="$out.enc"
fi

# A backup that was never read back is not a backup: verify the archive is readable and non-trivial.
if [[ "$out" == *.enc ]]; then
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$out" | gzip -t
else
  gzip -t "$out"
fi
size=$(wc -c < "$out")
[ "$size" -gt 1024 ] || { echo "backup suspiciously small ($size bytes)" >&2; exit 1; }
sha256sum "$out" > "$out.sha256"
echo "$out"
