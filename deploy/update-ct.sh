#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-ct.sh - run on the PROXMOX HOST to copy a newer version of the app
# into an existing container and restart it. Your settings are kept.
#
#   cd /root/dji-flightmap && git pull
#   CTID=105 bash deploy/update-ct.sh
# ---------------------------------------------------------------------------
set -euo pipefail

if [[ -z "${CTID:-}" ]]; then
  echo "Please set CTID to the container's ID number. Example: CTID=105 bash deploy/update-ct.sh" >&2
  echo "(The ID is shown next to the container in the Proxmox web UI, or run: pct list)" >&2
  exit 1
fi
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARBALL=$(mktemp --suffix=.tar.gz)
tar -C "$SRC_DIR" -czf "$TARBALL" app deploy
pct push "$CTID" "$TARBALL" /root/dji-flightmap.tar.gz
rm -f "$TARBALL"
pct exec "$CTID" -- bash -c "rm -rf /root/dji-flightmap && mkdir -p /root/dji-flightmap && tar -xzf /root/dji-flightmap.tar.gz -C /root/dji-flightmap && bash /root/dji-flightmap/deploy/install.sh"
