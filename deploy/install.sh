#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install.sh - run INSIDE the container (as root) to install DJI Flight Map.
#
#   bash deploy/install.sh
#
# Safe to run again later to update: it replaces the app files but keeps
# your settings in /etc/default/dji-flightmap.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/opt/dji-flightmap
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the folder this script came from

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (inside the container)." >&2
  exit 1
fi

echo "==> Installing Python 3"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 >/dev/null

echo "==> Creating the 'flightmap' service user"
if ! id flightmap >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin flightmap
fi

echo "==> Copying app files to $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/app"
cp -r "$SRC_DIR/app" "$APP_DIR/app"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

echo "==> Writing settings (only if they don't exist yet)"
if [[ ! -f /etc/default/dji-flightmap ]]; then
  cp "$SRC_DIR/deploy/dji-flightmap.env" /etc/default/dji-flightmap
fi

# The folder the logs appear in. Normally this is a bind mount from the
# Proxmox host (see create-ct.sh); make sure it exists either way.
DATA_DIR=$(grep -E '^DATA_DIR=' /etc/default/dji-flightmap | cut -d= -f2-)
mkdir -p "${DATA_DIR:-/srv/dji-logs}"

echo "==> Installing and starting the service"
cp "$SRC_DIR/deploy/dji-flightmap.service" /etc/systemd/system/dji-flightmap.service
systemctl daemon-reload
systemctl enable --now dji-flightmap
systemctl restart dji-flightmap
sleep 2

PORT=$(grep -E '^PORT=' /etc/default/dji-flightmap | cut -d= -f2-)
IP=$(hostname -I | awk '{print $1}')
if systemctl is-active --quiet dji-flightmap; then
  echo
  echo "Done! Open this in a browser:  http://${IP}:${PORT:-8080}"
  echo "Logs are read from:            ${DATA_DIR:-/srv/dji-logs}"
  echo "See what the server is doing:  journalctl -u dji-flightmap -f"
else
  echo "The service did not start. Showing its log:" >&2
  journalctl -u dji-flightmap -n 30 --no-pager >&2
  exit 1
fi
