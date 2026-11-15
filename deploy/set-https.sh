#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# set-https.sh - run INSIDE the container (as root) to turn HTTPS on or off.
# HTTPS = the padlock in the browser: everything between your browser and
# the map, including your login, is encrypted (research: "TLS certificate").
#
#   bash /opt/dji-flightmap/deploy/set-https.sh        # asks what you want
#
# From the Proxmox host, without entering the container:
#   pct exec <CTID> -- bash /opt/dji-flightmap/deploy/set-https.sh
#
# Two kinds of certificate:
#   1. PRIVATE: made right here, no domain needed. Each device imports the
#      map's certificate once, then trusts it.
#   2. LET'S ENCRYPT: a free, publicly trusted certificate for a domain you
#      own (or a free DuckDNS name). Renews itself. Uses the acme.sh tool and
#      your DNS company's API key (research: "acme.sh dns api").
#
# Options (instead of the questions):
#   --private [--name NAME]           private certificate
#   --letsencrypt --name NAME --dns dns_cf|dns_duckdns|dns_gd|dns_...
#   --renew                           a fresh certificate (same kind and name)
#   --off                             back to plain http (files are kept)
# ---------------------------------------------------------------------------
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8

CONF=${CONF:-/etc/default/dji-flightmap}
TLS_DIR=${TLS_DIR:-/var/lib/dji-flightmap/tls}
OWNER=${OWNER:-flightmap}                 # the user the map runs as
RESTART_CMD=${RESTART_CMD:-systemctl restart dji-flightmap}
HTTPS_PORT=${HTTPS_PORT:-443}
ACME_VERSION=3.1.1                        # the acme.sh release that is downloaded
ACME_HOME=${ACME_HOME:-/root/.acme.sh}
ACME_SH=${ACME_SH:-$ACME_HOME/acme.sh}
SERVER_DAYS=825                           # longest a browser accepts (about 2 years 3 months)
NAME_RE='^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'

if [[ $EUID -ne 0 && "${ALLOW_NON_ROOT:-}" != 1 ]]; then
  echo "Please run as root (inside the container)." >&2
  exit 1
fi

MODE="" NAME="" DNS_API="" ASKED=no
while [[ $# -gt 0 ]]; do
  case "$1" in
    --private) MODE=private ;;
    --letsencrypt) MODE=letsencrypt ;;
    --renew) MODE=renew ;;
    --off) MODE=off ;;
    --name) NAME="${2:-}"; shift ;;
    --dns) DNS_API="${2:-}"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see: bash $0 --help)" >&2; exit 1 ;;
  esac
  shift
done

this_ip() { echo "${IP:-$(hostname -I | awk '{print $1}')}"; }

conf_value() { sed -n "s/^$1=//p" "$CONF" 2>/dev/null | tail -1; }

# Write (or remove) the HTTPS lines in the map's settings file.
set_conf() {
  sed -i '/^TLS_MODE=/d;/^TLS_CERT=/d;/^TLS_KEY=/d;/^HTTPS_PORT=/d;/^TLS_NAME=/d' "$CONF"
  if [[ "$1" != off ]]; then
    {
      echo "TLS_MODE=$1"
      echo "TLS_NAME=$2"
      echo "TLS_CERT=$TLS_DIR/cert.pem"
      echo "TLS_KEY=$TLS_DIR/key.pem"
      echo "HTTPS_PORT=$HTTPS_PORT"
    } >> "$CONF"
  fi
  chmod 600 "$CONF"
}

ask_name() {   # $1 = the question; empty answer allowed when $2 = optional
  while true; do
    read -rp "$1" NAME
    NAME=${NAME,,}
    [[ -z "$NAME" && "${2:-}" == optional ]] && return
    [[ "$NAME" =~ $NAME_RE && "$NAME" == *.* ]] && return
    echo "That doesn't look like a name. Use letters, numbers, dashes and dots, e.g. flightmap.home"
  done
}

# ---- 1. private certificate --------------------------------------------------
private_cert() {
  local name=$1 ip names new_ca=no
  ip=$(this_ip)
  if [[ ! "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "Could not find this container's IPv4 address (got '$ip')." >&2
    exit 1
  fi
  names="IP:$ip${name:+,DNS:$name}"
  mkdir -p "$TLS_DIR"
  chmod 755 "$TLS_DIR"
  cd "$TLS_DIR"

  # The "certificate authority" (CA): what each device imports and trusts.
  # It is limited to this map's address and name ("name constraints"), so
  # even if its key were stolen it could not fake other websites. Kept for
  # 10 years and reused when the address and name stay the same, so
  # renewing doesn't mean importing again.
  if [[ ! -f ca.key || ! -f ca.crt || "$(cat ca-names.txt 2>/dev/null)" != "$names" ]]; then
    [[ -f ca.crt ]] && new_ca=again || new_ca=yes
    echo "==> Making the map's private certificate authority (for $names)"
    openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
      -keyout ca.key.new -out ca.crt.new -days 3650 -sha256 \
      -subj "/CN=DJI Flight Map private certificate ($ip)" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "nameConstraints=critical,permitted;IP:$ip/255.255.255.255,permitted;DNS:${name:-flightmap.invalid}" \
      -addext "subjectKeyIdentifier=hash" 2>/dev/null
    mv ca.key.new ca.key
    mv ca.crt.new ca.crt
    echo "$names" > ca-names.txt
  fi
  chmod 600 ca.key
  chmod 644 ca.crt ca-names.txt

  echo "==> Making the map's certificate (valid $SERVER_DAYS days)"
  openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout key.pem.new -out cert.csr -subj "/CN=${name:-$ip}" 2>/dev/null
  printf '%s\n' "basicConstraints=CA:FALSE" "keyUsage=critical,digitalSignature" \
    "extendedKeyUsage=serverAuth" "subjectAltName=$names" \
    "subjectKeyIdentifier=hash" "authorityKeyIdentifier=keyid" > cert.ext
  openssl x509 -req -in cert.csr -CA ca.crt -CAkey ca.key -set_serial "0x$(openssl rand -hex 16)" \
    -days "$SERVER_DAYS" -sha256 -extfile cert.ext -out cert.pem.new 2>/dev/null
  rm -f cert.csr cert.ext
  mv key.pem.new key.pem
  mv cert.pem.new cert.pem
  chown "$OWNER" key.pem
  chmod 600 key.pem
  chmod 644 cert.pem

  set_conf private "$name"
  restart_and_check
  local valid_until where port http_port
  valid_until=$(openssl x509 -in cert.pem -noout -enddate | cut -d= -f2)
  http_port=$(conf_value PORT)
  port=$( [[ "$HTTPS_PORT" == 443 ]] && echo "" || echo ":$HTTPS_PORT")
  where="https://${name:-$ip}$port"
  echo
  echo "HTTPS is ON. Open:  $where"
  [[ -n "$name" ]] && echo "(The name '$name' must point to $ip in your router or Pi-hole; https://$ip$port works too.)"
  echo
  if [[ "$new_ca" != no ]]; then
    [[ "$new_ca" == again ]] && echo "The address or name changed, so this is a NEW certificate: import it again on each device."
    echo "ONE TIME on each device, trust the map's certificate (the README also has steps for phones):"
    echo "  1. In the browser, open:  http://$ip:${http_port:-8080}/flightmap-ca.crt"
    echo "     It downloads 'flightmap-ca.crt'."
    echo "  2. Windows: double-click it -> Install Certificate -> Current User -> Next ->"
    echo "     'Place all certificates in the following store' -> Browse ->"
    echo "     'Trusted Root Certification Authorities' -> OK -> Next -> Finish -> Yes."
    echo "  3. Close the browser completely and open it again."
  else
    echo "Devices that already trust the map's certificate don't need to do anything."
  fi
  echo "The certificate is valid until $valid_until. To renew:  bash $0 --renew"
}

# ---- 2. Let's Encrypt ----------------------------------------------------------
install_acme() {
  [[ -x "$ACME_SH" ]] && return
  echo "==> Installing acme.sh $ACME_VERSION (the tool that talks to Let's Encrypt)"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl cron >/dev/null
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/acmesh-official/acme.sh/archive/refs/tags/$ACME_VERSION.tar.gz" | tar -xz -C "$tmp"
  (cd "$tmp/acme.sh-$ACME_VERSION" && ./acme.sh --install --home "$ACME_HOME" --no-profile >/dev/null)
  rm -rf "$tmp"
  systemctl enable --now cron >/dev/null 2>&1 || true   # renewals run from cron, twice a day
}

# Ask for one secret (hidden while typing) unless it's already set.
ask_secret() {   # $1 = variable name, $2 = what to call it
  if [[ -n "${!1:-}" ]]; then export "${1?}"; return; fi
  local value=""
  while [[ -z "$value" ]]; do read -rsp "$2 (hidden while you type): " value; echo; done
  export "$1=$value"
}

choose_dns() {
  [[ -n "$DNS_API" ]] && return
  echo "Which company runs the DNS for $NAME?"
  echo "  1) Cloudflare"
  echo "  2) DuckDNS (free names like yourname.duckdns.org)"
  echo "  3) GoDaddy"
  echo "  4) Another one (acme.sh supports over 150)"
  local pick
  read -rp "Number: " pick
  case "$pick" in
    1) DNS_API=dns_cf ;;
    2) DNS_API=dns_duckdns ;;
    3) DNS_API=dns_gd ;;
    *) echo "Find your company's name (dns_...) and the variables it needs on:"
       echo "  https://github.com/acmesh-official/acme.sh/wiki/dnsapi"
       read -rp "Its name, e.g. dns_namecheap: " DNS_API ;;
  esac
}

dns_credentials() {
  case "$DNS_API" in
    dns_cf)
      echo "Cloudflare: make an API token with 'Zone - DNS - Edit' for your domain (dash.cloudflare.com -> My Profile -> API Tokens)."
      ask_secret CF_Token "Cloudflare API token" ;;
    dns_duckdns)
      echo "DuckDNS: your token is at the top of duckdns.org after signing in."
      ask_secret DuckDNS_Token "DuckDNS token" ;;
    dns_gd)
      echo "GoDaddy: make a production key at developer.godaddy.com/keys."
      echo "NOTE: GoDaddy may only allow its DNS API for larger accounts; if Let's Encrypt fails with"
      echo "'access denied', move the DNS to Cloudflare (free) or use DuckDNS."
      ask_secret GD_Key "GoDaddy key"
      ask_secret GD_Secret "GoDaddy secret" ;;
    dns_*)
      echo "Type the variables your DNS company needs (see the acme.sh wiki). Empty name = done."
      local var
      while read -rp "Variable name: " var && [[ -n "$var" ]]; do
        [[ "$var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Letters, numbers and _ only."; continue; }
        ask_secret "$var" "$var"
      done ;;
    *) echo "'$DNS_API' is not an acme.sh DNS name (they start with dns_)." >&2; exit 1 ;;
  esac
}

letsencrypt_cert() {
  [[ "$NAME" =~ $NAME_RE && "$NAME" == *.* ]] || { echo "Let's Encrypt needs a name, e.g. --name flightmap.example.com" >&2; exit 1; }
  choose_dns
  dns_credentials
  install_acme
  mkdir -p "$TLS_DIR"
  chmod 755 "$TLS_DIR"
  echo "==> Asking Let's Encrypt for a certificate for $NAME (this can take a minute or two)"
  "$ACME_SH" --home "$ACME_HOME" --set-default-ca --server letsencrypt >/dev/null
  local code=0
  "$ACME_SH" --home "$ACME_HOME" --issue --dns "$DNS_API" -d "$NAME" --keylength ec-256 || code=$?
  if [[ $code -ne 0 && $code -ne 2 ]]; then   # 2 = still valid, nothing to do
    echo "Let's Encrypt did not give a certificate. The messages above say why (often: the API key" >&2
    echo "can't change the DNS of $NAME). Nothing was changed on the map." >&2
    exit 1
  fi
  # Copy it where the map reads it, now and after every renewal.
  "$ACME_SH" --home "$ACME_HOME" --install-cert -d "$NAME" --ecc \
    --key-file "$TLS_DIR/key.pem" --fullchain-file "$TLS_DIR/cert.pem" \
    --reloadcmd "chown $OWNER $TLS_DIR/key.pem && chmod 600 $TLS_DIR/key.pem && chmod 644 $TLS_DIR/cert.pem && $RESTART_CMD"
  set_conf letsencrypt "$NAME"
  restart_and_check
  local port
  port=$( [[ "$HTTPS_PORT" == 443 ]] && echo "" || echo ":$HTTPS_PORT")
  echo
  echo "HTTPS is ON. Open:  https://$NAME$port"
  echo "The name must lead to this container ($(this_ip)): set it in your DNS, router or Pi-hole."
  echo "Let's Encrypt certificates last 90 days; acme.sh renews it by itself (from cron)."
  echo "Your DNS key is saved for renewals in $ACME_HOME/account.conf (only root can read it)."
}

restart_and_check() {
  echo "==> Restarting the map"
  $RESTART_CMD
  [[ "${SKIP_CHECK:-}" == 1 ]] && return
  sleep 2
  if ! python3 - "$HTTPS_PORT" <<'PY'
import ssl, sys, urllib.request
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE   # only checking that it answers, from inside the container
urllib.request.urlopen(f"https://127.0.0.1:{sys.argv[1]}/api/health", timeout=5, context=ctx)
PY
  then
    echo "The map is not answering on https. Its log:" >&2
    journalctl -u dji-flightmap -n 20 --no-pager >&2 || true
    exit 1
  fi
}

# ---- what to do ------------------------------------------------------------------
if [[ -z "$MODE" ]]; then
  ASKED=yes
  echo "How should the map get its certificate?"
  echo "  1) Private certificate: no domain needed; you import it once on each device"
  echo "  2) Let's Encrypt: needs a domain you own (or a free DuckDNS name); trusted everywhere"
  echo "  3) Turn HTTPS off (back to plain http)"
  read -rp "Number: " pick
  case "$pick" in
    1) MODE=private ;;
    2) MODE=letsencrypt ;;
    3) MODE=off ;;
    *) echo "Please run it again and type 1, 2 or 3." >&2; exit 1 ;;
  esac
fi

case "$MODE" in
  private)
    if [[ "$ASKED" == yes ]]; then
      ask_name "A name for the map, like flightmap.home (or just press Enter to use the IP address): " optional
    elif [[ -n "$NAME" && ! ( "$NAME" =~ $NAME_RE && "$NAME" == *.* ) ]]; then
      echo "That doesn't look like a name: $NAME" >&2; exit 1
    fi
    private_cert "${NAME,,}" ;;
  letsencrypt)
    [[ "$ASKED" == yes ]] && ask_name "Your domain name for the map, e.g. flightmap.example.com or yourname.duckdns.org: "
    NAME=${NAME,,}
    letsencrypt_cert ;;
  renew)
    case "$(conf_value TLS_MODE)" in
      private) private_cert "$(conf_value TLS_NAME)" ;;
      letsencrypt)
        "$ACME_SH" --home "$ACME_HOME" --renew -d "$(conf_value TLS_NAME)" --ecc --force
        echo "Renewed." ;;
      *) echo "HTTPS isn't on yet. Run: bash $0" >&2; exit 1 ;;
    esac ;;
  off)
    set_conf off
    $RESTART_CMD
    echo "HTTPS is OFF: the map is on plain http again. (Certificates are kept in $TLS_DIR.)" ;;
esac
