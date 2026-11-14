#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.test.sh - tests for deploy/update-ct.sh and deploy/restore-ct.sh.
#
# It pretends THIS machine is the container: a fake "pct" command runs
# everything locally, and a fake "systemctl" starts the server by hand.
#
# !! It writes to /opt/dji-flightmap, /etc/default/dji-flightmap,
# !! /var/lib/dji-flightmap and /root, and creates a "flightmap" user.
# !! Only run it on a throw-away machine (like Claude's cloud sandbox),
# !! never on your Proxmox server or inside the real container.
#
#   FLIGHTMAP_ALLOW_SYSTEM_TEST=1 bash tests/deploy.test.sh
# ---------------------------------------------------------------------------
set -uo pipefail

if [[ "${FLIGHTMAP_ALLOW_SYSTEM_TEST:-}" != 1 ]]; then
  echo "  SKIP  deploy tests (they change system folders; set FLIGHTMAP_ALLOW_SYSTEM_TEST=1 on a throw-away machine)"
  exit 0
fi
if command -v pveversion >/dev/null 2>&1 || [[ -e /opt/dji-flightmap/.real-install ]]; then
  echo "Refusing: this looks like a real Proxmox host or a real install." >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "  SKIP  deploy tests (need root)"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d /tmp/flightmap-deploy-XXXXXX)
FAKE="$WORK/bin"
LOGS="$WORK/logs"
mkdir -p "$FAKE" "$LOGS"
PORT=18080
PASSED=0; FAILED=0
check() {   # check "name" command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS  $name"; PASSED=$((PASSED + 1))
  else echo "  FAIL  $name"; FAILED=$((FAILED + 1)); fi
}

# ---- fake Proxmox + systemd commands ---------------------------------------
cat > "$FAKE/pct" <<'EOF'
#!/bin/bash
cmd=$1; shift
case "$cmd" in
  list)   printf 'VMID       Status     Lock         Name\n999        running                 dji-flightmap\n';;
  status) [ "$1" = 999 ] && echo "status: running" || exit 2;;
  start)  ;;
  exec)   shift 2; exec "$@";;
  pull)   cp "$2" "$3";;
  push)   src=$2; dst=$3; shift 3; cp "$src" "$dst"
          while [ $# -gt 0 ]; do case "$1" in --perms) chmod "$2" "$dst";; --user) chown "$2" "$dst";; --group) chgrp "$2" "$dst";; esac; shift 2; done;;
esac
EOF
cat > "$FAKE/systemctl" <<EOF
#!/bin/bash
PIDF=$LOGS/pid
case "\$1" in
  restart|start)
    [ -f \$PIDF ] && kill \$(cat \$PIDF) 2>/dev/null; sleep 0.5
    ( set -a; . /etc/default/dji-flightmap; set +a
      PYTHONDONTWRITEBYTECODE=1 setsid python3 -u /opt/dji-flightmap/app/server.py >>$LOGS/service.log 2>&1 & echo \$! > \$PIDF )
    sleep 1;;
  is-active) [ -f \$PIDF ] && kill -0 \$(cat \$PIDF) 2>/dev/null;;
  *) exit 0;;
esac
EOF
printf '#!/bin/bash\ntail -n 25 %s/service.log\n' "$LOGS" > "$FAKE/journalctl"
printf '#!/bin/bash\nexit 0\n' > "$FAKE/apt-get"
chmod +x "$FAKE"/*
export PATH="$FAKE:$PATH"

cleanup() {
  [ -f "$LOGS/pid" ] && kill "$(cat "$LOGS/pid")" 2>/dev/null
  rm -rf /opt/dji-flightmap /etc/default/dji-flightmap /var/lib/dji-flightmap \
         /etc/systemd/system/dji-flightmap.service /root/dji-flightmap-backups \
         /root/dji-flightmap /root/dji-flightmap.tar.gz /root/dji-flightmap-previous.tar.gz "$WORK"
  userdel flightmap 2>/dev/null || true
}
trap cleanup EXIT
cleanup_start() { rm -rf /opt/dji-flightmap /etc/default/dji-flightmap /var/lib/dji-flightmap /root/dji-flightmap-backups; }
cleanup_start
mkdir -p /etc/systemd/system

# ---- a first install, like create-ct.sh does --------------------------------
python3 "$ROOT/tests/fixtures.py" "$WORK/archive" >/dev/null
bash "$ROOT/deploy/install.sh" >"$LOGS/install.log" 2>&1
sed -i "s#^DATA_DIR=.*#DATA_DIR=$WORK/archive#; s#^PORT=.*#PORT=$PORT#" /etc/default/dji-flightmap
HASH=$(printf 'testpass123\ntestpass123\n' | PYTHONDONTWRITEBYTECODE=1 python3 /opt/dji-flightmap/app/server.py --hash-password 2>/dev/null)
printf 'AUTH_USER=tester\nAUTH_PASSWORD_HASH=%s\n' "$HASH" >> /etc/default/dji-flightmap
mkdir -p /var/lib/dji-flightmap && chown flightmap: /var/lib/dji-flightmap
systemctl restart dji-flightmap
JAR="$WORK/cookies"
curl -s -c "$JAR" -o /dev/null -d "username=tester&password=testpass123" "http://127.0.0.1:$PORT/api/login"
curl -s -b "$JAR" -X PUT -H X-Requested-With:flightmap -H Content-Type:application/json \
  -d '{"aircraftNames":{"TEST0000SERIAL01":"Scout"},"azureMapsKey":"KEY123","mapProvider":"azure"}' \
  -o /dev/null "http://127.0.0.1:$PORT/api/settings"

curl -s -b "$JAR" -X PUT -H X-Requested-With:flightmap -H Content-Type:application/json \
  -d '{"name":"Backup test plan","home":{"lat":40.78,"lon":-73.96},"waypoints":[]}' \
  -o /dev/null "http://127.0.0.1:$PORT/api/plans/new"

nickname_kept() { grep -q '"Scout"' /var/lib/dji-flightmap/settings.json; }
plan_kept()     { grep -q 'Backup test plan' /var/lib/dji-flightmap/plans.json; }
login_kept()    { grep -q '^AUTH_USER=tester' /etc/default/dji-flightmap; }
still_signed_in() { [ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/flights")" = 200 ]; }
map_answers()   { curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; }

check "first install works" map_answers
check "settings saved before updating" nickname_kept

echo "Normal update"
CTID=999 bash "$ROOT/deploy/update-ct.sh" --no-pull >"$LOGS/a.log" 2>&1
check "update finishes" grep -q "Update finished" "$LOGS/a.log"
check "nickname and key kept" nickname_kept
check "saved flight plan kept" plan_kept
check "login kept" login_kept
check "still signed in" still_signed_in
check "backup made on the host" ls /root/dji-flightmap-backups/ct999_*/settings.json
check "flight plans are in the backup" ls /root/dji-flightmap-backups/ct999_*/plans.json

echo "Update whose installer wipes the settings"
cp -r "$ROOT" "$WORK/repo-wipe"
sed -i 's#^echo "==> Installing and starting the service"#rm -f /var/lib/dji-flightmap/settings.json /var/lib/dji-flightmap/plans.json\necho "==> Installing and starting the service"#' "$WORK/repo-wipe/deploy/install.sh"
CTID=999 bash "$WORK/repo-wipe/deploy/update-ct.sh" --no-pull >"$LOGS/b.log" 2>&1
check "settings put back" grep -q "settings.json put back" "$LOGS/b.log"
check "nickname back" nickname_kept
check "flight plans back" plan_kept

echo "Broken new version"
cp -r "$ROOT" "$WORK/repo-broken"
sed -i 's/^APP_VERSION = .*/&\nraise SystemExit("simulated bug")/' "$WORK/repo-broken/app/server.py"
CTID=999 bash "$WORK/repo-broken/deploy/update-ct.sh" --no-pull >"$LOGS/c.log" 2>&1
check "update reports failure" grep -q "Undoing the update" "$LOGS/c.log"
check "old version back and working" grep -q "previous version is back and working" "$LOGS/c.log"
check "map answers after undo" map_answers
check "settings unchanged after undo" nickname_kept

echo "Restore into a rebuilt container"
rm -f /var/lib/dji-flightmap/settings.json
echo y | CTID=999 bash "$ROOT/deploy/restore-ct.sh" >"$LOGS/d.log" 2>&1
check "restore works" grep -q "Done. The map is working" "$LOGS/d.log"
check "nickname restored" nickname_kept

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
