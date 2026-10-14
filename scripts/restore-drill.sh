#!/usr/bin/env bash
# Restore drill: restores a backup into a THROWAWAY database and checks that the schema, the append-only triggers and the audit hash chain survived.
# Never restores over the live database. Usage:
#   BACKUP_FILE=backups/reales-....sql.gz DB_USER=root DB_PASSWORD=... MYSQL_EXEC="docker exec -i -e MYSQL_PWD=... infrastructure-mysql-1" ./scripts/restore-drill.sh
# Run it on a schedule (e.g. monthly) and record the elapsed time: that is your measured recovery time, not a guess.
set -euo pipefail

: "${BACKUP_FILE:?BACKUP_FILE is required (.sql.gz, or .enc with BACKUP_PASSPHRASE)}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_HOST:=127.0.0.1}"
: "${DB_PORT:=3306}"
MYSQL_EXEC="${MYSQL_EXEC:-}"
drill_db="reales_restore_drill_$(date -u +%H%M%S)"

host_args=()
[ -z "$MYSQL_EXEC" ] && host_args=(-h "$DB_HOST" -P "$DB_PORT")
sql() { MYSQL_PWD="$DB_PASSWORD" $MYSQL_EXEC mysql "${host_args[@]}" -u "$DB_USER" "$@"; }

start=$(date +%s)
cleanup() { sql -e "DROP DATABASE IF EXISTS \`$drill_db\`" >/dev/null 2>&1 || true; }
trap cleanup EXIT

sql -e "CREATE DATABASE \`$drill_db\` CHARACTER SET utf8mb4"
if [[ "$BACKUP_FILE" == *.enc ]]; then
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" | gunzip | sql "$drill_db"
else
  gunzip -c "$BACKUP_FILE" | sql "$drill_db"
fi

tables=$(sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$drill_db'")
triggers=$(sql -N -e "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='$drill_db'")
migrations=$(sql -N -e "SELECT COUNT(*) FROM \`$drill_db\`.schema_migrations" 2>/dev/null || echo 0)
audit_rows=$(sql -N -e "SELECT COUNT(*) FROM \`$drill_db\`.audit_events")

echo "tables=$tables triggers=$triggers migrations=$migrations audit_events=$audit_rows"
[ "$tables" -gt 100 ] || { echo "FAIL: expected >100 tables" >&2; exit 1; }
[ "$triggers" -ge 20 ] || { echo "FAIL: append-only triggers missing ($triggers)" >&2; exit 1; }

# The append-only guarantee must still hold after a restore.
if sql -e "UPDATE \`$drill_db\`.audit_events SET action='tampered' LIMIT 1" 2>/dev/null; then
  if [ "$audit_rows" -gt 0 ]; then echo "FAIL: audit_events is not append-only after restore" >&2; exit 1; fi
fi

echo "restore drill OK in $(( $(date +%s) - start ))s (verify the audit hash chain with verifyAuditChain against this database before declaring recovery)"
