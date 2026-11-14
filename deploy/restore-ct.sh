#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore-ct.sh - run on the PROXMOX HOST to put saved settings (map keys,
# nicknames, login, ...) back into a container. Handy after rebuilding the
# container, or to go back to an earlier backup.
#
#   bash deploy/restore-ct.sh                       # newest backup (this server or TrueNAS)
#   bash deploy/restore-ct.sh /root/dji-flightmap-backups/ct111_2026-11-14_10-00-00
#
# (Add CTID=112 in front to restore into a different container.)
# Backups are made automatically by update-ct.sh.
# ---------------------------------------------------------------------------
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Run from "/" with a language setting every Linux system has. Otherwise
# commands inside the container complain: the update replaces the folder the
# Shell would be "standing in", and the container may not have the Shell's
# language pack (e.g. en_US.UTF-8).
cd /
export LANG=C.UTF-8 LC_ALL=C.UTF-8
# shellcheck source=deploy/ct-backup.sh
source "$SRC_DIR/deploy/ct-backup.sh"

FROM="${1:-}"
if [[ -z "$FROM" ]]; then
  FROM=$(newest_backup || true)
fi
if [[ -z "$FROM" || ! -d "$FROM" ]]; then
  echo "No backup found in $BACKUP_ROOT or on TrueNAS ($OFFSITE_DIR)." >&2
  echo "Backups are made by update-ct.sh and backup-ct.sh." >&2
  exit 1
fi

find_ctid
ensure_running "$CTID"
if ! pct exec "$CTID" -- id flightmap >/dev/null 2>&1; then
  echo "The flight map isn't installed in container $CTID yet. Run create-ct.sh first." >&2
  exit 1
fi

echo "==> Putting back the settings from $FROM"
ls -1 "$FROM" | sed 's/^/    found /'
read -rp "Restore these into container $CTID? [y/N] " answer
if [[ "${answer,,}" != y* ]]; then
  echo "Nothing changed."
  exit 0
fi

restore_config "$CTID" "$FROM"
pct exec "$CTID" -- systemctl restart dji-flightmap
if health_check "$CTID"; then
  echo "Done. The map is working with the restored settings."
else
  echo "Restored, but the map isn't answering. Its log:" >&2
  pct exec "$CTID" -- journalctl -u dji-flightmap -n 25 --no-pager >&2 || true
  exit 1
fi
