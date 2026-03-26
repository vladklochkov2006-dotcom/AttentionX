#!/bin/bash
# AttentionX — Health check & auto-restart
# Runs via cron: */5 * * * * /opt/attentionx/deploy/healthcheck.sh

set -uo pipefail

LOG_FILE="/opt/attentionx/logs/healthcheck.log"
MAX_RETRIES=3
RETRY_DELAY=5

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

check_service() {
    local name="$1"
    local url="$2"
    local service="$3"

    for i in $(seq 1 $MAX_RETRIES); do
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")

        if [ "$HTTP_CODE" = "200" ]; then
            return 0
        fi

        if [ "$i" -lt "$MAX_RETRIES" ]; then
            sleep "$RETRY_DELAY"
        fi
    done

    # Service is down — restart
    log "WARN: $name unhealthy (HTTP $HTTP_CODE after $MAX_RETRIES retries). Restarting $service..."
    systemctl restart "$service"
    sleep 5

    # Verify restart
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        log "OK: $name recovered after restart"
    else
        log "ERROR: $name still unhealthy after restart (HTTP $HTTP_CODE)"
    fi
}

# Check RISE services
check_service "API" "http://127.0.0.1:3007/health" "attentionx-api"
check_service "Metadata" "http://127.0.0.1:3006/metadata/1" "attentionx-metadata"
check_service "TokenLeagues" "http://127.0.0.1:3007/api/token-leagues/cycle/active" "attentionx-api"

# Check nginx
if ! systemctl is-active --quiet nginx; then
    log "WARN: nginx is down. Restarting..."
    systemctl restart nginx
    log "OK: nginx restarted"
fi
