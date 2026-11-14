"""Azure Maps through this server, so the key never goes to the browser.

The browser asks THIS server for map pictures and copyright credits; this
server asks Azure (over HTTPS) with the saved key and passes the answer back.

Two things keep that fast:
  - connections to Azure are kept open and reused, instead of doing a new
    secure "handshake" for every picture;
  - answers are remembered in memory for as long as Azure's own
    Cache-Control header says they are valid (at most a day), so looking
    at the same area again doesn't ask Azure at all.
"""
import http.client
import json
import os
import queue
import re
import threading
import time
from collections import OrderedDict
from html.parser import HTMLParser
from urllib.parse import quote, urlencode, urlsplit

from .config import AZURE_MAPS_URL, log
from .settings import current_settings

AZURE_TILESETS = {"microsoft.base.road", "microsoft.base.darkgrey", "microsoft.imagery", "microsoft.base.hybrid.road"}
AZURE_TIMEOUT = 10
POOL_SIZE = 8                    # open connections to Azure kept for reuse
CACHE_BYTES = int(os.environ.get("AZURE_CACHE_MB", "64")) * 1024 * 1024
CACHE_MAX_SECONDS = 24 * 3600    # never remember an answer longer than this

_pool = queue.LifoQueue()        # idle connections, most recently used first
_cache = OrderedDict()           # request -> (expires, content type, body); oldest first
_cache_size = 0
_cache_lock = threading.Lock()
_logged_cache_header = False


# ---- connections ---------------------------------------------------------------
def _new_connection():
    url = urlsplit(AZURE_MAPS_URL)
    kind = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    return kind(url.hostname, url.port, timeout=AZURE_TIMEOUT)


def _get(target):
    """One GET to Azure. Returns (status, content type, body, Cache-Control).

    Uses an idle open connection if there is one. Azure closes connections
    that sit idle, so if a reused one fails, try once more with a new one.
    """
    for must_be_new in (False, True):
        conn = None
        if not must_be_new:
            try:
                conn = _pool.get_nowait()
            except queue.Empty:
                pass
        reused = conn is not None
        if conn is None:
            conn = _new_connection()
        try:
            conn.request("GET", target, headers={"User-Agent": "dji-flightmap"})
            res = conn.getresponse()
            body = res.read()
        except (http.client.HTTPException, OSError):
            conn.close()
            if reused:
                continue
            raise
        if res.will_close or _pool.qsize() >= POOL_SIZE:
            conn.close()
        else:
            _pool.put(conn)
        return (res.status, res.getheader("Content-Type", "application/octet-stream"), body,
                res.getheader("Cache-Control", ""))
    raise OSError("could not reach Azure Maps")   # not reached: the loop returns or raises


# ---- remembering answers ----------------------------------------------------------
def _cache_seconds(cache_control):
    """How long Azure's Cache-Control header lets us keep an answer (0 = don't)."""
    value = cache_control.lower()
    if not value or any(word in value for word in ("no-store", "no-cache", "private")):
        return 0
    match = re.search(r"max-age\s*=\s*(\d+)", value)
    return min(int(match.group(1)), CACHE_MAX_SECONDS) if match else 0


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if not hit:
            return None
        expires, ctype, body = hit
        left = int(expires - time.time())
        if left <= 0:
            _cache_drop(key)
            return None
        return ctype, body, left


def _cache_put(key, ctype, body, seconds):
    global _cache_size
    if seconds <= 0 or len(body) > CACHE_BYTES // 8:
        return
    with _cache_lock:
        _cache_drop(key)
        _cache[key] = (time.time() + seconds, ctype, body)
        _cache_size += len(body)
        while _cache_size > CACHE_BYTES and _cache:
            _cache_drop(next(iter(_cache)))   # forget the oldest


def _cache_drop(key):
    global _cache_size
    old = _cache.pop(key, None)
    if old:
        _cache_size -= len(old[2])


# ---- the one function the web server calls ---------------------------------------------
def azure_request(path, params):
    """Ask Azure Maps, with the saved key. Returns (status, content type, body, headers).

    `headers` holds the Cache-Control to pass on to the browser, if any.
    """
    global _logged_cache_header
    key = current_settings().get("azureMapsKey", "")
    if not key:
        return 404, "application/json", b'{"error":"no Azure Maps key saved"}', {}

    cache_key = (path, tuple(sorted((k, str(v)) for k, v in params.items())))
    hit = _cache_get(cache_key)
    if hit:
        ctype, body, left = hit
        return 200, ctype, body, {"Cache-Control": f"max-age={left}"}

    query = urlencode({"api-version": "2024-04-01", **params, "subscription-key": key}, quote_via=quote)
    try:
        status, ctype, body, cache_control = _get(f"{urlsplit(AZURE_MAPS_URL).path}{path}?{query}")
    except (http.client.HTTPException, OSError) as err:
        log(f"Could not reach Azure Maps: {err}")
        return 502, "application/json", b'{"error":"could not reach Azure Maps"}', {}
    if status != 200:
        # Don't pass Azure's error text on (it can echo the request); just the status.
        log(f"Azure Maps answered {status} for {path}")
        return 502, "application/json", json.dumps({"error": f"Azure Maps answered {status}"}).encode(), {}

    seconds = _cache_seconds(cache_control)
    if path == "/map/tile" and not _logged_cache_header:
        _logged_cache_header = True
        log(f"Azure Maps pictures: Cache-Control is '{cache_control}', so they are "
            + (f"remembered on the server for up to {seconds} s" if seconds else "not remembered on the server"))
    _cache_put(cache_key, ctype, body, seconds)
    return 200, ctype, body, ({"Cache-Control": cache_control} if cache_control else {})


# ---- copyright credits come as HTML; keep only the text ---------------------------------
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
