#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# setup-backup-share.sh - run on the PROXMOX HOST (as root), once.
#
# Connects a WRITABLE folder on TrueNAS for backups of the map's settings,
# login and flight plans, and (optionally) makes a backup every day:
#
#   \\<truenas>\<share>\...\flightmap-backups   ->   /mnt/dji-flightmap-backups
#
#   bash deploy/setup-backup-share.sh
#
# Before running it: create the folder "flightmap-backups" on TrueNAS ONE
# LEVEL ABOVE "DJI Flight logs" (so the Pi dock, which can write inside
# "DJI Flight logs", can't touch the backups), and make sure your TrueNAS
# user can write to it.
# The backups contain your map keys and the login's password hash, so only
# people you trust should be able to open that folder.
# ---------------------------------------------------------------------------
set -euo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd /
export LANG=C.UTF-8 LC_ALL=C.UTF-8

MOUNT_POINT=/mnt/dji-flightmap-backups
CRED_FILE=/etc/smb-dji-flightmap.cred
ARCHIVE_MOUNT=/mnt/dji-archive

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root on the Proxmox host." >&2
  exit 1
fi
if ! command -v mount.cifs >/dev/null; then
  echo "==> Installing the SMB/CIFS tools (cifs-utils)"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cifs-utils >/dev/null
fi

# ---- Which folder? -----------------------------------------------------------
# Suggest: two levels above the archive folder, i.e. next to "DJI Flight logs"
# rather than inside it, where the Pi dock can't write. In /etc/fstab spaces
# are written as \040.
UNC_FSTAB=""
ARCHIVE_UNC=$(awk -v mp="$ARCHIVE_MOUNT" '$2 == mp && $3 == "cifs" {print $1; exit}' /etc/fstab)
if [[ -n "$ARCHIVE_UNC" ]]; then
  PARENT="${ARCHIVE_UNC%/*}"      # .../DJI Flight logs
  SUGGEST="${PARENT%/*}/flightmap-backups"
  PARENT_NAME="${PARENT##*/}"
  echo "Backup folder on TrueNAS (next to \"${PARENT_NAME//\\040/ }\", where the Pi dock can't write):"
  echo "  ${SUGGEST//\\040/ }"
  read -rp "Use this folder? [Y/n] " answer
  [[ "${answer,,}" == n* ]] || UNC_FSTAB="$SUGGEST"
fi
if [[ -z "$UNC_FSTAB" ]]; then
  read -rp "TrueNAS IP address (example: 192.168.1.10): " SERVER
  echo "Folder, as shown in Windows Explorer, e.g. MyShare/DJI logs/flightmap-backups"
  read -rp "Folder: " SHARE_PATH
  SERVER="${SERVER//\\//}"; SERVER="${SERVER#//}"; SERVER="${SERVER%%/*}"
  SHARE_PATH="${SHARE_PATH//\\//}"
  [[ "$SHARE_PATH" == //* ]] && { SHARE_PATH="${SHARE_PATH#//}"; SHARE_PATH="${SHARE_PATH#*/}"; }
  SHARE_PATH="${SHARE_PATH#/}"; SHARE_PATH="${SHARE_PATH%/}"
  if [[ -z "$SERVER" || -z "$SHARE_PATH" ]]; then
    echo "The IP address and folder are both needed." >&2
    exit 1
  fi
  UNC="//${SERVER}/${SHARE_PATH}"
  UNC_FSTAB="${UNC// /\\040}"
fi

# ---- Which login? ------------------------------------------------------------
if [[ -f "$CRED_FILE" ]]; then
  read -rp "Use the same TrueNAS login as the archive folder? [Y/n] " reuse
else
  reuse=n
fi
if [[ "${reuse,,}" == n* ]]; then
  CRED_FILE=/etc/smb-dji-flightmap-backups.cred
  read -rp "TrueNAS username: " SMB_USER
  read -rsp "TrueNAS password (nothing shows while you type): " SMB_PASS
  echo
  ( umask 077; printf 'username=%s\npassword=%s\n' "$SMB_USER" "$SMB_PASS" > "$CRED_FILE" )
  unset SMB_PASS
fi
chmod 600 "$CRED_FILE"

# ---- Connect it ----------------------------------------------------------------
# rw                         this folder must be writable (the archive stays read-only)
# uid/gid=0, 0600/0700       on this host, only root can read the backups
# _netdev,nofail             a network drive; don't stop booting if TrueNAS is off
OPTS="credentials=${CRED_FILE},rw,vers=3.0,iocharset=utf8,uid=0,gid=0,file_mode=0600,dir_mode=0700,_netdev,nofail,x-systemd.mount-timeout=30"
mkdir -p "$MOUNT_POINT"
echo "==> Adding the backup folder to /etc/fstab (backup saved as /etc/fstab.bak-dji-flightmap-backups)"
cp /etc/fstab /etc/fstab.bak-dji-flightmap-backups
grep -vF " ${MOUNT_POINT} " /etc/fstab > /etc/fstab.new || true
echo "${UNC_FSTAB}  ${MOUNT_POINT}  cifs  ${OPTS}  0  0" >> /etc/fstab.new
mv /etc/fstab.new /etc/fstab
systemctl daemon-reload

echo "==> Connecting"
umount "$MOUNT_POINT" 2>/dev/null || true
if ! mount "$MOUNT_POINT"; then
  echo >&2
  echo "Could not connect. Common reasons:" >&2
  echo "  error(2)  No such file      -> create the folder 'flightmap-backups' on TrueNAS first (next to 'DJI Flight logs')" >&2
  echo "  error(13) Permission denied -> wrong login, or that user can't use this folder" >&2
  echo "Run this script again to retry." >&2
  exit 1
fi
if ! ( touch "$MOUNT_POINT/.write-test" && rm -f "$MOUNT_POINT/.write-test" ); then
  echo "Connected, but this TrueNAS user can't WRITE to the folder." >&2
  echo "On TrueNAS, give the user write permission to flightmap-backups, then run this again." >&2
  exit 1
fi
echo "    connected, and writing works"

# ---- Daily backup ----------------------------------------------------------------
read -rp "Make a backup automatically every day (about 3:30 AM)? [Y/n] " daily
if [[ "${daily,,}" != n* ]]; then
  cat > /etc/systemd/system/dji-flightmap-backup.service <<EOF
[Unit]
Description=Back up DJI Flight Map settings, login and flight plans
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${SRC_DIR}/deploy/backup-ct.sh
EOF
  cat > /etc/systemd/system/dji-flightmap-backup.timer <<'EOF'
[Unit]
Description=Daily DJI Flight Map backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now dji-flightmap-backup.timer
  echo "    daily backup is on (next run: $(systemctl show dji-flightmap-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || echo 'tonight'))"
fi

echo "==> Making the first backup now"
bash "$SRC_DIR/deploy/backup-ct.sh"
echo
echo "Done. Backups go to TrueNAS ($MOUNT_POINT) and stay on this server too."
