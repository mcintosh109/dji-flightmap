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

# A language setting every system has (the container may lack the Shell's one).
export LANG=C.UTF-8 LC_ALL=C.UTF-8

APP_DIR=/opt/dji-flightmap
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the folder this script came from

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (inside the container)." >&2
  exit 1
fi

echo "==> Installing Python 3"
apt-get update -qq
# ca-certificates: HTTPS to the map companies; openssl: the map's own HTTPS
# certificate; curl: used by acme.sh (Let's Encrypt)
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 ca-certificates openssl curl >/dev/null

echo "==> Creating the 'flightmap' service user"
if ! id flightmap >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin flightmap
fi

echo "==> Copying app files to $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/app" "$APP_DIR/deploy"
cp -r "$SRC_DIR/app" "$APP_DIR/app"
cp -r "$SRC_DIR/deploy" "$APP_DIR/deploy"   # keeps set-login.sh handy
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

# acme.sh: the tool that gets Let's Encrypt certificates, if you choose them
# in Settings -> Secure connection. A fixed release from its official GitHub
# page; the map runs it as its own user. Skipped if GitHub can't be reached.
ACME_VERSION=3.1.1
if [[ ! -x /opt/acme.sh/acme.sh || "$(cat /opt/acme.sh/.version 2>/dev/null)" != "$ACME_VERSION" ]]; then
  echo "==> Installing acme.sh $ACME_VERSION (for Let's Encrypt)"
  TMP=$(mktemp -d)
  if curl -fsSL --max-time 60 -o "$TMP/acme.tgz" \
       "https://github.com/acmesh-official/acme.sh/archive/refs/tags/${ACME_VERSION}.tar.gz" \
     && tar -xzf "$TMP/acme.tgz" -C "$TMP"; then
    rm -rf /opt/acme.sh
    mv "$TMP/acme.sh-${ACME_VERSION}" /opt/acme.sh
    echo "$ACME_VERSION" > /opt/acme.sh/.version
    chown -R root:root /opt/acme.sh
    chmod -R a+rX,go-w /opt/acme.sh
  else
    echo "    (could not download acme.sh; only needed for Let's Encrypt, the next update tries again)"
  fi
  rm -rf "$TMP"
fi

echo "==> Writing settings (only if they don't exist yet)"
if [[ ! -f /etc/default/dji-flightmap ]]; then
  cp "$SRC_DIR/deploy/dji-flightmap.env" /etc/default/dji-flightmap
fi
chmod 600 /etc/default/dji-flightmap   # may hold the login hash: root only

# The folder the logs appear in. Normally this is a bind mount from the
# Proxmox host (see create-ct.sh); make sure it exists either way.
DATA_DIR=$(grep -E '^DATA_DIR=' /etc/default/dji-flightmap | cut -d= -f2-)
mkdir -p "${DATA_DIR:-/srv/dji-logs}"

# The map makes its own HTTPS certificates here (as its own user).
mkdir -p /var/lib/dji-flightmap/tls
chown -R flightmap:flightmap /var/lib/dji-flightmap/tls
chmod 755 /var/lib/dji-flightmap/tls

echo "==> Installing and starting the service"
cp "$SRC_DIR/deploy/dji-flightmap.service" /etc/systemd/system/dji-flightmap.service
systemctl daemon-reload
systemctl enable --now dji-flightmap
systemctl restart dji-flightmap
sleep 2

PORT=$(grep -E '^PORT=' /etc/default/dji-flightmap | cut -d= -f2-)
IP=$(hostname -I | awk '{print $1}')
sleep 2   # the map may still be making its certificate
# The http port says whether HTTPS is on, and its port.
HTTPS_PORT=$(python3 -c "import json,urllib.request; print(json.load(urllib.request.urlopen('http://127.0.0.1:${PORT:-8080}/api/health', timeout=5)).get('httpsPort', ''))" 2>/dev/null || true)
URL="http://${IP}:${PORT:-8080}"
if [[ -n "$HTTPS_PORT" ]]; then
  URL="https://${IP}$([[ "$HTTPS_PORT" == 443 ]] || echo ":$HTTPS_PORT")"
fi
if systemctl is-active --quiet dji-flightmap; then
  echo
  echo "Done! Open this in a browser:  $URL"
  echo "Logs are read from:            ${DATA_DIR:-/srv/dji-logs}"
  echo "See what the server is doing:  journalctl -u dji-flightmap -f"
  if ! grep -q '^AUTH_USER=' /etc/default/dji-flightmap; then
    echo "Add a login page:              bash $APP_DIR/deploy/set-login.sh"
  fi
  if [[ -n "$HTTPS_PORT" ]]; then
    echo "The map uses HTTPS with its own certificate: the first time, the browser warns."
    echo "Open Settings -> Secure connection to make this device trust it (or to change it)."
  fi
else
  echo "The service did not start. Showing its log:" >&2
  journalctl -u dji-flightmap -n 30 --no-pager >&2
  exit 1
fi
