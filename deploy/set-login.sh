#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# set-login.sh - run INSIDE the container (as root) to turn the login page
# on, change the username/password, or turn it off.
#
#   bash /opt/dji-flightmap/deploy/set-login.sh        # set or change
#   bash /opt/dji-flightmap/deploy/set-login.sh --off  # remove the login
#
# From the Proxmox host you can run it without entering the container:
#   pct exec <CTID> -- bash /opt/dji-flightmap/deploy/set-login.sh
# ---------------------------------------------------------------------------
set -euo pipefail

CONF=/etc/default/dji-flightmap
SERVER=/opt/dji-flightmap/app/server.py

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (inside the container)." >&2
  exit 1
fi

remove_login_lines() {
  sed -i '/^AUTH_USER=/d;/^AUTH_PASSWORD_HASH=/d' "$CONF"
}

if [[ "${1:-}" == "--off" ]]; then
  remove_login_lines
  systemctl restart dji-flightmap
  echo "Login page turned OFF. Anyone on your network can open the map."
  exit 0
fi

while true; do
  read -rp "Choose a username: " NEW_USER
  if [[ "$NEW_USER" =~ ^[A-Za-z0-9._@-]{1,64}$ ]]; then break; fi
  echo "Please use only letters, numbers and . _ @ - (no spaces)."
done

# server.py asks for the password twice (hidden) and prints its hash.
HASH=$(python3 "$SERVER" --hash-password)

remove_login_lines
{
  echo "AUTH_USER=${NEW_USER}"
  echo "AUTH_PASSWORD_HASH=${HASH}"
} >> "$CONF"
chmod 600 "$CONF"
systemctl restart dji-flightmap
echo
echo "Login page is ON. Sign in as '${NEW_USER}'."
echo "(Everyone who was signed in before has been signed out.)"
