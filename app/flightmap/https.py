"""HTTPS: the padlock in the browser (research: "TLS certificate").

deploy/set-https.sh makes or fetches a certificate and sets these in
/etc/default/dji-flightmap:
    TLS_MODE=private | letsencrypt
    TLS_CERT=/var/lib/dji-flightmap/tls/cert.pem
    TLS_KEY=/var/lib/dji-flightmap/tls/key.pem
    HTTPS_PORT=443

Then the map is served on https://<address>/ and the old http port (PORT,
usually 8080) only does three things:
  - sends the browser on to the https address (so bookmarks keep working),
  - answers /api/health (used by the update script),
  - hands out the private certificate (/flightmap-ca.crt), so a device can
    trust it before it can open the https page.

If the certificate can't be loaded, the map is served on plain http as
before, so a broken certificate never makes the map disappear.
"""
import json
import os
import re
import ssl
import time
from http.server import BaseHTTPRequestHandler

from .config import HTTPS_PORT, TLS_CERT, TLS_KEY, TLS_MODE, log

# The private "certificate authority" that signed the certificate (only in
# private mode). It is public information: devices import it to trust the map.
CA_FILE = os.path.join(os.path.dirname(TLS_CERT), "ca.crt") if TLS_CERT else ""
CA_PATH = "/flightmap-ca.crt"
ACTIVE = {"on": False}   # set by server.py once https is really running


def load_context():
    """An SSL context with our certificate, or None (plain http)."""
    if not (TLS_CERT and TLS_KEY):
        return None
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(TLS_CERT, TLS_KEY)
        return ctx
    except (OSError, ssl.SSLError, ValueError) as err:
        log(f"HTTPS is set up but the certificate could not be loaded ({err}). "
            "Serving plain http instead. Fix it with: bash /opt/dji-flightmap/deploy/set-https.sh")
        return None


def status():
    """What the settings page shows about HTTPS."""
    if not TLS_CERT:
        return {"on": False}
    info = {"on": ACTIVE["on"], "mode": TLS_MODE or "private", "port": HTTPS_PORT,
            "caCert": (TLS_MODE or "private") == "private" and os.path.isfile(CA_FILE)}
    try:
        cert = ssl._ssl._test_decode_cert(TLS_CERT)   # reads a certificate file (standard library)
        info["names"] = [value for _, value in cert.get("subjectAltName", ())][:10]
        expires = ssl.cert_time_to_seconds(cert["notAfter"])
        info["expires"] = time.strftime("%Y-%m-%d", time.gmtime(expires))
        info["daysLeft"] = int((expires - time.time()) // 86400)
    except (OSError, ssl.SSLError, ValueError, KeyError):
        pass
    return info


def ca_file_bytes():
    """The private CA certificate, or None."""
    if (TLS_MODE or "private") != "private" or not CA_FILE:
        return None
    try:
        with open(CA_FILE, "rb") as fh:
            data = fh.read(65536)
        return data if b"BEGIN CERTIFICATE" in data else None
    except OSError:
        return None


def send_ca(handler):
    """Answer with the CA certificate as a download (or 404)."""
    data = ca_file_bytes()
    if data is None:
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


class RedirectHandler(BaseHTTPRequestHandler):
    """The old http port, once https is on (see the top of this file)."""
    protocol_version = "HTTP/1.1"
    timeout = 30

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            body = json.dumps({"ok": True, "https": True}).encode()
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
        port = "" if HTTPS_PORT == 443 else f":{HTTPS_PORT}"
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
