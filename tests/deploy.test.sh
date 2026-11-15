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
sed -i '1a raise SystemExit("simulated bug")' "$WORK/repo-broken/app/server.py"   # crash on start
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

echo "Backups on TrueNAS (a plain folder stands in for the TrueNAS share)"
OFF="$WORK/truenas-backups"
mkdir -p "$OFF"
OFFSITE_DIR="$OFF" OFFSITE_NO_MOUNT_CHECK=1 CTID=999 bash "$ROOT/deploy/update-ct.sh" --no-pull >"$LOGS/e.log" 2>&1
check "update copies the backup to TrueNAS" ls "$OFF"/ct999_*/settings.json
check "the TrueNAS copy has the flight plans" ls "$OFF"/ct999_*/plans.json
OFFSITE_DIR="$OFF" OFFSITE_NO_MOUNT_CHECK=1 CTID=999 bash "$ROOT/deploy/backup-ct.sh" >"$LOGS/f.log" 2>&1
check "backup-ct.sh (the daily backup) works" grep -q "copied to TrueNAS" "$LOGS/f.log"
# TrueNAS not connected: the folder exists but isn't a mount -> must NOT write into it
mkdir -p "$WORK/not-mounted"
OFFSITE_DIR="$WORK/not-mounted" CTID=999 bash "$ROOT/deploy/backup-ct.sh" >"$LOGS/g.log" 2>&1
check "TrueNAS not connected: warns" grep -q "isn't connected" "$LOGS/g.log"
check "TrueNAS not connected: nothing written to the empty folder" bash -c "[ -z \"\$(ls -A '$WORK/not-mounted')\" ]"
cp /var/lib/dji-flightmap/plans.json "$WORK/plans-before.json"
rm -rf /root/dji-flightmap-backups /var/lib/dji-flightmap/plans.json   # server disk "lost"
echo y | OFFSITE_DIR="$OFF" OFFSITE_NO_MOUNT_CHECK=1 CTID=999 bash "$ROOT/deploy/restore-ct.sh" >"$LOGS/h.log" 2>&1
check "restore from TrueNAS when this server's backups are gone" grep -q "Done. The map is working" "$LOGS/h.log"
check "flight plans restored from TrueNAS" cmp -s "$WORK/plans-before.json" /var/lib/dji-flightmap/plans.json

echo "Released versions (a local git repository stands in for GitHub)"
SEED="$WORK/seed"
cp -r "$ROOT" "$SEED" && rm -rf "$SEED/.git"
gitc() { git -C "$SEED" -c user.name=Test -c user.email=user@example.com "$@"; }
setver() { sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$1\"/" "$SEED/app/version.json"; gitc add -A; gitc commit -q -m "version $1"; }
installed() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/dji-flightmap/app/version.json | head -1; }
git init -q -b main "$SEED"
setver 9.0.0; gitc tag v9.0.0          # released
setver 9.1.0                           # newer work, not released yet
git clone -q --bare "$SEED" "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/host"
HOSTUP="$WORK/host/deploy/update-ct.sh"

CTID=999 bash "$HOSTUP" >"$LOGS/r1.log" 2>&1
check "normal update installs the newest RELEASE (9.0.0), not the test version" [ "$(installed)" = 9.0.0 ]
CTID=999 bash "$HOSTUP" --test >"$LOGS/r2.log" 2>&1
check "--test installs the unreleased version (9.1.0)" [ "$(installed)" = 9.1.0 ]
check "--test says it is not released" grep -q "NOT been released" "$LOGS/r2.log"
check "settings survive switching versions" nickname_kept

gitc tag v9.1.0; setver 9.2.0          # 9.1.0 is now released; 9.2.0 is new test work
gitc push -q "$WORK/origin.git" main --tags
CTID=999 bash "$HOSTUP" >"$LOGS/r3.log" 2>&1
check "after a release, a normal update installs it (9.1.0)" [ "$(installed)" = 9.1.0 ]
CTID=999 bash "$HOSTUP" --version 9.0.0 >"$LOGS/r4.log" 2>&1
check "--version goes back to an older release (9.0.0)" [ "$(installed)" = 9.0.0 ]
check "going back keeps the newest update scripts on the host" [ "$(git -C "$WORK/host" describe --tags)" = v9.1.0 ]
CTID=999 bash "$HOSTUP" >"$LOGS/r5.log" 2>&1
check "a normal update still works after going back (9.1.0)" [ "$(installed)" = 9.1.0 ]
CTID=999 bash "$HOSTUP" --version 7.7.7 >"$LOGS/r6.log" 2>&1; code=$?
check "an unknown version is refused, with the list of releases" bash -c "[ $code -ne 0 ] && grep -q 'no released version' '$LOGS/r6.log' && grep -q '9.1.0' '$LOGS/r6.log'"
check "  ...and nothing was changed" [ "$(installed)" = 9.1.0 ]

echo "HTTPS (set-https.sh)"
HP=18443
TLS=/var/lib/dji-flightmap/tls
set_https() { IP=127.0.0.1 HTTPS_PORT=$HP bash /opt/dji-flightmap/deploy/set-https.sh "$@"; }
ca_fingerprint() { openssl x509 -in $TLS/ca.crt -noout -fingerprint -sha256; }
https_answers() { curl -sf --cacert $TLS/ca.crt "https://127.0.0.1:$HP/api/health" >/dev/null; }
set_https --private --name flightmap.test >"$LOGS/s1.log" 2>&1
check "private certificate: the map answers on https" https_answers
check "  ...and the http address sends you there" bash -c "curl -s -o /dev/null -w '%{redirect_url}' http://127.0.0.1:$PORT/settings.html | grep -q '^https://127.0.0.1:$HP/settings.html'"
check "  ...and says how to trust it on Windows" grep -q "Trusted Root Certification Authorities" "$LOGS/s1.log"
check "the authority's key is readable by root only" [ "$(stat -c '%U %a' $TLS/ca.key)" = "root 600" ]
check "the map's key belongs to the map's user only" [ "$(stat -c '%U %a' $TLS/key.pem)" = "flightmap 600" ]
check "the authority only covers this map's address and name" bash -c "openssl x509 -in $TLS/ca.crt -noout -ext nameConstraints | grep -q 'DNS:flightmap.test'"
FP=$(ca_fingerprint)
set_https --renew >"$LOGS/s2.log" 2>&1
check "renewing keeps the same authority (nothing to import again)" [ "$FP" = "$(ca_fingerprint)" ]
check "  ...and the map still answers on https" https_answers
CTID=999 bash "$HOSTUP" --no-pull >"$LOGS/s3.log" 2>&1
check "an update keeps HTTPS on, with the same authority" bash -c "https_answers() { curl -sf --cacert $TLS/ca.crt https://127.0.0.1:$HP/api/health; }; https_answers && [ '$FP' = \"\$(openssl x509 -in $TLS/ca.crt -noout -fingerprint -sha256)\" ]"
check "  ...and its backup holds the certificate files" bash -c "ls /root/dji-flightmap-backups/ct999_*/tls-ca.key"
check "  ...and it shows the https address" grep -q "map is working: https://" "$LOGS/s3.log"
set_https --private --name other.test >"$LOGS/s4.log" 2>&1
check "a new name makes a new authority, and says to import again" bash -c "[ '$FP' != \"\$(openssl x509 -in $TLS/ca.crt -noout -fingerprint -sha256)\" ] && grep -q 'import it again' '$LOGS/s4.log'"

# Let's Encrypt, with a pretend acme.sh that records what it was asked.
cp $TLS/cert.pem "$WORK/le-cert.pem"; cp $TLS/key.pem "$WORK/le-key.pem"
cat > "$WORK/acme.sh" <<EOF
#!/bin/bash
echo "\$*" >> "$LOGS/acme.args"
echo "token:\${CF_Token:+given}" >> "$LOGS/acme.args"
while [ \$# -gt 0 ]; do
  case "\$1" in --key-file) cp "$WORK/le-key.pem" "\$2";; --fullchain-file) cp "$WORK/le-cert.pem" "\$2";; esac
  shift
done
EOF
chmod +x "$WORK/acme.sh"
CF_Token=SECRET-CF-TOKEN ACME_SH="$WORK/acme.sh" set_https --letsencrypt --name map.example.com --dns dns_cf >"$LOGS/s5.log" 2>&1
check "Let's Encrypt: acme.sh is told to use Let's Encrypt" grep -q -- "--set-default-ca --server letsencrypt" "$LOGS/acme.args"
check "  ...asks for the name through the DNS company" grep -q -- "--issue --dns dns_cf -d map.example.com --keylength ec-256" "$LOGS/acme.args"
check "  ...gets the API token, but never on its command line" bash -c "grep -q 'token:given' '$LOGS/acme.args' && ! grep -q SECRET-CF-TOKEN '$LOGS/acme.args'"
check "  ...installs the certificate where the map reads it, with a reload" grep -q -- "--install-cert -d map.example.com --ecc --key-file $TLS/key.pem" "$LOGS/acme.args"
check "  ...and the map answers on https" grep -q '^TLS_MODE=letsencrypt' /etc/default/dji-flightmap
set_https --off >"$LOGS/s6.log" 2>&1
check "--off: plain http again" bash -c "! grep -q '^TLS_' /etc/default/dji-flightmap && curl -sf http://127.0.0.1:$PORT/api/flights -o /dev/null -b '$JAR'"

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
