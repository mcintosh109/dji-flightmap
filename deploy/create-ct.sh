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

# Settings must be written in CAPITAL letters (STORAGE=..., not storage=...).
# Linux treats them as different names, so catch the lower-case mistake.
for name in ctid storage bridge ip gateway data_host_path template_storage; do
  if [[ -n "${!name:-}" ]]; then
    echo "You wrote '${name}=...' in lower case. Settings must be in CAPITALS, e.g.:" >&2
    echo "  ${name^^}=${!name} bash deploy/create-ct.sh" >&2
    exit 1
  fi
done

CTID="${CTID:-$(pvesh get /cluster/nextid)}"   # next free container number
HOSTNAME="${CT_HOSTNAME:-dji-flightmap}"
STORAGE="${STORAGE:-local-lvm}"                 # where the container's disk lives
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"   # where OS templates are kept
BRIDGE="${BRIDGE:-vmbr0}"                       # network bridge
IP="${IP:-}"                                    # empty = ask; or dhcp; or e.g. 192.168.1.50/24
GATEWAY="${GATEWAY:-}"                          # router address, needed with a fixed IP
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

# The container's disk must go on a storage that is allowed to hold containers.
if ! pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$STORAGE"; then
  echo "Storage '$STORAGE' doesn't exist or isn't allowed to hold containers." >&2
  echo "Storages that can hold containers right now:" >&2
  pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print "  " $1}' >&2
  echo "To allow another one: Datacenter > Storage > double-click it > Content > also select 'Container'." >&2
  exit 1
fi

# ---- Network: automatic (DHCP) or a fixed address ---------------------------
IP_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
HOST_CIDR=$(ip -4 -o addr show "$BRIDGE" 2>/dev/null | awk '{print $4}' | head -1)   # e.g. 192.168.1.200/24
HOST_PREFIX="${HOST_CIDR#*/}"
HOST_GW=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')

if [[ -z "$IP" && -t 0 ]]; then
  echo
  echo "Network address for the container:"
  echo "  - Press Enter for AUTOMATIC (DHCP): your router picks it, and it may change."
  echo "  - Or type a FIXED address that nothing else uses${HOST_CIDR:+ (this Proxmox server is ${HOST_CIDR%/*})}."
  while true; do
    read -rp "Address [automatic]: " IP
    IP="${IP// /}"
    if [[ -z "$IP" || "${IP,,}" == dhcp ]]; then IP=dhcp; break; fi
    [[ "$IP" != */* && -n "$HOST_PREFIX" ]] && IP="${IP}/${HOST_PREFIX}"   # add the /24 part
    if [[ ! "${IP%/*}" =~ $IP_RE || ! "${IP#*/}" =~ ^[0-9]{1,2}$ ]]; then
      echo "That doesn't look like an address. Example: 192.168.1.50"; continue
    fi
    if ping -c 1 -W 1 "${IP%/*}" >/dev/null 2>&1; then
      echo "Something already answers at ${IP%/*}. Please pick a different address."; continue
    fi
    break
  done
fi
IP="${IP:-dhcp}"

if [[ "$IP" != dhcp && -z "$GATEWAY" ]]; then
  if [[ -t 0 ]]; then
    while true; do
      read -rp "Gateway (your router's address) [${HOST_GW}]: " GATEWAY
      GATEWAY="${GATEWAY// /}"; GATEWAY="${GATEWAY:-$HOST_GW}"
      [[ "$GATEWAY" =~ $IP_RE ]] && break
      echo "That doesn't look like an address. Example: 192.168.1.1"
    done
  else
    GATEWAY="$HOST_GW"
  fi
fi
if [[ "$IP" == dhcp ]]; then
  echo "==> Network: automatic (DHCP)"
else
  echo "==> Network: fixed address ${IP}, gateway ${GATEWAY}"
fi

# Templates exist for different processor types (amd64 = normal Intel/AMD PCs,
# arm64 = ARM boards). Pick the one that matches this server.
ARCH=$(dpkg --print-architecture)
echo "==> Finding the newest Debian container template for this server ($ARCH)"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '{print $2}' \
  | grep -E "^debian-[0-9]+-standard_.*_${ARCH}\.tar" | sort -V | tail -1)
if [[ -z "$TEMPLATE" ]]; then
  echo "Could not find a Debian template for $ARCH with 'pveam available'." >&2
  exit 1
fi
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  echo "==> Downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" || true
fi
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  echo "The template download didn't finish. Please run the script again." >&2
  exit 1
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
