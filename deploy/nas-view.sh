# shellcheck shell=bash
# ---------------------------------------------------------------------------
# nas-view.sh - runs INSIDE the map's container. nas-watch.sh (on the
# Proxmox host) sends it there every minute with "pct exec ... bash -s".
#
# Prints one line about the flight logs folder, as the container sees it:
#   fs=cifs readable=yes request=1700000000 state=/var/lib/dji-flightmap
#     fs        what is mounted there: cifs = the NAS share; anything else
#               means the container sees the empty folder underneath
#     readable  could it be listed (within 10 seconds), and is it not empty
#     request   when "Reconnect now" was last pressed on the settings page
# ---------------------------------------------------------------------------
CONF="${NAS_VIEW_CONF:-/etc/default/dji-flightmap}"
MOUNTINFO="${NAS_VIEW_MOUNTINFO:-/proc/self/mountinfo}"

dir=$(sed -n 's/^DATA_DIR=//p' "$CONF" 2>/dev/null | tail -1)
dir=${dir:-/srv/dji-logs}
cache=$(sed -n 's/^CACHE_FILE=//p' "$CONF" 2>/dev/null | tail -1)
state=$(dirname "${cache:-/var/lib/dji-flightmap/summaries.json}")

# The filesystem type comes after the " - " in each mountinfo line; the
# last line for a folder is the one on top.
fs=$(awk -v mp="$dir" '$5 == mp { for (i = 7; i <= NF; i++) if ($i == "-") { fs = $(i + 1); break } } END { print fs }' "$MOUNTINFO" 2>/dev/null)
if [ -d "$dir" ] && timeout -k 3 10 ls -A "$dir" 2>/dev/null | grep -q .; then
  readable=yes
else
  readable=no
fi
request=$(sed -n 's/.*"at": *\([0-9]*\).*/\1/p' "$state/nas-request.json" 2>/dev/null | head -1)
echo "fs=${fs:-none} readable=$readable request=${request:-0} state=$state"
