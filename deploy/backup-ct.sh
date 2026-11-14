#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# backup-ct.sh - run on the PROXMOX HOST to back up the map's settings,
# login and flight plans right now (the daily timer runs this too).
#
#   bash deploy/backup-ct.sh
#
# The backup is kept on this server (/root/dji-flightmap-backups) and, if
# the TrueNAS backup folder is connected (setup-backup-share.sh), copied there.
# A container that is switched off is skipped, not started.
# ---------------------------------------------------------------------------
set -euo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd /
export LANG=C.UTF-8 LC_ALL=C.UTF-8
# shellcheck source=deploy/ct-backup.sh
source "$SRC_DIR/deploy/ct-backup.sh"

find_ctid
if ! pct status "$CTID" 2>/dev/null | grep -q running; then
  echo "Container $CTID is not running, so there is nothing new to back up."
  exit 0
fi
BACKUP="$BACKUP_ROOT/ct${CTID}_$(date +%Y-%m-%d_%H-%M-%S)"
echo "==> Backing up container $CTID to $BACKUP"
backup_config "$CTID" "$BACKUP"
copy_offsite "$BACKUP"
prune_backups "$CTID"
