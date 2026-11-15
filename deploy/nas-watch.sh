#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# nas-watch.sh - keeps the flight logs on the NAS connected, even after the
# NAS restarts. Runs on the PROXMOX HOST every minute
# (dji-flightmap-nas.timer, set up by update-ct.sh and create-ct.sh).
#
#   1. Does the NAS answer on the network? If not, wait: it is probably
#      off or restarting, and nothing can be fixed until it is back.
#   2. Is the share connected on this server (/mnt/dji-archive), and can it
#      be read? If not, connect it again.
#   3. Does the map's container see it? A container started while the share
#      was missing keeps seeing the empty folder underneath, even after the
#      share comes back, so it is restarted (about 20 seconds). That happens
#      at most once every 15 minutes, or straight away when "Reconnect now"
#      is pressed on the settings page.
#   4. Tells the map what it found (nas-host.json), for the settings page.
#
# Nothing is ever deleted. To watch what it does, run it by hand:
#   bash /root/dji-flightmap/deploy/nas-watch.sh --verbose
# (Research: "systemd timer", "cifs mount", "proxmox lxc bind mount".)
# ---------------------------------------------------------------------------
set -uo pipefail
cd /
export LANG=C.UTF-8 LC_ALL=C.UTF-8

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${ARCHIVE:-/mnt/dji-archive}"
BACKUPS="${BACKUPS:-/mnt/dji-flightmap-backups}"
FSTAB="${FSTAB:-/etc/fstab}"
STATE_FILE="${NAS_STATE_FILE:-/var/lib/dji-flightmap-nas/state}"
NAS_PORT="${NAS_PORT:-445}"           # SMB, Windows file sharing
RESTART_GAP="${RESTART_GAP:-900}"     # restart the container at most this often (seconds)
VERBOSE=no
[[ "${1:-}" == --verbose ]] && VERBOSE=yes
NOW=$(date +%s)

say()  { echo "$*"; }                                   # goes to the log (journalctl)
note() { [[ "$VERBOSE" == yes ]] && echo "    $*"; return 0; }
json_text() {   # make text safe to put between "quotes" in JSON
  local t=${1//\\/\\\\}
  t=${t//\"/\\\"}
  printf '%s' "$t" | tr -d '\000-\037'
}

# Don't get in the way of an install, update or restore.
if pgrep -f 'deploy/(update-ct|restore-ct|create-ct|easy-install)\.sh' >/dev/null 2>&1; then
  note "an install, update or restore is running: skipped this time"
  exit 0
fi

# What happened last time (kept on this server).
HANDLED=$(sed -n 's/^handled=//p' "$STATE_FILE" 2>/dev/null | tail -1)
RESTARTED=$(sed -n 's/^restarted=//p' "$STATE_FILE" 2>/dev/null | tail -1)
HANDLED=${HANDLED:-0}; RESTARTED=${RESTARTED:-0}

# ---- The map's container ------------------------------------------------------
CTID="${CTID:-$(pct list 2>/dev/null | awk 'NR>1 && $NF=="dji-flightmap" {print $1}' | head -1)}"
running() { [[ -n "$CTID" ]] && pct status "$CTID" 2>/dev/null | grep -q running; }
FS=none; READABLE=no; REQUEST=0; CT_STATE=/var/lib/dji-flightmap
look_inside() {   # what does the container see?
  local view
  FS=none; READABLE=no; REQUEST=0
  running || return 0
  view=$(timeout 60 pct exec "$CTID" -- bash -s < "$SRC_DIR/deploy/nas-view.sh" 2>/dev/null | tail -1)
  FS=$(sed -n 's/.*fs=\([^ ]*\).*/\1/p' <<<"$view"); FS=${FS:-none}
  READABLE=$(sed -n 's/.*readable=\([^ ]*\).*/\1/p' <<<"$view"); READABLE=${READABLE:-no}
  REQUEST=$(sed -n 's/.*request=\([0-9]*\).*/\1/p' <<<"$view"); REQUEST=${REQUEST:-0}
  CT_STATE=$(sed -n 's/.*state=\(.*\)$/\1/p' <<<"$view"); CT_STATE=${CT_STATE:-/var/lib/dji-flightmap}
}
# The container sees the share if the share is mounted there and can be read.
# (An empty share is fine too, as long as it is empty on this server as well:
# a new install may have no flights yet. That's no reason to restart.)
host_has_files() { mountpoint -q "$ARCHIVE" && timeout -k 5 15 ls -A "$ARCHIVE" 2>/dev/null | grep -q .; }
sees_share() { [[ "$FS" =~ ^(cifs|smb3|smbfs)$ ]] && { [[ "$READABLE" == yes ]] || ! host_has_files; }; }
look_inside
PENDING=no
(( REQUEST > HANDLED )) && PENDING=yes
note "container: ${CTID:-none}, sees: fs=$FS readable=$READABLE, reconnect asked: $PENDING"

# ---- The NAS share on this server --------------------------------------------------
LINE=$(awk -v mp="$ARCHIVE" '$2 == mp && $3 == "cifs"' "$FSTAB" 2>/dev/null | head -1)
SHARE=yes; SERVER=""; REACH=no; HOST_OK=no; ACTION=""; PROBLEM=""
host_reads() { mountpoint -q "$ARCHIVE" && timeout -k 5 15 ls -A "$ARCHIVE" >/dev/null 2>&1; }

if [[ -z "$LINE" ]]; then
  SHARE=no      # the logs come from a folder on this server: nothing to reconnect
  note "no NAS share for $ARCHIVE in $FSTAB: nothing to do"
else
  SOURCE=${LINE%%[[:space:]]*}
  SERVER=${SOURCE#//}; SERVER=${SERVER%%/*}
  if timeout 5 bash -c "exec 3<>/dev/tcp/$SERVER/$NAS_PORT" 2>/dev/null; then REACH=yes; fi
  note "NAS $SERVER answers: $REACH"
  if [[ "$REACH" == no ]]; then
    # Leave the old connection alone: it comes back by itself, often
    # without anything else needing to be done.
    PROBLEM="The NAS ($SERVER) doesn't answer on the network: it may be off or restarting. The map reconnects by itself when it is back."
  else
    host_reads && HOST_OK=yes
    if [[ "$HOST_OK" == no ]] || { [[ "$PENDING" == yes ]] && ! sees_share; }; then
      mountpoint -q "$ARCHIVE" && umount -l "$ARCHIVE" 2>/dev/null
      if ERR=$(timeout 60 mount "$ARCHIVE" 2>&1) && host_reads; then
        HOST_OK=yes
        ACTION="Connected the NAS share again on the Proxmox server."
        say "$ACTION"
      else
        HOST_OK=no
        PROBLEM="The NAS answers, but its share couldn't be connected: $(tail -1 <<<"${ERR:-it could not be read}")"
        say "$PROBLEM"
      fi
    fi
    # The TrueNAS backup folder, if there is one: connect it again too.
    if awk -v mp="$BACKUPS" '$2 == mp && $3 == "cifs" {f = 1} END {exit !f}' "$FSTAB" 2>/dev/null \
        && ! mountpoint -q "$BACKUPS"; then
      timeout 60 mount "$BACKUPS" >/dev/null 2>&1 && say "Connected the TrueNAS backup folder again."
    fi
  fi

  # ---- Does the container see it? ------------------------------------------------
  if [[ "$HOST_OK" == yes ]] && running && ! sees_share; then
    if [[ "$PENDING" == yes ]] || (( NOW - RESTARTED >= RESTART_GAP )); then
      say "The map's container $CTID doesn't see the NAS share: restarting it, so it does."
      if timeout 180 pct reboot "$CTID" >/dev/null 2>&1; then
        RESTARTED=$NOW
        ACTION="${ACTION:+$ACTION }Restarted the map, so it sees the NAS share again."
        for _ in $(seq 1 30); do pct exec "$CTID" -- true >/dev/null 2>&1 && break; sleep 2; done
        look_inside
        sees_share || PROBLEM="The map was restarted but still doesn't see the NAS share. On the Proxmox server, run: bash $SRC_DIR/deploy/nas-watch.sh --verbose"
      else
        PROBLEM="The map's container couldn't be restarted. Restart it in the Proxmox web page."
        say "$PROBLEM"
      fi
    else
      PROBLEM="The map doesn't see the NAS share yet. It restarts itself at $(date -d "@$((RESTARTED + RESTART_GAP))" +%H:%M), or press Reconnect now."
      note "$PROBLEM"
    fi
  fi
fi

# ---- Remember, and tell the map ------------------------------------------------------
if [[ "$PENDING" == yes ]]; then
  HANDLED=$REQUEST
  [[ -z "$ACTION$PROBLEM" ]] && ACTION="Checked just now: the NAS share was already connected; nothing needed fixing."
fi
mkdir -p "$(dirname "$STATE_FILE")"
printf 'handled=%s\nrestarted=%s\n' "$HANDLED" "$RESTARTED" > "$STATE_FILE"

if running; then
  REPORT=$(printf '{"at": %s, "share": %s, "server": "%s", "reachable": %s, "hostConnected": %s, "action": "%s", "problem": "%s", "handled": %s, "restartedAt": %s}\n' \
    "$NOW" "$([[ $SHARE == yes ]] && echo true || echo false)" "$(json_text "$SERVER")" \
    "$([[ $REACH == yes ]] && echo true || echo false)" "$([[ $HOST_OK == yes ]] && echo true || echo false)" \
    "$(json_text "$ACTION")" "$(json_text "$PROBLEM")" "$HANDLED" "$RESTARTED")
  # Written to a temporary name first, then renamed, so the map never reads half of it.
  timeout 30 pct exec "$CTID" -- sh -c 'cat > "$1.tmp" && chmod 644 "$1.tmp" && mv "$1.tmp" "$1"' sh "$CT_STATE/nas-host.json" <<<"$REPORT" \
    || note "couldn't tell the map (is it starting?)"
fi
note "done${ACTION:+: $ACTION}${PROBLEM:+ (problem: $PROBLEM)}"
exit 0
