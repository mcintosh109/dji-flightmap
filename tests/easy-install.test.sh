#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# easy-install.test.sh - tests for deploy/easy-install.sh (the one-command
# install). Everything happens in a temporary folder:
#   - a pretend GitHub copy of the project, with a release tag v9.0.0 and a
#     newer test version 9.1.0 on main
#   - fake Proxmox commands (pct, pvesm, pvesh) that only write down what
#     they were asked
#   - the real work scripts (create-ct.sh, update-ct.sh, ...) are replaced
#     by stubs that write down what they were given
# So it never touches this machine's system folders.
#
#   bash tests/easy-install.test.sh
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d /tmp/flightmap-easy-XXXXXX)
trap '[ -n "${KEEP:-}" ] && echo "kept $WORK" || rm -rf "$WORK"' EXIT
FAKE="$WORK/bin"; LOG="$WORK/log"; ORIGIN="$WORK/origin"
mkdir -p "$FAKE" "$LOG" "$WORK/logs" "$WORK/with space"
PASSED=0; FAILED=0
check() {   # check "name" command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS  $name"; PASSED=$((PASSED + 1))
  else echo "  FAIL  $name"; FAILED=$((FAILED + 1)); fi
}

# ---- fake Proxmox commands ---------------------------------------------------
cat > "$FAKE/pct" <<'EOF'
#!/bin/bash
case "$1" in
  list) printf 'VMID       Status     Lock         Name\n'; [ -z "${PCT_LIST:-}" ] || printf '%s\n' "$PCT_LIST";;
  exec) shift 3
        case "$1" in
          hostname) echo "192.168.1.50 fd00::1";;
          curl) echo '{"ok":true,"httpsPort":443}';;
        esac;;
esac
EOF
cat > "$FAKE/pvesm" <<'EOF'
#!/bin/bash
printf 'Name  Type  Status  Total  Used  Available  %%\n'
for s in ${STORAGES:-local-lvm}; do printf '%s lvmthin active 100 1 99 1%%\n' "$s"; done
EOF
printf '#!/bin/bash\necho 123\n' > "$FAKE/pvesh"
printf '#!/bin/bash\nexit 1\n' > "$FAKE/mountpoint"       # nothing is connected yet
printf '#!/bin/bash\nexit 0\n' > "$FAKE/apt-get"
chmod +x "$FAKE"/*

# ---- a pretend GitHub copy of the project ---------------------------------------
mkdir -p "$ORIGIN/app" "$ORIGIN/deploy"
stub() {   # stub <script>: write down its options and settings, then succeed
  cat > "$ORIGIN/deploy/$1" <<EOF
#!/bin/bash
echo "args=\$* CTID=\${CTID:-} STORAGE=\${STORAGE:-} DATA=\${DATA_HOST_PATH:-} EASY=\${FLIGHTMAP_EASY:-}" >> "$LOG/$1"
EOF
}
for s in create-ct.sh update-ct.sh setup-truenas-mount.sh setup-backup-share.sh; do stub "$s"; done
version() { printf '{\n  "version": "%s"\n}\n' "$1" > "$ORIGIN/app/version.json"; }
(
  cd "$ORIGIN" || exit 1
  git init -q -b main
  git config user.email user@example.com; git config user.name test
  version 9.0.0; git add -A; git commit -qm "9.0.0"; git tag v9.0.0
  version 9.1.0; git commit -qam "9.1.0 (a test version)"
) || { echo "could not make the pretend project"; exit 1; }

run() {   # run <install folder> <answers> [options]: the easy install, with its output in $LOG/out
  local dir=$1 answers=$2; shift 2
  rm -f "$LOG"/*.sh
  printf '%b' "$answers" | PATH="$FAKE:$PATH" FLIGHTMAP_REPO="$ORIGIN" FLIGHTMAP_DIR="$dir" \
    bash -c "$(cat "$ROOT/deploy/easy-install.sh")" easy-install "$@" >"$LOG/out" 2>&1
}   # (bash -c "$(...)" is how the README's one command runs it)
said() { grep -qF -- "$1" "$LOG/out"; }
got()  { grep -qF -- "$2" "$LOG/$1"; }
version_is() { grep -q "\"$2\"" "$1/app/version.json"; }

echo "A new install, logs in a folder on the server, the second storage"
STORAGES="local-lvm tank" run "$WORK/a" "2\n$WORK/logs\n2\n"
check "downloads the newest RELEASE (not the test version)" version_is "$WORK/a" 9.0.0
check "says it is the newest release" said "version 9.0.0 (the newest release)"
check "creates the container with the next free number" got create-ct.sh "CTID=123"
check "on the storage chosen" got create-ct.sh "STORAGE=tank"
check "sharing the chosen logs folder" got create-ct.sh "DATA=$WORK/logs"
check "prints the https address" said "Open it in your browser:  https://192.168.1.50"
check "explains the first-time browser warning" said "Your connection isn't private"
check "no TrueNAS backup question without a TrueNAS share" said "kept on this server"

echo "Enter picks local-lvm; wrong folders are refused"
STORAGES="tank local-lvm" run "$WORK/b" "2\n/no/such/folder\n2\n$WORK/with space\n2\n$WORK/logs\n\n"
check "a missing folder is refused" said "There's no folder /no/such/folder"
check "a folder with a space is refused" said "spaces or commas"
check "then the right one is used" got create-ct.sh "DATA=$WORK/logs"
check "Enter picks local-lvm" got create-ct.sh "STORAGE=local-lvm"

echo "Logs on TrueNAS, and only one storage"
run "$WORK/c" "1\n"
check "connects the TrueNAS share (without its 'next step' hint)" got setup-truenas-mount.sh "EASY=1"
check "shares the TrueNAS folder" got create-ct.sh "DATA=/mnt/dji-archive"
check "doesn't ask about storage when there is only one" got create-ct.sh "STORAGE=local-lvm"

echo "Already installed: update instead (test version)"
PCT_LIST="321        running                 dji-flightmap" run "$WORK/a" "\n" --test
check "the download is moved to the test version" version_is "$WORK/a" 9.1.0
check "says it is a test version" said "a TEST version"
check "runs the update, as a test, for that container" got update-ct.sh "args=--test CTID=321"
check "doesn't make a second container" test ! -e "$LOG/create-ct.sh"

echo "Already installed, and the answer is no"
PCT_LIST="321        running                 dji-flightmap" run "$WORK/a" "n\n"
check "changes nothing" said "Nothing changed"
check "doesn't update" test ! -e "$LOG/update-ct.sh"

echo "Run in the wrong place"
printf '' | PATH="/usr/bin:/bin" FLIGHTMAP_REPO="$ORIGIN" FLIGHTMAP_DIR="$WORK/d" \
  bash "$ROOT/deploy/easy-install.sh" >"$LOG/out" 2>&1
check "outside Proxmox it explains where to paste it" said "isn't a Proxmox server's own Shell"
check "and downloads nothing" test ! -e "$WORK/d"
mkdir -p "$WORK/e"; touch "$WORK/e/something"
run "$WORK/e" "\n"
check "a folder that isn't this project is left alone" said "isn't a download of this project"
check "its file is still there" test -e "$WORK/e/something"

echo
echo "Easy install: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
