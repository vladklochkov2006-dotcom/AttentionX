#!/bin/bash
###############################################################################
# AttentionX — Quick Update from GitHub
#
# Usage: sudo bash /opt/attentionx/scripts/update.sh
#
# What it does:
#   1. git pull from GitHub
#   2. npm ci for server & backend (if package.json changed)
#   3. npm run build for frontend (if front/ changed)
#   4. Sync contract addresses from deployment file into .env
#   5. Restart services
#   6. Verify metadata server uses correct contract
#
# Safe to run anytime. Does NOT touch: database, SSL, nginx.
###############################################################################

set -euo pipefail

APP_DIR="/root/AttentionX"
REPO="https://github.com/vladklochkov2006-dotcom/AttentionX.git"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[UPDATE]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
    err "Run as root: sudo bash $0"
fi

# Fix git ownership warning
git config --global --add safe.directory "${APP_DIR}" 2>/dev/null || true

# ─── Ensure remote is set correctly ───
if [ -d "${APP_DIR}/.git" ]; then
    cd "${APP_DIR}"
    CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
    if [ "$CURRENT_REMOTE" != "$REPO" ]; then
        git remote remove origin 2>/dev/null || true
        git remote add origin "$REPO"
        log "Fixed remote origin → $REPO"
    fi
fi

# ─── Check if repo exists, clone or pull ───
if [ ! -d "${APP_DIR}/.git" ]; then
    log "First time setup — cloning repo..."
    # Save .env and db before clone
    TEMP_DIR=$(mktemp -d)
    [ -f "${APP_DIR}/.env" ] && cp "${APP_DIR}/.env" "${TEMP_DIR}/.env"
    [ -f "${APP_DIR}/server/db/attentionx.db" ] && cp "${APP_DIR}/server/db/attentionx.db" "${TEMP_DIR}/attentionx.db"

    # Clone
    rm -rf "${APP_DIR:?}/.git"
    cd "${APP_DIR}"
    git init
    git remote add origin "$REPO"
    git fetch origin main
    git checkout -f main

    # Restore .env and db
    [ -f "${TEMP_DIR}/.env" ] && cp "${TEMP_DIR}/.env" "${APP_DIR}/.env"
    [ -f "${TEMP_DIR}/attentionx.db" ] && mkdir -p "${APP_DIR}/server/db" && cp "${TEMP_DIR}/attentionx.db" "${APP_DIR}/server/db/attentionx.db"
    rm -rf "$TEMP_DIR"

    log "Repo cloned"
else
    log "Pulling latest changes..."
    cd "${APP_DIR}"
    # Hard reset to match remote (safe: .env, db, logs are gitignored)
    git fetch origin main
    git reset --hard origin/main
    log "Pull complete"
fi

# ─── Show what changed ───
echo ""
log "Recent commits:"
git log --oneline -5
echo ""

# ─── Install server deps (if package.json changed) ───
log "Installing server dependencies..."
cd "${APP_DIR}/server"
npm ci --production --silent 2>&1 | tail -3 || npm install --production --silent 2>&1 | tail -3

# ─── Install backend deps ───
log "Installing metadata server dependencies..."
cd "${APP_DIR}/backend"
npm ci --production --silent 2>&1 | tail -3 || npm install --production --silent 2>&1 | tail -3

# ─── Build frontend ───
log "Building frontend..."
cd "${APP_DIR}/front"
npm ci --silent 2>&1 | tail -3 || npm install --silent 2>&1 | tail -3
npm run build
log "Frontend built"

# ─── Contract addresses ───
# No .env sync needed — metadata server reads directly from deployment-cofhe.json
log "Contract addresses from deployment file (no .env sync needed):"
if [ -f "${APP_DIR}/deployment-cofhe.json" ]; then
    ADDR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${APP_DIR}/deployment-cofhe.json','utf8')).contracts.AttentionX_NFT || 'N/A')" 2>/dev/null || echo "N/A")
    log "  deployment-cofhe.json: ${ADDR}"
fi

# ─── Ensure data directories exist ───
mkdir -p "${APP_DIR}/server/data"
mkdir -p "${APP_DIR}/server/db"

# ─── Fix ownership ───
chown -R root:root "${APP_DIR}"

# ─── Install / update systemd service files ───
log "Installing systemd service files..."
cp "${APP_DIR}/deploy/attentionx-api.service" /etc/systemd/system/
cp "${APP_DIR}/deploy/attentionx-metadata.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable attentionx-api attentionx-metadata 2>/dev/null || true

# ─── Stop services, kill stale processes, then start clean ───
log "Stopping services..."
systemctl stop attentionx-api 2>/dev/null || true
systemctl stop attentionx-metadata 2>/dev/null || true
# Clean up legacy MegaETH services if they exist
systemctl stop attentionx-megaeth-api 2>/dev/null || true
systemctl stop attentionx-megaeth-metadata 2>/dev/null || true
systemctl disable attentionx-megaeth-api 2>/dev/null || true
systemctl disable attentionx-megaeth-metadata 2>/dev/null || true
rm -f /etc/systemd/system/attentionx-megaeth-api.service
rm -f /etc/systemd/system/attentionx-megaeth-metadata.service
sleep 2

# Kill any leftover node processes on our ports
fuser -k 3007/tcp 2>/dev/null || true
fuser -k 3006/tcp 2>/dev/null || true
sleep 1

systemctl daemon-reload

log "Starting services..."
systemctl start attentionx-api
systemctl start attentionx-metadata

# ─── Nginx + SSL setup ───
DOMAIN="fhe.attnx.fun"
NGINX_TARGET="/etc/nginx/sites-available/${DOMAIN}"
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

if [ -f "${APP_DIR}/deploy/nginx.conf" ]; then
    log "Updating nginx config..."

    # Clean up old 'attentionx' config that conflicts with the canonical name
    if [ -f "/etc/nginx/sites-available/attentionx" ] && [ "attentionx" != "${DOMAIN}" ]; then
        rm -f /etc/nginx/sites-enabled/attentionx
        rm -f /etc/nginx/sites-available/attentionx
        log "Removed old duplicate nginx config 'attentionx'"
    fi

    # If SSL cert doesn't exist yet — create temp HTTP-only config, obtain cert, then install full config
    if [ ! -f "$CERT_PATH" ]; then
        log "SSL cert not found — obtaining via certbot..."
        mkdir -p /var/www/certbot

        # Temp HTTP-only config for ACME challenge
        cat > "$NGINX_TARGET" <<'TMPEOF'
server {
    listen 80;
    server_name fhe.attnx.fun;
    location /.well-known/acme-challenge/ { root /var/www/certbot; allow all; }
    location / { return 200 'waiting for ssl'; }
}
TMPEOF
        ln -sf "$NGINX_TARGET" "/etc/nginx/sites-enabled/${DOMAIN}"
        nginx -t 2>/dev/null && systemctl reload nginx

        # Obtain certificate
        certbot certonly --webroot -w /var/www/certbot -d "${DOMAIN}" --non-interactive --agree-tos --register-unsafely-without-email \
            && log "SSL cert obtained" \
            || warn "certbot failed — check DNS for ${DOMAIN}"
    fi

    # Install full config (with SSL)
    if [ -f "$CERT_PATH" ]; then
        cp "${APP_DIR}/deploy/nginx.conf" "$NGINX_TARGET"
        ln -sf "$NGINX_TARGET" "/etc/nginx/sites-enabled/${DOMAIN}"

        if nginx -t 2>/dev/null; then
            systemctl reload nginx
            log "Nginx reloaded with SSL"
        else
            warn "Nginx config test failed — skipping reload"
        fi
    else
        warn "SSL cert still missing — keeping HTTP-only config"
    fi
fi

sleep 3

# ─── Verify ───
API_OK=$(systemctl is-active attentionx-api)
META_OK=$(systemctl is-active attentionx-metadata)
NGINX_OK=$(systemctl is-active nginx)

echo ""
echo -e "  ${CYAN}Sepolia FHE:${NC}"
echo -e "  attentionx-api:              ${API_OK} $([ "$API_OK" = "active" ] && echo "${GREEN}OK${NC}" || echo "${RED}FAIL${NC}")"
echo -e "  attentionx-metadata:         ${META_OK} $([ "$META_OK" = "active" ] && echo "${GREEN}OK${NC}" || echo "${RED}FAIL${NC}")"
echo -e "  ${CYAN}Infra:${NC}"
echo -e "  nginx:                      ${NGINX_OK} $([ "$NGINX_OK" = "active" ] && echo "${GREEN}OK${NC}" || echo "${RED}FAIL${NC}")"

# ─── Verify metadata server uses correct contract ───
echo -e "  ${CYAN}Contract verification:${NC}"

DEPLOY_FILE="${APP_DIR}/deployment-cofhe.json"
if [ -f "$DEPLOY_FILE" ]; then
    EXPECTED_ADDR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DEPLOY_FILE}','utf8')).contracts.AttentionX_NFT || '')" 2>/dev/null || echo "")
    ACTUAL_ADDR=$(curl -s --max-time 5 "http://127.0.0.1:3006/" 2>/dev/null | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).contract)}catch{console.log('?')}})" 2>/dev/null || echo "?")

    if [ "$ACTUAL_ADDR" = "$EXPECTED_ADDR" ]; then
        echo -e "  Metadata contract:       ${GREEN}OK${NC} (${ACTUAL_ADDR})"
    else
        echo -e "  Metadata contract:       ${RED}MISMATCH${NC}"
        echo -e "    expected: ${EXPECTED_ADDR}"
        echo -e "    actual:   ${ACTUAL_ADDR}"
        warn "Metadata server using wrong contract! Check deployment-cofhe.json"
    fi
fi

echo ""
log "Update complete!"
