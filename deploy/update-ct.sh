#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-ct.sh - run on the PROXMOX HOST to update the flight map.
#
#   cd /root/dji-flightmap && bash deploy/update-ct.sh
#
# (Add CTID=111 in front if you have more than one dji-flightmap container.)
#
# What it does, step by step:
#   1. downloads the newest version from GitHub (git pull)
#   2. saves your settings, map keys and login to the Proxmox host
#   3. saves the current version of the app, so it can be undone
#   4. installs the new version
#   5. puts your settings back (only files that changed)
#   6. checks the map answers; if not, it undoes the update by itself
#
# Backups are kept in /root/dji-flightmap-backups (the newest 10).
# ---------------------------------------------------------------------------
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Run from "/" with a language setting every Linux system has. Otherwise
# commands inside the container complain: the update replaces the folder the
# Shell would be "standing in", and the container may not have the Shell's
# language pack (e.g. en_US.UTF-8).
cd /
export LANG=C.UTF-8 LC_ALL=C.UTF-8

# ---- 1. Download the newest version --------------------------------------
# After "git pull" the script starts itself again, so the NEW version of
# this script is the one that runs the update.
if [[ "${1:-}" != "--no-pull" && -d "$SRC_DIR/.git" ]]; then
  echo "==> 1/6 Downloading the newest version"
  git -C "$SRC_DIR" pull --ff-only
  exec bash "$SRC_DIR/deploy/update-ct.sh" --no-pull
fi
[[ "${1:-}" == "--no-pull" ]] || echo "==> 1/6 (not a git folder: using the files as they are)"

# shellcheck source=deploy/ct-backup.sh
source "$SRC_DIR/deploy/ct-backup.sh"
find_ctid
ensure_running "$CTID"

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP="$BACKUP_ROOT/ct${CTID}_${STAMP}"
PREVIOUS=/root/dji-flightmap-previous.tar.gz   # inside the container

echo "==> 2/6 Saving your settings and login to $BACKUP"
backup_config "$CTID" "$BACKUP"
copy_offsite "$BACKUP"

echo "==> 3/6 Saving the current version, so the update can be undone"
HAVE_PREVIOUS=no
if pct exec "$CTID" -- test -d /opt/dji-flightmap/app; then
  pct exec "$CTID" -- tar -czf "$PREVIOUS" -C /opt dji-flightmap
  HAVE_PREVIOUS=yes
  echo "    saved"
else
  echo "    (no earlier version found)"
fi

# Undo: put the previous version and the saved settings back.
undo() {
  echo >&2
  echo "==> Something went wrong. Undoing the update..." >&2
  if [[ "$HAVE_PREVIOUS" == yes ]]; then
    pct exec "$CTID" -- bash -c "rm -rf /opt/dji-flightmap && tar -xzf $PREVIOUS -C /opt"
    pct exec "$CTID" -- cp /opt/dji-flightmap/deploy/dji-flightmap.service /etc/systemd/system/dji-flightmap.service
    pct exec "$CTID" -- systemctl daemon-reload
  fi
  restore_config "$CTID" "$BACKUP"
  pct exec "$CTID" -- systemctl restart dji-flightmap || true
  if health_check "$CTID"; then
    echo "The previous version is back and working. Your settings are unchanged." >&2
  else
    echo "The map still isn't answering. Its log:" >&2
  fi
  pct exec "$CTID" -- journalctl -u dji-flightmap -n 25 --no-pager >&2 || true
  echo >&2
  echo "Please copy the messages above when asking for help." >&2
  exit 1
}

echo "==> 4/6 Installing the new version"
TARBALL=$(mktemp --suffix=.tar.gz)
tar -C "$SRC_DIR" -czf "$TARBALL" app deploy
pct push "$CTID" "$TARBALL" /root/dji-flightmap.tar.gz
rm -f "$TARBALL"
if ! pct exec "$CTID" -- bash -c "rm -rf /root/dji-flightmap && mkdir -p /root/dji-flightmap && tar -xzf /root/dji-flightmap.tar.gz -C /root/dji-flightmap && bash /root/dji-flightmap/deploy/install.sh"; then
  undo
fi

echo "==> 5/6 Putting your settings back"
restore_config "$CTID" "$BACKUP"
pct exec "$CTID" -- systemctl restart dji-flightmap

echo "==> 6/6 Checking the map works"
if ! health_check "$CTID"; then
  undo
fi
prune_backups "$CTID"

PORT=$(pct exec "$CTID" -- sh -c "grep -E '^PORT=' /etc/default/dji-flightmap | cut -d= -f2" || true)
IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
echo
echo "Update finished. The map is working: http://${IP}:${PORT:-8080}"
echo "Your settings were backed up to: $BACKUP"
echo "Tip: press Ctrl+Shift+R in the browser to load the new version."
