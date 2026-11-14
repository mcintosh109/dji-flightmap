# shellcheck shell=bash
# ---------------------------------------------------------------------------
# ct-backup.sh - shared helpers for update-ct.sh and restore-ct.sh.
# Not run on its own: the other scripts load it with "source".
#
# Runs on the PROXMOX HOST and copies your settings in and out of the
# container with "pct pull" (container -> host) and "pct push" (host ->
# container).
# ---------------------------------------------------------------------------

# Files that hold YOUR choices.
# Format: path inside the container | owner | permissions | name in the backup folder
CONFIG_FILES=(
  "/etc/default/dji-flightmap|root|0600|login-and-server.env"           # login, port, data folder
  "/var/lib/dji-flightmap/settings.json|flightmap|0600|settings.json"   # settings page (map keys, nicknames, ...)
  "/var/lib/dji-flightmap/session-secret|flightmap|0600|session-secret" # keeps you signed in
  "/var/lib/dji-flightmap/plans.json|flightmap|0600|plans.json"         # saved flight plans
)

# Backups are kept on the Proxmox host, readable by root only.
BACKUP_ROOT="${BACKUP_ROOT:-/root/dji-flightmap-backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

# Find the container if CTID wasn't given: the one named "dji-flightmap".
find_ctid() {
  if [[ -n "${CTID:-}" ]]; then return; fi
  local found
  found=$(pct list | awk 'NR>1 && $NF=="dji-flightmap" {print $1}')
  if [[ $(wc -w <<<"$found") -eq 1 ]]; then
    CTID=$found
    echo "Using container $CTID (dji-flightmap)"
  else
    echo "Please tell me which container to use, e.g.:  CTID=111 bash $0" >&2
    echo "(The number is shown next to the container in the Proxmox web UI, or run: pct list)" >&2
    exit 1
  fi
}

# Make sure the container exists and is running.
ensure_running() {
  if ! pct status "$1" >/dev/null 2>&1; then
    echo "Container $1 doesn't exist. Check the number with: pct list" >&2
    exit 1
  fi
  if ! pct status "$1" | grep -q running; then
    echo "    starting container $1"
    pct start "$1"
    sleep 3
  fi
}

# Copy the settings files out of the container into folder $2.
backup_config() {
  local ctid=$1 dir=$2 entry path owner perms name
  mkdir -p "$dir"
  chmod 700 "$BACKUP_ROOT" "$dir"
  for entry in "${CONFIG_FILES[@]}"; do
    IFS='|' read -r path owner perms name <<<"$entry"
    if pct exec "$ctid" -- test -f "$path"; then
      pct pull "$ctid" "$path" "$dir/$name"
      chmod 600 "$dir/$name"
      echo "    saved $path"
    fi
  done
}

# Put the files from folder $2 back into the container, but only the ones
# that are missing or different (so nothing is touched needlessly).
restore_config() {
  local ctid=$1 dir=$2 entry path owner perms name want have
  for entry in "${CONFIG_FILES[@]}"; do
    IFS='|' read -r path owner perms name <<<"$entry"
    [[ -f "$dir/$name" ]] || continue
    want=$(sha256sum < "$dir/$name" | cut -d' ' -f1)
    have=$(pct exec "$ctid" -- sh -c "sha256sum 2>/dev/null < '$path'" 2>/dev/null | cut -d' ' -f1 || true)
    if [[ "$want" == "$have" ]]; then
      echo "    $path is unchanged"
      continue
    fi
    pct exec "$ctid" -- mkdir -p "$(dirname "$path")"
    pct push "$ctid" "$dir/$name" "$path" --perms "$perms" --user "$owner" --group "$owner"
    echo "    $path put back"
  done
}

# Ask the map server inside the container whether it is answering.
health_check() {
  local ctid=$1 port
  port=$(pct exec "$ctid" -- sh -c "grep -E '^PORT=' /etc/default/dji-flightmap | cut -d= -f2" 2>/dev/null || true)
  port=${port:-8080}
  for _ in $(seq 1 20); do
    if pct exec "$ctid" -- python3 -c \
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/api/health', timeout=3)" \
        >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Keep only the newest $KEEP_BACKUPS backups of this container.
prune_backups() {
  local ctid=$1
  ls -1dt "$BACKUP_ROOT"/ct"${ctid}"_* 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -rf
}
