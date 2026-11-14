#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-ct.sh - run on the PROXMOX HOST to update the flight map.
#
#   cd /root/dji-flightmap && bash deploy/update-ct.sh
#
# installs the newest RELEASED version: one that was tried on a real server
# and then marked ready with a tag like v2.3.0 (research: "git tag").
#
#   bash deploy/update-ct.sh --test            the newest test version, which
#                                              has not been released yet
#   bash deploy/update-ct.sh --version 2.3.0   that release (to go back to it)
#
# (Add CTID=111 in front if you have more than one dji-flightmap container.)
#
# What it does, step by step:
#   1. asks GitHub for the versions and picks the one to install
#   2. saves your settings, map keys and login to the Proxmox host
#   3. saves the current version of the app, so it can be undone
#   4. installs the chosen version
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

usage() {
  echo "Usage: bash deploy/update-ct.sh [--test | --version X.Y.Z]"
  echo "  (no option)       install the newest released version"
  echo "  --test            install the newest test version (not released yet)"
  echo "  --version 2.3.0   install that released version"
}

MODE=release      # release | test | version
WANT=""           # the version asked for with --version
CHOOSE=yes        # "no" once step 1 is done (the script restarts itself after it)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) MODE="test" ;;
    --version) MODE=version; WANT="${2:-}"; shift || true ;;
    --version=*) MODE=version; WANT="${1#--version=}" ;;
    --no-pull) CHOOSE=no ;;     # install the files as they are (used after step 1, and by the tests)
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift || true
done

# ---- 1. Pick the version -------------------------------------------------
# Two things are decided here:
#   INSTALL  what goes into the container
#   TOOL     which copy of these scripts runs the update: always the newest,
#            even when going back to an older version, so the next update
#            still works
# Then the script restarts itself from TOOL, with INSTALL passed along.
version_in() { git -C "$SRC_DIR" show "$1:app/version.json" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1; }

if [[ "$CHOOSE" == yes && -d "$SRC_DIR/.git" ]]; then
  echo "==> 1/6 Asking GitHub which versions exist"
  if ! git -C "$SRC_DIR" fetch -q --tags origin; then
    echo "Could not reach GitHub. Check this server's internet connection and try again." >&2
    exit 1
  fi
  NEWEST=$(git -C "$SRC_DIR" tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
  case "$MODE" in
    test)
      INSTALL=origin/main
      LABEL="test version $(version_in origin/main), which has NOT been released yet"
      ;;
    version)
      TAG="v${WANT#v}"
      if [[ -z "$WANT" ]] || ! git -C "$SRC_DIR" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
        echo "There is no released version '${WANT}'. Released versions:" >&2
        git -C "$SRC_DIR" tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | sed 's/^v/  /' >&2
        exit 1
      fi
      INSTALL=$TAG
      LABEL="version ${TAG#v}"
      ;;
    *)
      if [[ -n "$NEWEST" ]]; then
        INSTALL=$NEWEST
        LABEL="version ${NEWEST#v}, the newest release"
      else
        INSTALL=origin/main
        LABEL="version $(version_in origin/main) (no version has been released yet)"
      fi
      ;;
  esac
  # The scripts to run: the newest release (or the test version when testing),
  # as long as that copy knows how to install a chosen version.
  TOOL=${NEWEST:-origin/main}
  [[ "$MODE" == "test" ]] && TOOL=origin/main
  if git -C "$SRC_DIR" show "$TOOL:deploy/update-ct.sh" 2>/dev/null | grep -q FLIGHTMAP_INSTALL_REF; then
    if ! git -C "$SRC_DIR" checkout -q --detach "$TOOL"; then
      echo "Could not switch $SRC_DIR to $TOOL. Has a file in it been changed by hand?" >&2
      echo "See what changed with:  git -C $SRC_DIR status" >&2
      exit 1
    fi
  fi
  echo "    chosen: $LABEL"
  exec env FLIGHTMAP_INSTALL_REF="$INSTALL" FLIGHTMAP_INSTALL_LABEL="$LABEL" bash "$SRC_DIR/deploy/update-ct.sh" --no-pull
fi
[[ "$CHOOSE" == no ]] || echo "==> 1/6 (not a git folder: installing the files as they are)"
INSTALL_REF="${FLIGHTMAP_INSTALL_REF:-}"      # empty = install the files in this folder
INSTALL_LABEL="${FLIGHTMAP_INSTALL_LABEL:-the files in $SRC_DIR}"

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

echo "==> 4/6 Installing $INSTALL_LABEL"
TARBALL=$(mktemp --suffix=.tar.gz)
if [[ -n "$INSTALL_REF" ]]; then
  # Exactly the files of the chosen version, straight from git.
  git -C "$SRC_DIR" archive --format=tar.gz -o "$TARBALL" "$INSTALL_REF" app deploy
else
  tar -C "$SRC_DIR" -czf "$TARBALL" app deploy
fi
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
NOW=$(pct exec "$CTID" -- sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/dji-flightmap/app/version.json | head -1 || true)
echo
echo "Update finished. Version ${NOW:-?} is installed and the map is working: http://${IP}:${PORT:-8080}"
echo "Your settings were backed up to: $BACKUP"
echo "Tip: press Ctrl+Shift+R in the browser to load the new version."
