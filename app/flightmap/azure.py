"""Azure Maps through this server, so the key never goes to the browser.

The browser asks THIS server for map pictures and copyright credits; this
server asks Azure (over HTTPS) with the saved key and passes the answer back.
"""
import json
import re
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from .config import AZURE_MAPS_URL, log
from .settings import current_settings

AZURE_TILESETS = {"microsoft.base.road", "microsoft.base.darkgrey", "microsoft.imagery", "microsoft.base.hybrid.road"}
AZURE_TIMEOUT = 10


def azure_request(path, params):
    """Call Azure Maps with the saved key. Returns (status, content type, body, headers)."""
    key = current_settings().get("azureMapsKey", "")
    if not key:
        return 404, "application/json", b'{"error":"no Azure Maps key saved"}', {}
    query = urlencode({"api-version": "2024-04-01", **params, "subscription-key": key}, quote_via=quote)
    req = Request(f"{AZURE_MAPS_URL}{path}?{query}", headers={"User-Agent": "dji-flightmap"})
    try:
        with urlopen(req, timeout=AZURE_TIMEOUT) as res:
            return res.status, res.headers.get("Content-Type", "application/octet-stream"), res.read(), dict(res.headers)
    except HTTPError as err:
        # Don't pass Azure's error text on (it can echo the request); just the status.
        log(f"Azure Maps answered {err.code} for {path}")
        return 502, "application/json", json.dumps({"error": f"Azure Maps answered {err.code}"}).encode(), {}
    except (URLError, OSError) as err:
        log(f"Could not reach Azure Maps: {err}")
        return 502, "application/json", b'{"error":"could not reach Azure Maps"}', {}


class _TextOnly(HTMLParser):
    """Keeps the readable text of an HTML snippet (scripts and styles dropped)."""

    def __init__(self):
        super().__init__()
        self.parts, self._skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(snippet):
    parser = _TextOnly()
    parser.feed(str(snippet))
    parser.close()
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()
