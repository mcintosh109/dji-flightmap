#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# easy-install.sh - install DJI Flight Map on a Proxmox server with ONE
# command. Paste this into the Proxmox Shell (your server's own Shell, not a
# container's):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/mcintosh109/dji-flightmap/main/deploy/easy-install.sh)"
#
# It asks a few questions and does the rest:
#   1. downloads the newest RELEASED version to /root/dji-flightmap
#   2. if a flight map is already installed, offers to update it instead
#   3. connects your flight logs (a TrueNAS/Windows share, or a folder here)
#   4. asks where the container's disk should go
#   5. creates the container and installs the map (setup-truenas-mount.sh
#      and create-ct.sh do the work; this script only asks and joins them up)
#   6. offers backups on TrueNAS, then prints the map's address
#
# Running it again is safe: it never deletes anything.
#
# Testing a version that isn't released yet (for the project's owner):
#   bash /root/dji-flightmap/deploy/easy-install.sh --test
# ---------------------------------------------------------------------------
set -euo pipefail
cd /
export LANG=C.UTF-8 LC_ALL=C.UTF-8

REPO_URL="${FLIGHTMAP_REPO:-https://github.com/mcintosh109/dji-flightmap.git}"
DIR="${FLIGHTMAP_DIR:-/root/dji-flightmap}"
ARCHIVE=/mnt/dji-archive
MODE=release
case "${1:-}" in
  "") ;;
  --test) MODE="test" ;;
  -h|--help) sed -n '2,23p' "$0" 2>/dev/null || true; exit 0 ;;
  *) echo "Unknown option: $1 (the only option is --test)" >&2; exit 1 ;;
esac

step() { echo; echo "==> $*"; }
stop() { echo; echo "STOPPED: $*" >&2; exit 1; }
yes_default() { local a; read -rp "$1 [Y/n] " a; [[ "${a,,}" != n* ]]; }   # Enter = yes
no_default()  { local a; read -rp "$1 [y/N] " a; [[ "${a,,}" == y* ]]; }   # Enter = no

echo "DJI Flight Map: easy install"
echo "Press Ctrl+C at any question to stop. Nothing is deleted."

# ---- 0. Is this the right place? ---------------------------------------------
if [[ $EUID -ne 0 ]]; then
  stop "please run this as root, in the Proxmox Shell."
fi
if ! command -v pct >/dev/null || ! command -v pvesm >/dev/null; then
  stop "this isn't a Proxmox server's own Shell. In the Proxmox web page, click your server's name on the left (under Datacenter), then >_ Shell, and paste the command there."
fi

# ---- 1. Download ---------------------------------------------------------------
step "1/6 Downloading DJI Flight Map"
if ! command -v git >/dev/null; then
  echo "    installing git (the tool that downloads the project)"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null
fi
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch -q --tags origin || stop "could not reach GitHub. Check this server's internet connection and try again."
elif [[ -e "$DIR" ]]; then
  stop "$DIR already exists but isn't a download of this project. Rename it (mv $DIR $DIR.old) and run this again."
else
  git clone -q "$REPO_URL" "$DIR" || stop "could not reach GitHub. Check this server's internet connection and try again."
fi
# The newest release: a tag like v4.2.0 (4.2.0 without the v counts too).
# The same as deploy/release-tags.sh, written out here because the folder
# may still hold an older version that doesn't have that file.
NEWEST=$(git -C "$DIR" tag -l | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' \
  | awk '{ n = $0; sub(/^v/, "", n); print n, $0 }' | sort -k1,1Vr -k2,2r | awk 'NR == 1 { print $2 }' || true)
if [[ "$MODE" == test || -z "$NEWEST" ]]; then REF=origin/main; else REF=$NEWEST; fi
if ! git -C "$DIR" checkout -q --detach "$REF"; then
  stop "could not switch $DIR to $REF. Has a file in it been changed by hand? See: git -C $DIR status"
fi
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/app/version.json" | head -1)
if [[ "$REF" == origin/main ]]; then
  echo "    version $VERSION (a TEST version: not released yet)"
else
  echo "    version $VERSION (the newest release)"
fi

# ---- 2. Already installed? -------------------------------------------------------
step "2/6 Looking for a flight map that is already installed"
EXISTING=$(pct list | awk 'NR>1 && $NF=="dji-flightmap" {print $1}') \
  || stop "Proxmox couldn't list the containers (pct list). Is this server healthy?"
if [[ -n "$EXISTING" ]]; then
  echo "    found container(s): $EXISTING"
  if yes_default "The map is already installed. Update it to version $VERSION instead?"; then
    UPDATE_ARGS=()
    [[ "$MODE" == test ]] && UPDATE_ARGS=(--test)
    [[ $(wc -w <<<"$EXISTING") -eq 1 ]] && export CTID="$EXISTING"
    exec bash "$DIR/deploy/update-ct.sh" "${UPDATE_ARGS[@]}"
  fi
  echo "Nothing changed. (To make a second map anyway: CT_HOSTNAME=dji-flightmap-2 bash $DIR/deploy/create-ct.sh)"
  exit 0
fi
echo "    none: making a new one"

# ---- 3. The flight logs ----------------------------------------------------------
step "3/6 Where are your flight logs?"
DATA=""
if mountpoint -q "$ARCHIVE"; then
  echo "    already connected at $ARCHIVE"
  DATA=$ARCHIVE
else
  echo "  1) On TrueNAS or another network share: the kind Windows opens as \\\\server\\share"
  echo "     (this is where the dji-rc2-dock Raspberry Pi saves them)"
  echo "  2) In a folder on this Proxmox server"
  while [[ -z "$DATA" ]]; do
    read -rp "Choose 1 or 2 [1]: " where
    case "${where// /}" in
      ""|1)
        FLIGHTMAP_EASY=1 bash "$DIR/deploy/setup-truenas-mount.sh" \
          || stop "the share isn't connected yet. Fix what it says above, then run the same command again."
        DATA=$ARCHIVE ;;
      2)
        read -rp "Folder (example: /tank/dji-logs): " folder
        folder="${folder%/}"
        if [[ ! -d "$folder" ]]; then
          echo "There's no folder $folder on this server. Try again."
        elif [[ "$folder" == *" "* || "$folder" == *","* ]]; then
          echo "Proxmox can't share a folder whose path has spaces or commas. Pick or make another one."
        else
          DATA=$folder
        fi ;;
      *) echo "Please type 1 or 2." ;;
    esac
  done
fi

# ---- 4. Where the container's disk goes -------------------------------------------
step "4/6 Where to keep the container's disk (4 GB)"
mapfile -t STORAGES < <(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $1}')
if [[ ${#STORAGES[@]} -eq 0 ]]; then
  stop "no storage on this server may hold containers. Datacenter > Storage > double-click one > Content > also select 'Container', then run this again."
fi
STORAGE=${STORAGES[0]}
for s in "${STORAGES[@]}"; do [[ "$s" == local-lvm ]] && STORAGE=local-lvm; done
if [[ ${#STORAGES[@]} -gt 1 ]]; then
  for i in "${!STORAGES[@]}"; do echo "  $((i + 1))) ${STORAGES[$i]}"; done
  while true; do
    read -rp "Choose a number [the one called $STORAGE]: " pick
    pick="${pick// /}"
    [[ -z "$pick" ]] && break
    if [[ "$pick" =~ ^[0-9]+$ ]] && (( pick >= 1 && pick <= ${#STORAGES[@]} )); then
      STORAGE=${STORAGES[$((pick - 1))]}; break
    fi
    echo "Please type a number from the list, or press Enter."
  done
fi
echo "    using $STORAGE"

# ---- 5. Create the container --------------------------------------------------------
step "5/6 Creating the container and installing the map"
CTID=$(pvesh get /cluster/nextid)
CTID="$CTID" STORAGE="$STORAGE" DATA_HOST_PATH="$DATA" bash "$DIR/deploy/create-ct.sh" \
  || stop "the container wasn't finished. Read the message above; to try again, run the same command."

# ---- 6. Backups on TrueNAS (only when the logs come from a share) ----------------------
step "6/6 Backups"
echo "    Backups of your settings and login are kept on this server (/root/dji-flightmap-backups)."
if [[ "$DATA" == "$ARCHIVE" ]] && awk -v mp="$ARCHIVE" '$2 == mp && $3 == "cifs" {f=1} END {exit !f}' /etc/fstab; then
  echo "    Recommended: a copy on TrueNAS too, in case this server's disk fails."
  echo "    First, in Windows Explorer, make a folder called flightmap-backups NEXT TO"
  echo "    your logs folder (not inside it), where the Pi dock can't write."
  if no_default "Is that folder made, and shall I connect it now?"; then
    bash "$DIR/deploy/setup-backup-share.sh" \
      || echo "Backups on TrueNAS aren't set up yet. Later, run:  cd $DIR && bash deploy/setup-backup-share.sh"
  else
    echo "    Later, run:  cd $DIR && bash deploy/setup-backup-share.sh"
  fi
fi

# ---- Done ----------------------------------------------------------------------------
IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
HTTPS_PORT=$(pct exec "$CTID" -- curl -s -m 5 http://127.0.0.1:8080/api/health 2>/dev/null | sed -n 's/.*"httpsPort": *\([0-9]*\).*/\1/p' || true)
if [[ -n "$HTTPS_PORT" ]]; then
  ADDRESS="https://${IP:-<container-ip>}"
  [[ "$HTTPS_PORT" != 443 ]] && ADDRESS="$ADDRESS:$HTTPS_PORT"
else
  ADDRESS="http://${IP:-<container-ip>}:8080"
fi
echo
echo "======================================================================"
echo " DJI Flight Map $VERSION is installed (container $CTID)."
echo
echo " Open it in your browser:  $ADDRESS"
if [[ "$ADDRESS" == https* ]]; then
  echo
  echo " The first time, the browser warns \"Your connection isn't private\"."
  echo " That's expected: click Advanced, then Continue. Then trust the map on"
  echo " each device: Settings > Secure connection (HTTPS) > Download the"
  echo " map's certificate (the README explains each step)."
fi
echo
echo " Update it later with:  cd $DIR && bash deploy/update-ct.sh"
echo "======================================================================"
