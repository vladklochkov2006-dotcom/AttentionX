#!/bin/bash
# AttentionX — Daily database backup
# Runs via cron: 0 3 * * * /opt/attentionx/deploy/backup-db.sh

set -euo pipefail

BACKUP_DIR="/opt/attentionx/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=30
LOG_FILE="/opt/attentionx/logs/backup.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Ensure backup dir exists
mkdir -p "$BACKUP_DIR"

# Backup a single database file
backup_db() {
    local DB_FILE="$1"
    local PREFIX="$2"

    if [ ! -f "$DB_FILE" ]; then
        log "SKIP: Database file not found: $DB_FILE"
        return 0
    fi

    BACKUP_FILE="${BACKUP_DIR}/${PREFIX}_${TIMESTAMP}.db"
    cp "$DB_FILE" "$BACKUP_FILE"

    ORIG_SIZE=$(stat -c%s "$DB_FILE")
    BACK_SIZE=$(stat -c%s "$BACKUP_FILE")

    if [ "$BACK_SIZE" -lt 1024 ]; then
        log "ERROR: Backup too small for ${PREFIX} (${BACK_SIZE} bytes), possible corruption"
        rm -f "$BACKUP_FILE"
        return 1
    fi

    gzip "$BACKUP_FILE"
    COMPRESSED_SIZE=$(stat -c%s "${BACKUP_FILE}.gz")
    log "OK: ${PREFIX} backup created ${BACKUP_FILE}.gz (original: ${ORIG_SIZE}B, compressed: ${COMPRESSED_SIZE}B)"
}

# Backup RISE DB
backup_db "/opt/attentionx/server/db/attentionx.db" "attentionx"

# Delete old backups (older than KEEP_DAYS)
DELETED=$(find "$BACKUP_DIR" -name "attentionx*.db.gz" -mtime +${KEEP_DAYS} -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
    log "Cleaned up $DELETED old backups (>${KEEP_DAYS} days)"
fi
