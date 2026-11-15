#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# nas-watch.test.sh - tests for deploy/nas-watch.sh, the helper that keeps
# the map connected to the NAS after the NAS restarts.
#
# Everything happens in a temporary folder:
#   - the "NAS" is a small program listening on a free port (on = it answers)
#   - fake mount/umount/mountpoint commands connect a plain folder instead of
#     a real share
#   - a fake "pct" runs the container's side (nas-view.sh) on this machine,
#     with its own pretend mount list and logs folder
# So it never touches this machine's real mounts or system folders.
#
#   bash tests/nas-watch.test.sh
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d /tmp/flightmap-nas-XXXXXX)
NAS_PID=""
trap '[ -n "$NAS_PID" ] && kill "$NAS_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
FAKE="$WORK/bin"; FLAGS="$WORK/flags"; LOG="$WORK/log"
ARCHIVE="$WORK/mnt/archive"; CT="$WORK/ct"
mkdir -p "$FAKE" "$FLAGS" "$LOG" "$ARCHIVE" "$CT/logs" "$CT/state"
PASSED=0; FAILED=0
check() {   # check "name" command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS  $name"; PASSED=$((PASSED + 1))
  else echo "  FAIL  $name"; FAILED=$((FAILED + 1)); fi
}
NAS_PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')

# ---- the pretend NAS ---------------------------------------------------------------
nas_on() {
  python3 -c "import socket, time; s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', $NAS_PORT)); s.listen(); time.sleep(600)" &
  NAS_PID=$!
  touch "$FLAGS/nas-up"
  for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$NAS_PORT") 2>/dev/null && return; sleep 0.1; done
}
nas_off() { [ -n "$NAS_PID" ] && kill "$NAS_PID" 2>/dev/null; wait "$NAS_PID" 2>/dev/null; NAS_PID=""; rm -f "$FLAGS/nas-up"; }

# ---- fake commands on the Proxmox host --------------------------------------------
cat > "$FAKE/mountpoint" <<EOF
#!/bin/bash
[ -e "$FLAGS/mounted-\$(basename "\${@: -1}")" ]
EOF
cat > "$FAKE/mount" <<EOF
#!/bin/bash
echo "\$*" >> "$LOG/mount"
if [ -e "$FLAGS/nas-up" ]; then touch "$FLAGS/mounted-\$(basename "\$1")"; touch "\$1/2026-01-01_10-00-00" 2>/dev/null; exit 0; fi
echo "mount error(113): could not connect to 127.0.0.1Unable to find suitable address." >&2; exit 32
EOF
cat > "$FAKE/umount" <<EOF
#!/bin/bash
echo "\$*" >> "$LOG/umount"
rm -f "$FLAGS/mounted-\$(basename "\${@: -1}")"; rm -f "\${@: -1}"/* 2>/dev/null; exit 0
EOF
# The container: "exec" runs the command here, with the container's pretend
# files; "reboot" makes it see the share again (if this host has it).
cat > "$FAKE/pct" <<EOF
#!/bin/bash
case "\$1" in
  list)   printf 'VMID       Status     Lock         Name\n321        running                 dji-flightmap\n';;
  status) echo "status: running";;
  exec)   shift 3; exec "\$@";;
  reboot) echo reboot >> "$LOG/pct"
          if [ -e "$FLAGS/mounted-archive" ]; then
            echo cifs > "$FLAGS/ct-fs"; touch "$CT/logs/2026-01-01_10-00-00"
          fi;;
esac
EOF
chmod +x "$FAKE"/*
printf 'DATA_DIR=%s\nCACHE_FILE=%s\n' "$CT/logs" "$CT/state/summaries.json" > "$CT/env"
printf '//127.0.0.1/Central/DJI\\040Flight\\040logs/archive  %s  cifs  credentials=/x,ro  0  0\n' "$ARCHIVE" > "$WORK/fstab"

# What the container sees: its pretend mount list, built from $FLAGS/ct-fs.
ct_sees() {   # ct_sees cifs|ext4 [with-files]
  echo "$1" > "$FLAGS/ct-fs"
  rm -f "$CT/logs"/*
  [ "${2:-}" = with-files ] && touch "$CT/logs/2026-01-01_10-00-00"
  return 0
}
host_has_share() { touch "$FLAGS/mounted-archive" "$ARCHIVE/2026-01-01_10-00-00"; }
host_lost_share() { rm -f "$FLAGS/mounted-archive" "$ARCHIVE"/*; }
cat > "$WORK/mountinfo.sh" <<EOF
#!/bin/bash
printf '22 1 0:21 / / rw - ext4 /dev/sda1 rw\n99 22 0:50 / %s ro - %s //127.0.0.1/Central ro\n' "$CT/logs" "\$(cat "$FLAGS/ct-fs")"
EOF

watch() {   # run the helper once; its output goes to $LOG/out
  rm -f "$LOG/pct" "$LOG/mount" "$LOG/umount"
  bash "$WORK/mountinfo.sh" > "$WORK/mountinfo"
  PATH="$FAKE:$PATH" ARCHIVE="$ARCHIVE" BACKUPS="$WORK/mnt/backups" FSTAB="$WORK/fstab" \
    NAS_STATE_FILE="$WORK/state" NAS_PORT="$NAS_PORT" \
    NAS_VIEW_CONF="$CT/env" NAS_VIEW_MOUNTINFO="$WORK/mountinfo" \
    bash "$ROOT/deploy/nas-watch.sh" --verbose >"$LOG/out" 2>&1
}
report_has() { grep -qF -- "$1" "$CT/state/nas-host.json"; }
restarted() { grep -q reboot "$LOG/pct" 2>/dev/null; }
said() { grep -qF -- "$1" "$LOG/out"; }

echo "Everything connected"
nas_on; host_has_share; ct_sees cifs with-files
watch
check "nothing is changed" bash -c "! restarted && [ ! -e '$LOG/mount' ] && [ ! -e '$LOG/umount' ]"
check "the map is told: a share, connected" report_has '"share": true'
check "  ...on this server too" report_has '"hostConnected": true'
check "  ...with the NAS's address" report_has '"server": "127.0.0.1"'
check "  ...and no problem" report_has '"problem": ""'

echo "The NAS is restarting (doesn't answer)"
nas_off
watch
check "the connection is left alone (it comes back by itself)" bash -c "[ ! -e '$LOG/umount' ] && [ ! -e '$LOG/mount' ]"
check "the map is told the NAS doesn't answer" report_has "doesn't answer on the network"
check "the container isn't restarted" bash -c "! restarted"

echo "The server started while the NAS was off; now the NAS is back"
host_lost_share; ct_sees ext4
nas_on
watch
check "the share is connected again on this server" grep -q "$ARCHIVE" "$LOG/mount"
check "the container is restarted, so it sees the share" restarted
check "  ...and the map is told what was done" report_has "Restarted the map"
check "  ...and that the share was connected again" report_has "Connected the NAS share again"
check "the restart time is remembered" grep -q '^restarted=[1-9]' "$WORK/state"

echo "The container loses the share again 5 minutes later"
ct_sees ext4
watch
check "it isn't restarted again so soon (at most every 15 minutes)" bash -c "! restarted"
check "  ...and the map is told when it will be" report_has "restarts itself at"

echo "...but Reconnect now is pressed on the settings page"
ASKED=$(date +%s)
printf '{"at": %s}\n' "$ASKED" > "$CT/state/nas-request.json"
watch
check "it is restarted straight away" restarted
check "the request is marked as handled" report_has "\"handled\": $ASKED"
watch
check "a handled request isn't done twice" bash -c "! restarted"

echo "Reconnect now when everything is fine"
ct_sees cifs with-files
ASKED=$((ASKED + 1))
printf '{"at": %s}\n' "$ASKED" > "$CT/state/nas-request.json"
watch
check "nothing is restarted" bash -c "! restarted"
check "the map is told it was already connected" report_has "already connected"
check "  ...and the request is handled" report_has "\"handled\": $ASKED"

echo "A new install whose NAS folder has no flights yet"
host_lost_share; touch "$FLAGS/mounted-archive"; ct_sees cifs
printf 'restarted=0\nhandled=%s\n' "$ASKED" > "$WORK/state"
watch
check "an empty share is no reason to restart" bash -c "! restarted && [ ! -e '$LOG/mount' ]"

echo "The share can't be connected (e.g. a changed password)"
host_lost_share; ct_sees ext4
mv "$FAKE/mount" "$FAKE/mount.ok"
printf '#!/bin/bash\necho "mount error(13): Permission denied" >&2\nexit 32\n' > "$FAKE/mount"; chmod +x "$FAKE/mount"
watch
check "the map is told why" report_has "Permission denied"
check "the container isn't restarted for nothing" bash -c "! restarted"
mv "$FAKE/mount.ok" "$FAKE/mount"

echo "Logs in a folder on the server (no NAS share)"
: > "$WORK/fstab"
watch
check "the map is told it isn't a share" report_has '"share": false'
check "nothing is done" bash -c "! restarted && [ ! -e '$LOG/mount' ]"

echo "While an update is running"
printf '//127.0.0.1/Central/archive  %s  cifs  ro  0  0\n' "$ARCHIVE" > "$WORK/fstab"
rm -f "$CT/state/nas-host.json"
bash -c 'exec -a deploy/update-ct.sh sleep 10' & UPD=$!
sleep 0.3
watch
kill "$UPD" 2>/dev/null; wait "$UPD" 2>/dev/null
check "it waits for the next minute (does nothing)" bash -c "! restarted && [ ! -e '$CT/state/nas-host.json' ]"

nas_off
echo
echo "NAS helper: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
