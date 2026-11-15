#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# set-https.sh - the way back, if a secure connection setting locks you out.
# HTTPS is normally chosen on the settings page (Settings -> Secure
# connection). Run this INSIDE the container (as root):
#
#   bash /opt/dji-flightmap/deploy/set-https.sh --off       # plain http
#   bash /opt/dji-flightmap/deploy/set-https.sh --private   # HTTPS, private certificate
#
# From the Proxmox host, without entering the container:
#   pct exec <CTID> -- bash /opt/dji-flightmap/deploy/set-https.sh --off
# ---------------------------------------------------------------------------
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8

CONF=${CONF:-/etc/default/dji-flightmap}
SERVER=${SERVER:-/opt/dji-flightmap/app/server.py}
RESTART_CMD=${RESTART_CMD:-systemctl restart dji-flightmap}

case "${1:-}" in
  --off) CHOICE=off ;;
  --private) CHOICE=private ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (inside the container)." >&2
  exit 1
fi

# Change the setting as the map's own user, so its files stay its own.
CACHE=$(sed -n 's/^CACHE_FILE=//p' "$CONF" 2>/dev/null | tail -1)
runuser -u flightmap -- env ${CACHE:+CACHE_FILE="$CACHE"} python3 "$SERVER" --set-https "$CHOICE"
$RESTART_CMD
PORT=$(sed -n 's/^PORT=//p' "$CONF" 2>/dev/null | tail -1)
IP=$(hostname -I | awk '{print $1}')
if [[ "$CHOICE" == off ]]; then
  echo "HTTPS is OFF. Open:  http://${IP}:${PORT:-8080}"
else
  echo "HTTPS is ON with a private certificate. Open http://${IP}:${PORT:-8080} and you'll be sent to https."
fi
