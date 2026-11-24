"""HTTPS: the padlock in the browser (research: "TLS certificate").

Chosen on the settings page (Settings -> Secure connection):
  private      (the default) the map makes its own certificate. Each device
               imports it once, then trusts the map.
  letsencrypt  a free, publicly trusted certificate for a name you own,
               from Let's Encrypt, using the acme.sh tool and your DNS
               company's API (research: "acme.sh", "DNS-01 challenge").
  off          plain http.

With HTTPS on, the map is served on https://<address>/ (port 443 by default)
and the old http port (PORT, usually 8080) only:
  - sends the browser on to the https address (bookmarks keep working),
  - answers /api/health (used by the update script),
  - hands out the private certificate (/flightmap-ca.crt), so a device can
    trust it before it can open the https page.

If a certificate can't be made or loaded, the map stays on plain http and
the settings page says why: a broken certificate never hides the map.

The certificates live in /var/lib/dji-flightmap/tls (see config.TLS_DIR).
"""
import json
import os
import re
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler

from .config import ACME_HOME, ACME_SH, TLS_DIR, log

CERT = os.path.join(TLS_DIR, "cert.pem")
KEY = os.path.join(TLS_DIR, "key.pem")
CA_CERT = os.path.join(TLS_DIR, "ca.crt")
CA_KEY = os.path.join(TLS_DIR, "ca.key")
CA_NAMES = os.path.join(TLS_DIR, "ca-names.txt")
CA_PATH = "/flightmap-ca.crt"
SERVER_DAYS = 825        # longest a browser accepts (about 2 years 3 months)
RENEW_DAYS = 30          # make a new private certificate this long before it runs out

# What the settings page shows: off / working / on / error, and a message.
_state = {"state": "off", "message": "", "mode": "off", "port": None, "newCa": False}
_state_lock = threading.Lock()


class CertError(Exception):
    """A certificate could not be made; the message says why, in plain words."""


def set_state(state, message="", **extra):
    with _state_lock:
        _state.update(state=state, message=message, **extra)
    if message:
        log(f"HTTPS: {message}")


def this_ip():
    """This container's address on the network (no packet is sent)."""
    if os.environ.get("FLIGHTMAP_IP"):
        return os.environ["FLIGHTMAP_IP"]
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))          # a documentation address: nothing is reached
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def _openssl(*args):
    result = subprocess.run(["openssl", *args], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise CertError(f"openssl failed: {result.stderr.strip()[-300:]}")
    return result.stdout


def _read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def cert_info(path=CERT):
    """Names, end date and days left of a certificate file ({} if unreadable)."""
    try:
        cert = ssl._ssl._test_decode_cert(path)   # reads a certificate file (standard library)
        expires = ssl.cert_time_to_seconds(cert["notAfter"])
    except (OSError, ssl.SSLError, ValueError, KeyError):
        return {}
    label = dict(item for part in cert.get("subject", ()) for item in part).get("commonName", "")
    return {"names": [value for _, value in cert.get("subjectAltName", ())][:10], "label": label,
            "expires": time.strftime("%Y-%m-%d", time.gmtime(expires)),
            "daysLeft": int((expires - time.time()) // 86400)}


# ---- private certificate ----------------------------------------------------------
def private_certificate(name, force=False):
    """Make sure a private certificate for this address (+ name) exists.

    Returns True when a NEW certificate authority was made (devices must
    import it again). Raises CertError.
    """
    ip = this_ip()
    names = f"IP:{ip}" + (f",DNS:{name}" if name else "")
    os.makedirs(TLS_DIR, exist_ok=True)
    new_ca = False
    # The "certificate authority" (CA) is what each device imports. It is
    # limited to this map's address and name ("name constraints"), so it
    # can't be used to fake other websites. Kept for 10 years and reused
    # while the address and name stay the same: renewing needs no import.
    if not (os.access(CA_KEY, os.R_OK) and os.path.isfile(CA_CERT) and _read(CA_NAMES) == names):
        new_ca = True
        log(f"HTTPS: making the map's private certificate authority for {names}")
        _openssl("req", "-x509", "-new", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                 "-keyout", CA_KEY + ".new", "-out", CA_CERT + ".new", "-days", "3650", "-sha256",
                 "-subj", f"/CN=DJI Flight Map private certificate ({ip})",
                 "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                 "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                 "-addext", f"nameConstraints=critical,permitted;IP:{ip}/255.255.255.255,"
                            f"permitted;DNS:{name or 'flightmap.invalid'}",
                 "-addext", "subjectKeyIdentifier=hash")
        os.chmod(CA_KEY + ".new", 0o600)
        os.replace(CA_KEY + ".new", CA_KEY)
        os.replace(CA_CERT + ".new", CA_CERT)
        with open(CA_NAMES, "w", encoding="utf-8") as fh:
            fh.write(names + "\n")
    info = cert_info()
    wanted = {ip} | ({name} if name else set())
    if not (force or new_ca or set(info.get("names", [])) != wanted or info.get("daysLeft", -1) < RENEW_DAYS
            or info.get("label") != "DJI Flight Map"):   # older test versions used the address as label
        return False   # the one we have is fine
    log(f"HTTPS: making the map's certificate ({SERVER_DAYS} days) for {names}")
    with tempfile.TemporaryDirectory(dir=TLS_DIR) as tmp:
        csr, ext = os.path.join(tmp, "cert.csr"), os.path.join(tmp, "cert.ext")
        _openssl("req", "-new", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                 # A plain label, not an address: with "name constraints", checkers
                 # would read an address-like label as a name and refuse it. The
                 # real names are in subjectAltName below.
                 "-keyout", KEY + ".new", "-out", csr, "-subj", "/CN=DJI Flight Map")
        with open(ext, "w", encoding="utf-8") as fh:
            fh.write("basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                     f"extendedKeyUsage=serverAuth\nsubjectAltName={names}\n"
                     "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n")
        _openssl("x509", "-req", "-in", csr, "-CA", CA_CERT, "-CAkey", CA_KEY,
                 "-set_serial", "0x" + os.urandom(16).hex(), "-days", str(SERVER_DAYS), "-sha256",
                 "-extfile", ext, "-out", CERT + ".new")
    os.chmod(KEY + ".new", 0o600)
    os.replace(KEY + ".new", KEY)
    os.replace(CERT + ".new", CERT)
    return new_ca


# ---- Let's Encrypt --------------------------------------------------------------
def _acme(args, creds, timeout=600):
    """Run acme.sh; returns (exit code, output with the secrets hidden)."""
    if not os.access(ACME_SH, os.X_OK):
        raise CertError("acme.sh isn't installed. Update the map (it is installed by the update), "
                        "or check the container can reach github.com.")
    env = {**os.environ, **creds, "HOME": ACME_HOME}
    result = subprocess.run([ACME_SH, "--home", ACME_HOME, *args], env=env, capture_output=True,
                            text=True, timeout=timeout)
    out = result.stdout + result.stderr
    for value in creds.values():
        if value:
            out = out.replace(value, "<hidden>")
    return result.returncode, out


# acme.sh's messages are technical: for the common ones, a plain sentence
# goes first, then the details.
ACME_HINTS = (
    ("invalid domain",
     "Your DNS company could not find this name's domain. Check the name is spelled exactly like your "
     "domain there (letter by letter), and that the API key may read that domain "
     "(Cloudflare: Zone → Zone → Read and Zone → DNS → Edit)."),
)


def _acme_failure(out):
    """The error message for a failed --issue: a plain hint if we know one, then acme.sh's last lines."""
    lines = " | ".join([ln for ln in out.splitlines() if ln.strip()][-6:])[-600:]
    hint = next((text for needle, text in ACME_HINTS if needle in out.lower()), "")
    if hint:
        return f"Let's Encrypt did not give a certificate. {hint} Details: {lines}"
    return "Let's Encrypt did not give a certificate: " + lines


def letsencrypt_certificate(name, dns_api, creds, force=False):
    """Get (or keep) a Let's Encrypt certificate for name. Raises CertError."""
    info = cert_info()
    if not force and info.get("names") == [name] and info.get("daysLeft", -1) > RENEW_DAYS:
        return False
    if not creds:
        raise CertError("Let's Encrypt needs your DNS company's API key: add it in Settings.")
    os.makedirs(ACME_HOME, exist_ok=True)
    os.makedirs(TLS_DIR, exist_ok=True)
    set_state("working", f"Asking Let's Encrypt for a certificate for {name} (this can take a few minutes)…",
              mode="letsencrypt")
    _acme(["--set-default-ca", "--server", "letsencrypt"], {})
    code, out = _acme(["--issue", "--dns", dns_api, "-d", name, "--keylength", "ec-256"]
                      + (["--force"] if force else []), creds)
    if code not in (0, 2):   # 2 = the one we have is still fine
        raise CertError(_acme_failure(out))
    code, out = _acme(["--install-cert", "-d", name, "--ecc", "--key-file", KEY, "--fullchain-file", CERT], {})
    if code != 0:
        raise CertError("Could not copy the certificate: " + out.strip()[-300:])
    os.chmod(KEY, 0o600)
    return False


def renew_letsencrypt():
    """Called twice a day: acme.sh renews when it is due (about every 60 days)."""
    code, out = _acme(["--cron"], {}, timeout=900)
    if code != 0:
        log("HTTPS: Let's Encrypt renewal problem: " + out.strip()[-300:])


# ---- one place that decides --------------------------------------------------------
def make_certificate(settings, force=False):
    """Make or check the certificate for the chosen kind. Raises CertError."""
    mode = settings["httpsMode"]
    if mode == "private":
        return private_certificate(settings["httpsName"], force)
    if mode == "letsencrypt":
        return letsencrypt_certificate(settings["httpsName"], settings["httpsDnsApi"],
                                       settings.get("httpsDnsCredentials") or {}, force)
    return False


def context():
    """An SSL context with the certificate. Raises CertError."""
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(CERT, KEY)
        return ctx
    except (OSError, ssl.SSLError, ValueError) as err:
        raise CertError(f"the certificate could not be loaded ({err})") from None


def status(settings, http_port):
    """What the settings page shows about HTTPS."""
    with _state_lock:
        info = dict(_state)
    info.update(choice=settings["httpsMode"], httpPort=http_port, ip=this_ip())
    if info["state"] == "on":
        info.update(cert_info())
        info["caCert"] = info["mode"] == "private" and os.path.isfile(CA_CERT)
    return info


# ---- the old http port, once https is on --------------------------------------------
def send_ca(handler):
    """Answer with the private CA certificate as a download (or 404)."""
    data = None
    with _state_lock:
        private = _state["mode"] == "private"
    if private:
        try:
            with open(CA_CERT, "rb") as fh:
                data = fh.read(65536)
        except OSError:
            data = None
    if not data or b"BEGIN CERTIFICATE" not in data:
        body = b'{"error":"no private certificate on this map"}'
        handler.send_response(404)
        handler.send_header("Content-Type", "application/json")
    else:
        body = data
        handler.send_response(200)
        handler.send_header("Content-Type", "application/x-x509-ca-cert")
        handler.send_header("Content-Disposition", 'attachment; filename="flightmap-ca.crt"')
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


HOST_RE = re.compile(r"[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]")


def redirect_handler(https_port):
    """A request handler for the old http port that sends browsers to https."""

    class RedirectHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = 30

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/health":
                body = json.dumps({"ok": True, "httpsPort": https_port}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == CA_PATH:
                send_ca(self)
                return
            host = self.headers.get("Host", "")
            # "192.168.1.50:8080" -> "192.168.1.50"; "[fd00::5]:8080" -> "[fd00::5]"
            name = host.split("]")[0] + "]" if host.startswith("[") else host.split(":")[0]
            if not HOST_RE.fullmatch(name or ""):
                self.send_error(400, "Missing or odd Host header")
                return
            port = "" if https_port == 443 else f":{https_port}"
            target = self.path if self.path.startswith("/") else "/"
            # 301 = moved for good (GET); 308 keeps the method for anything else.
            self.send_response(301 if self.command in ("GET", "HEAD") else 308)
            self.send_header("Location", f"https://{name}{port}{target}")
            self.send_header("Content-Length", "0")
            if self.command not in ("GET", "HEAD"):
                self.send_header("Connection", "close")
            self.end_headers()

        do_HEAD = do_GET
        do_POST = do_GET
        do_PUT = do_GET
        do_DELETE = do_GET

        def log_message(self, fmt, *args):
            pass

    return RedirectHandler
