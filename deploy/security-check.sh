#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# security-check.sh - tries the usual attacks on YOUR running map and says,
# for each one, whether the map stops it. Run it on the Proxmox host:
#
#   bash /root/dji-flightmap/deploy/security-check.sh
#
# It never needs your password: it only uses wrong passwords, fake login
# cookies and broken requests, and checks that each one is refused.
#
# Afterwards, the Proxmox server's own address is LOCKED OUT of the login
# for 15 minutes (that is one of the checks). Your PC is not affected.
#
# Other ways to run it:
#   CTID=111 bash security-check.sh            pick the container by number
#   MAP_URL=https://192.168.1.50 bash security-check.sh   check this address
# ---------------------------------------------------------------------------
set -uo pipefail
HTTP_PORT=${HTTP_PORT:-8080}   # the map's plain http port (8080 unless you changed it)

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  ✅ $*"; PASS=$((PASS + 1)); }
bad()  { echo "  ❌ $*"; FAIL=$((FAIL + 1)); }
skip() { echo "  ⏭  $*"; SKIP=$((SKIP + 1)); }
title() { echo; echo "== $* =="; }

for tool in curl openssl timeout; do
  if ! command -v "$tool" >/dev/null; then
    echo "This check needs '$tool'. Install it with: apt install $tool" >&2
    exit 1
  fi
done

# ---- where is the map? -------------------------------------------------------
if [[ -z "${MAP_URL:-}" ]]; then
  if ! command -v pct >/dev/null; then
    echo "Run this on the Proxmox host, or give the address: MAP_URL=https://<map address> bash $0" >&2
    exit 1
  fi
  if [[ -z "${CTID:-}" ]]; then
    CTID=$(pct list | awk 'NR>1 && $NF=="dji-flightmap" {print $1}')
    if [[ -z "$CTID" || "$CTID" == *[[:space:]]* ]]; then
      echo "Please tell me which container to check, e.g.:  CTID=111 bash $0" >&2
      exit 1
    fi
  fi
  IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
  # The plain http port (8080) tells whether HTTPS is on, and on which port.
  HEALTH=$(curl -s --max-time 5 "http://$IP:$HTTP_PORT/api/health" || true)
  HTTPS_PORT=$(sed -n 's/.*"httpsPort": *\([0-9]*\).*/\1/p' <<<"$HEALTH")
  if [[ -n "$HTTPS_PORT" ]]; then
    MAP_URL="https://$IP"
    [[ "$HTTPS_PORT" == 443 ]] || MAP_URL="https://$IP:$HTTPS_PORT"
  else
    MAP_URL="http://$IP:$HTTP_PORT"
  fi
fi
MAP_URL=${MAP_URL%/}
SCHEME=${MAP_URL%%://*}
HOSTPORT=${MAP_URL#*://}
HOST=${HOSTPORT%%:*}
if [[ "$HOSTPORT" == *:* ]]; then PORT=${HOSTPORT##*:}; elif [[ "$SCHEME" == https ]]; then PORT=443; else PORT=80; fi

echo "Checking the map at $MAP_URL"
echo "(HTTPS with your private certificate is accepted here: this checks the map, not your browser's trust.)"

# curl, accepting the map's private certificate.
c() { curl -sk --max-time 30 "$@"; }

# Send a hand-made request (for broken requests curl refuses to make) and
# print the first line of the answer, e.g. "HTTP/1.1 400 Bad Request".
raw() {
  if [[ "$SCHEME" == https ]]; then
    printf '%b' "$1" | timeout 10 openssl s_client -quiet -connect "$HOST:$PORT" 2>/dev/null | head -1 | tr -d '\r'
  else
    timeout 10 bash -c 'exec 3<>"/dev/tcp/$1/$2"; printf "%b" "$3" >&3; head -1 <&3' _ "$HOST" "$PORT" "$1" | tr -d '\r'
  fi
}

# ---- 1. is the login on? ---------------------------------------------------------
title "1. Login"
LOGIN_ON=0
code=$(c -o /dev/null -w '%{http_code}' -X POST --data 'username=&password=' "$MAP_URL/api/login")
if [[ "$code" == 404 ]]; then
  skip "The login page is OFF: anyone on your network can open the map. (Turn it on with set-login.sh.) Login checks skipped."
else
  LOGIN_ON=1
  ok "The login page is on."
fi
USED=1   # wrong logins sent so far (they count towards the lock-out)

if [[ $LOGIN_ON == 1 ]]; then
  # Every page and data address needs a login.
  for path in / /index.html /settings.html /app.js /api/flights /api/settings /api/plans /api/nas /api/rc2; do
    code=$(c -o /dev/null -w '%{http_code}' "$MAP_URL$path")
    if [[ "$code" == 401 || "$code" == 303 ]]; then
      ok "$path needs a login (answer $code)."
    else
      bad "$path answered $code without a login: it should be 401 or 303."
    fi
  done
  code=$(c -o /dev/null -w '%{http_code}' "$MAP_URL/login.html")
  [[ "$code" == 200 ]] && ok "The login page itself opens (200)." || bad "The login page answered $code."

  # A made-up login cookie (a signature the map didn't make).
  code=$(c -o /dev/null -w '%{http_code}' -b 'flightmap_session=admin:9999999999:0000000000000000000000000000000000000000000000000000000000000000' "$MAP_URL/api/flights")
  [[ "$code" == 401 ]] && ok "A made-up login cookie is refused (401)." || bad "A made-up login cookie got answer $code: it should be 401."

  # The cookie's protections, as set by "Sign out".
  cookie=$(c -D - -o /dev/null "$MAP_URL/logout" | tr -d '\r' | grep -i '^set-cookie:')
  for flag in HttpOnly SameSite=Lax; do
    [[ "$cookie" == *"$flag"* ]] && ok "The login cookie is marked $flag." || bad "The login cookie is not marked $flag."
  done
  if [[ "$SCHEME" == https ]]; then
    [[ "$cookie" == *"Secure"* ]] && ok "The login cookie is marked Secure (only sent over HTTPS)." || bad "The login cookie is not marked Secure."
  fi
fi

# ---- 2. the RC 2 dock key -----------------------------------------------------------
title "2. The RC 2 dock's key"
code=$(c -o /dev/null -w '%{http_code}' "$MAP_URL/api/dock/queue")
[[ "$code" == 401 ]] && ok "The dock's addresses need the dock key (401)." \
  || bad "The dock's address answered $code without a key: it should be 401."
code=$(c -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer dock_made-up-key' "$MAP_URL/api/dock/queue")
[[ "$code" == 401 ]] && ok "A made-up dock key is refused (401)." \
  || bad "A made-up dock key got answer $code: it should be 401."
USED=$((USED + 2))   # wrong dock keys count towards the lock-out too

# ---- 3. sneaky requests (before the guessing: once locked out, the login answers "locked" at once) -------------------------------------------------------------
title "3. Sneaky requests"
for path in '/../../etc/passwd' '/%2e%2e/%2e%2e/etc/passwd' '/static/..%2f..%2f..%2fetc%2fpasswd'; do
  body=$(c --path-as-is "$MAP_URL$path")
  [[ "$body" != *"root:"* ]] && ok "Can't read the server's files with $path" || bad "$path showed a server file!"
done

# A request that claims a negative size used to keep the server waiting for a minute.
if [[ $LOGIN_ON == 1 ]]; then
  req="POST /api/login HTTP/1.1\r\nHost: $HOST\r\nContent-Length: -1\r\nConnection: close\r\n\r\n"
else
  req="PUT /api/settings HTTP/1.1\r\nHost: $HOST\r\nX-Requested-With: flightmap\r\nContent-Length: -1\r\nConnection: close\r\n\r\n"
fi
start=$(date +%s)
first=$(raw "$req")
took=$(( $(date +%s) - start ))
if [[ "$first" == *" 400 "* ]]; then
  ok "A request with a broken size is refused at once ($took s)."
else
  bad "A request with a broken size got '${first:-no answer within 10 s}' (it should be refused at once with 400)."
fi

# Changes need the page's own header, so another website can't make them.
if [[ $LOGIN_ON == 0 ]]; then
  code=$(c -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' --data '{}' "$MAP_URL/api/settings")
  [[ "$code" == 403 ]] && ok "Settings can't be changed by another website (403)." || bad "A change without the page's header got $code: it should be 403."
fi

# ---- 4. guessing passwords --------------------------------------------------------
title "4. Guessing passwords"
if [[ $LOGIN_ON == 1 ]]; then
  start=$(date +%s.%N)
  where=$(c -o /dev/null -w '%{redirect_url}' -X POST --data 'username=security-check&password=wrong-0' "$MAP_URL/api/login")
  took=$(awk -v a="$start" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }')
  USED=$((USED + 1))
  if [[ "$where" == *error=locked* ]]; then
    skip "This computer is still locked out from an earlier run (that's the lock-out working). Wait 15 minutes to run the guessing checks again."
  else
    [[ "$where" == *error=1* ]] && ok "A wrong password is refused." || bad "A wrong password got: '$where'."
    if awk -v t="$took" 'BEGIN { exit !(t >= 0.9) }'; then
      ok "A wrong password takes about a second to answer (slows guessing down)."
    else
      bad "A wrong password was answered in $took s: it should take about 1 s."
    fi

    # 30 guesses sent at the same moment: at most 10 (minus the ones above)
    # may be checked; the rest must be told "locked", with no broken connections.
    tmp=$(mktemp -d)
    for i in $(seq 1 30); do
      ( c -o /dev/null -w '%{redirect_url}' -X POST --data "username=security-check&password=wrong-$i" \
          "$MAP_URL/api/login" > "$tmp/$i"; echo " exit=$?" >> "$tmp/$i" ) &
    done
    wait
    checked=$(grep -l 'error=1' "$tmp"/* | wc -l)
    locked=$(grep -l 'error=locked' "$tmp"/* | wc -l)
    broken=$(grep -L 'exit=0' "$tmp"/* | wc -l)
    rm -rf "$tmp"
    allowed=$((10 - USED))
    (( allowed < 0 )) && allowed=0
    if (( checked <= allowed )); then
      ok "30 guesses sent at once: only $checked were checked (allowed: $allowed), $locked were locked out."
    else
      bad "30 guesses sent at once: $checked were checked, but only $allowed should have been (the 10-tries limit)."
    fi
    (( broken == 0 )) && ok "Every guess got a proper answer (no broken connections)." \
      || bad "$broken guesses got a broken connection instead of the \"too many attempts\" message."
    where=$(c -o /dev/null -w '%{redirect_url}' -X POST --data 'username=security-check&password=wrong-again' "$MAP_URL/api/login")
    [[ "$where" == *error=locked* ]] && ok "After that, this computer is locked out for 15 minutes." \
      || bad "After 30 wrong guesses, another guess got: '$where' (it should be locked out)."
  fi
else
  skip "No login, nothing to guess."
fi

# ---- 5. the connection ---------------------------------------------------------------
title "5. The connection"
headers=$(c -D - -o /dev/null "$MAP_URL/login.html" | tr -d '\r')
grep -qi '^x-frame-options: *deny' <<<"$headers" && ok "Other websites can't show the map inside theirs (X-Frame-Options)." \
  || bad "X-Frame-Options: DENY is missing."
grep -qi '^x-content-type-options: *nosniff' <<<"$headers" && ok "Browsers won't guess file types (X-Content-Type-Options)." \
  || bad "X-Content-Type-Options: nosniff is missing."
if [[ "$SCHEME" == https ]]; then
  where=$(curl -s --max-time 5 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$HOST:$HTTP_PORT/")
  [[ "$where" == 301\ https://* ]] && ok "The plain http address sends you to HTTPS." || bad "The plain http address answered: '$where'."
  if echo | timeout 10 openssl s_client -connect "$HOST:$PORT" -tls1_1 -cipher 'DEFAULT:@SECLEVEL=0' >/dev/null 2>&1; then
    bad "The map still accepts the old TLS 1.1."
  else
    ok "The old TLS 1.0/1.1 is refused (1.2 or newer only)."
  fi
else
  skip "HTTPS is off: passwords and cookies cross your network unencrypted. (Turn it on in Settings → Secure connection.)"
fi

# ---- summary -------------------------------------------------------------------------
echo
echo "== Result: $PASS passed, $FAIL failed, $SKIP skipped =="
if [[ $LOGIN_ON == 1 ]]; then
  echo "Note: this Proxmox server's address is now locked out of the login for 15 minutes."
  echo "      Your PC is not affected."
fi
(( FAIL == 0 ))
