#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# create-ct.sh - run on the PROXMOX HOST (as root) to create a new LXC
# container ("CT") and install DJI Flight Map inside it.
#
# Usage (from the folder you cloned the project into):
#
#   bash deploy/create-ct.sh
#
# Run deploy/setup-truenas-mount.sh first: it connects the TrueNAS
# "archive" folder to /mnt/dji-archive on this host. This script then shares
# that folder into the container read-only, so the map can never change or
# delete your logs. (Logs somewhere else? Set DATA_HOST_PATH=/that/folder)
#
# Everything else has a default you can override the same way, e.g.
#   CTID=150 BRIDGE=vmbr1 DATA_HOST_PATH=/tank/dji bash deploy/create-ct.sh
# ---------------------------------------------------------------------------
set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid)}"   # next free container number
HOSTNAME="${CT_HOSTNAME:-dji-flightmap}"
STORAGE="${STORAGE:-local-lvm}"                 # where the container's disk lives
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"   # where OS templates are kept
BRIDGE="${BRIDGE:-vmbr0}"                       # network bridge
IP="${IP:-dhcp}"                                # or e.g. 192.168.1.50/24 (then also set GATEWAY)
GATEWAY="${GATEWAY:-}"
DISK_GB="${DISK_GB:-4}"
MEMORY_MB="${MEMORY_MB:-512}"
CORES="${CORES:-1}"
DATA_CT_PATH=/srv/dji-logs
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DATA_HOST_PATH="${DATA_HOST_PATH:-/mnt/dji-archive}"
if [[ ! -d "$DATA_HOST_PATH" ]]; then
  echo "Folder not found on this host: $DATA_HOST_PATH" >&2
  echo "Run this first:  bash deploy/setup-truenas-mount.sh" >&2
  exit 1
fi
if [[ "$DATA_HOST_PATH" == /mnt/dji-archive ]] && ! mountpoint -q "$DATA_HOST_PATH"; then
  echo "$DATA_HOST_PATH exists but TrueNAS is not connected there." >&2
  echo "Run this first:  bash deploy/setup-truenas-mount.sh   (or try: mount $DATA_HOST_PATH)" >&2
  exit 1
fi
if [[ "$DATA_HOST_PATH" == *" "* || "$DATA_HOST_PATH" == *","* ]]; then
  echo "Proxmox can't share a folder whose path has spaces or commas: $DATA_HOST_PATH" >&2
  exit 1
fi

echo "==> Finding the newest Debian container template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep -E '^debian-[0-9]+-standard' | sort -V | tail -1)
if [[ -z "$TEMPLATE" ]]; then
  echo "Could not find a Debian template with 'pveam available'." >&2
  exit 1
fi
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  echo "==> Downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

NET="name=eth0,bridge=${BRIDGE},ip=${IP}"
[[ -n "$GATEWAY" ]] && NET="${NET},gw=${GATEWAY}"

echo "==> Creating container $CTID ($HOSTNAME)"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY_MB" --swap 512 \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "$NET" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 \
  --mp0 "${DATA_HOST_PATH},mp=${DATA_CT_PATH},ro=1"

echo "==> Starting container"
pct start "$CTID"
# Wait until the container has network (needed for apt-get).
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> Copying the app into the container"
TARBALL=$(mktemp --suffix=.tar.gz)
tar -C "$SRC_DIR" -czf "$TARBALL" app deploy
pct push "$CTID" "$TARBALL" /root/dji-flightmap.tar.gz
rm -f "$TARBALL"
pct exec "$CTID" -- bash -c "rm -rf /root/dji-flightmap && mkdir -p /root/dji-flightmap && tar -xzf /root/dji-flightmap.tar.gz -C /root/dji-flightmap"

echo "==> Installing inside the container"
pct exec "$CTID" -- bash /root/dji-flightmap/deploy/install.sh

echo
read -rp "Add a login page (username + password) now? [Y/n] " want_login
if [[ "${want_login,,}" != n* ]]; then
  pct exec "$CTID" -- bash /opt/dji-flightmap/deploy/set-login.sh || \
    echo "Login setup didn't finish. Try again later with: pct exec $CTID -- bash /opt/dji-flightmap/deploy/set-login.sh"
fi

echo
echo "Container $CTID is ready."
