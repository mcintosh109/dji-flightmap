"""Talking to a map company's server (Azure Maps, Google Maps) over HTTPS.

Opening a secure connection takes a "handshake" that is slower than
downloading one map picture, so connections are kept open and reused
(research: "HTTP keep-alive", "connection pool").
"""
import http.client
import queue
from urllib.parse import urlsplit

POOL_SIZE = 8   # open connections kept for reuse, per map company


class Upstream:
    """Open connections to one server, e.g. Upstream("https://atlas.microsoft.com")."""

    def __init__(self, base_url, timeout=10):
        self.url = urlsplit(base_url.rstrip("/"))
        self.prefix = self.url.path              # e.g. "" or "/fake" in the tests
        self.timeout = timeout
        self._idle = queue.LifoQueue()           # idle connections, most recently used first

    def _new(self):
        kind = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        return kind(self.url.hostname, self.url.port, timeout=self.timeout)

    def request(self, method, target, body=None, headers=None):
        """One request. Returns (status, content type, body, Cache-Control).

        Uses an idle open connection if there is one. Servers close
        connections that sit idle, so if a reused one fails, try once more
        with a new one.
        """
        headers = {"User-Agent": "dji-flightmap", **(headers or {})}
        for must_be_new in (False, True):
            conn = None
            if not must_be_new:
                try:
                    conn = self._idle.get_nowait()
                except queue.Empty:
                    pass
            reused = conn is not None
            if conn is None:
                conn = self._new()
            try:
                conn.request(method, self.prefix + target, body=body, headers=headers)
                res = conn.getresponse()
                data = res.read()
            except (http.client.HTTPException, OSError):
                conn.close()
                if reused:
                    continue
                raise
            if res.will_close or self._idle.qsize() >= POOL_SIZE:
                conn.close()
            else:
                self._idle.put(conn)
            return (res.status, res.getheader("Content-Type", "application/octet-stream"), data,
                    res.getheader("Cache-Control", ""))
        raise OSError("could not reach " + self.url.netloc)   # not reached: the loop returns or raises
