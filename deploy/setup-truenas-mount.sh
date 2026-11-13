#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# setup-truenas-mount.sh - run on the PROXMOX HOST (as root), once.
#
# Connects the TrueNAS share that holds your flight logs to this Proxmox
# host, READ-ONLY, so the flight map container can read it:
#
#   \\192.168.1.10\Backups\DJI Flight logs\archive   ->   /mnt/dji-archive
#
#   bash deploy/setup-truenas-mount.sh
#
# It asks for the TrueNAS username and password (the same ones you use in
# Windows). They are saved in /etc/smb-dji-flightmap.cred, a file only root
# can read, and the connection is added to /etc/fstab so it comes back
# after a reboot.
#
# Different server or folder? Override the defaults, e.g.:
#   SERVER=10.0.0.5 SHARE_PATH="Backups/DJI Flight logs/archive" bash deploy/setup-truenas-mount.sh
# ---------------------------------------------------------------------------
set -euo pipefail

SERVER="${SERVER:-192.168.1.10}"
SHARE_PATH="${SHARE_PATH:-Backups/DJI Flight logs/archive}"   # share name, then folders
MOUNT_POINT="${MOUNT_POINT:-/mnt/dji-archive}"
CRED_FILE=/etc/smb-dji-flightmap.cred

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root on the Proxmox host." >&2
  exit 1
fi

echo "==> Installing the SMB/CIFS tools (cifs-utils)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cifs-utils >/dev/null

echo
echo "This will connect (read-only) to:  //${SERVER}/${SHARE_PATH}"
echo "and make it appear on this host at: ${MOUNT_POINT}"
echo

if [[ -f "$CRED_FILE" ]]; then
  read -rp "Saved TrueNAS login found. Use it again? [Y/n] " reuse
else
  reuse=n
fi
if [[ "${reuse,,}" == n* ]]; then
  read -rp "TrueNAS username: " SMB_USER
  read -rsp "TrueNAS password (nothing shows while you type): " SMB_PASS
  echo
  # umask 077 = the new file can only be read by root
  ( umask 077; printf 'username=%s\npassword=%s\n' "$SMB_USER" "$SMB_PASS" > "$CRED_FILE" )
  unset SMB_PASS
fi
chmod 600 "$CRED_FILE"

mkdir -p "$MOUNT_POINT"

# In /etc/fstab a space must be written as \040
UNC="//${SERVER}/${SHARE_PATH}"
UNC_FSTAB="${UNC// /\\040}"
# ro                       read-only: nothing on the NAS can be changed from here
# file_mode/dir_mode       everyone may read, so the unprivileged container can too
# _netdev,nofail           it is a network drive; don't stop booting if the NAS is off
# x-systemd.before=...     connect BEFORE Proxmox starts the containers
OPTS="credentials=${CRED_FILE},ro,vers=3.0,iocharset=utf8,file_mode=0444,dir_mode=0555,_netdev,nofail,x-systemd.before=pve-guests.service,x-systemd.mount-timeout=30"
LINE="${UNC_FSTAB}  ${MOUNT_POINT}  cifs  ${OPTS}  0  0"

echo "==> Adding the connection to /etc/fstab (backup saved as /etc/fstab.bak-dji-flightmap)"
cp /etc/fstab /etc/fstab.bak-dji-flightmap
# Remove an older line for the same folder, then add the new one.
grep -vF " ${MOUNT_POINT} " /etc/fstab > /etc/fstab.new || true
echo "$LINE" >> /etc/fstab.new
mv /etc/fstab.new /etc/fstab
systemctl daemon-reload

echo "==> Connecting"
umount "$MOUNT_POINT" 2>/dev/null || true
if ! mount "$MOUNT_POINT"; then
  echo >&2
  echo "Could not connect. Common reasons:" >&2
  echo "  error(13) Permission denied -> wrong username/password, or that user can't read the share" >&2
  echo "  error(2)  No such file      -> the share or folder name is spelled differently" >&2
  echo "  error(112)/(113) Host down  -> TrueNAS is off or the IP address is wrong" >&2
  echo "Run this script again to retry. More detail:  dmesg | tail" >&2
  exit 1
fi

COUNT=$(find "$MOUNT_POINT" -type f -iname '*.csv' 2>/dev/null | wc -l)
echo
echo "Connected! ${MOUNT_POINT} contains:"
ls "$MOUNT_POINT" | head -10
echo "...with ${COUNT} flight CSV file(s) in total."
echo
echo "Next step:  bash deploy/create-ct.sh"
