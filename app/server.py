#!/usr/bin/env python3
"""
DJI Flight Map - server
=======================

A small web server that:
  1. watches a folder for decrypted DJI flight logs (.csv and .geojson),
  2. reads each log and works out a summary (date, duration, distance, ...),
  3. serves a web page (the files in ./static) that draws the flights on a map.

It only uses the Python standard library, so there is nothing to "pip install".

Settings are read from environment variables (see deploy/dji-flightmap.env):
  DATA_DIR      folder that holds the flight logs     (default: /srv/dji-logs)
  PORT          port the web page is served on        (default: 8080)
  HOST          address to listen on, 0.0.0.0 = all   (default: 0.0.0.0)
  SCAN_SECONDS  how often to look for new logs        (default: 30)
  CACHE_FILE    where summaries are remembered between restarts
                (default: /var/lib/dji-flightmap/summaries.json)

Optional login (leave both empty to turn the login page off):
  AUTH_USER           the username
  AUTH_PASSWORD_HASH  the password, scrambled ("hashed") so it is never
                      stored as plain text. Make one with:
                        python3 server.py --hash-password
                      (deploy/set-login.sh does all of this for you)

Web addresses it answers:
  /                     the map page (static/index.html)
  /api/flights          JSON list of every flight (summaries only)
  /api/flights/<id>     JSON for one flight, including the full track
  /api/health           {"ok": true} - handy for checking the service is up
  /login.html           the login page (only used when a login is set)
  /logout               signs you out

The same flight is often saved more than once (for example in several
dated archive folders). Copies are recognised by aircraft serial number +
start time, and only one is shown.
"""

import csv
import getpass
import gzip
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sys
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
DATA_DIR = os.environ.get("DATA_DIR", "/srv/dji-logs")
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
SCAN_SECONDS = max(5, int(os.environ.get("SCAN_SECONDS", "30")))
CACHE_FILE = os.environ.get("CACHE_FILE", "/var/lib/dji-flightmap/summaries.json")
AUTH_USER = os.environ.get("AUTH_USER", "").strip()
AUTH_PASSWORD_HASH = os.environ.get("AUTH_PASSWORD_HASH", "").strip()
AUTH_ENABLED = bool(AUTH_USER and AUTH_PASSWORD_HASH)
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))   # stay signed in this long
SECRET_FILE = os.path.join(os.path.dirname(CACHE_FILE), "session-secret")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_TRACK_POINTS = 3000   # most points sent to the browser for one flight
PREVIEW_POINTS = 80       # points in the small "overview" line of each flight
DETAIL_CACHE_SIZE = 16    # how many full flights to keep in memory
CACHE_VERSION = 3         # bump this when the summary format changes

# DJI CSV rows can be very wide; raise Python's default field size limit.
csv.field_size_limit(10_000_000)


def log(message):
    """Print a line to the log (systemd/journalctl picks this up)."""
    print(message, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def num(value, default=None):
    """Turn text like '12.5' into a number. Blank or broken text -> default."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def valid_coord(lat, lon):
    """True if lat/lon look like a real GPS position (not missing, not 0,0)."""
    if lat is None or lon is None:
        return False
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return False
    return not (abs(lat) < 1e-6 and abs(lon) < 1e-6)


def haversine_m(lat1, lon1, lat2, lon2):
    """Distance in metres between two GPS points (the 'haversine' formula)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_time(text):
    """Read a DJI timestamp. Returns a timezone-aware datetime, or None.

    The logs contain two styles:
      '2026-11-12T01:56:31.078Z'      (CSV)
      '2026-11-12 01:56:30.967 UTC'   (GeoJSON)
    The very first CSV row is often '1970-01-01...' (clock not set yet);
    anything before the year 2000 is treated as missing.
    """
    if not text:
        return None
    text = text.strip()
    dt = None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        for pattern in ("%Y-%m-%d %H:%M:%S.%f UTC", "%Y-%m-%d %H:%M:%S UTC"):
            try:
                dt = datetime.strptime(text, pattern)
                break
            except ValueError:
                pass
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt if dt.year >= 2000 else None


def downsample(items, limit):
    """Keep at most `limit` items, spread evenly, always keeping the last one."""
    if len(items) <= limit:
        return list(items)
    step = (len(items) - 1) / (limit - 1)
    return [items[round(i * step)] for i in range(limit)]


# --------------------------------------------------------------------------
# Reading log files
# --------------------------------------------------------------------------
def parse_csv(path):
    """Read a CSV made by dji-log-parser. Returns points, events and meta info."""
    points, events = [], []
    meta = {}
    start = None
    clock_base = None   # the drone's flight clock at the first row of this file
    last_lat = last_lon = None
    last_text = {"tip": None, "warn": None}

    with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
        reader = csv.DictReader(fh)
        columns = set(reader.fieldnames or [])
        if not {"OSD.latitude", "OSD.longitude"} <= columns:
            raise ValueError("not a DJI flight log (no OSD.latitude / OSD.longitude columns)")
        for row in reader:
            get = row.get

            # Aircraft / flight details repeat on every row; keep the first good value.
            for key, columns in (
                ("aircraftName", ("DETAILS.aircraftName", "RECOVER.aircraftName")),
                ("serial", ("DETAILS.aircraftSerial", "RECOVER.aircraftSerial")),
                ("batterySerial", ("RECOVER.batterySerial",)),
                ("appVersion", ("DETAILS.appVersion", "RECOVER.appVersion")),
                ("totalTime", ("DETAILS.totalTime",)),
                ("photoNum", ("DETAILS.photoNum",)),
                ("videoTime", ("DETAILS.videoTime",)),
            ):
                if not meta.get(key):
                    for col in columns:
                        if get(col):
                            meta[key] = get(col)
                            break

            when = parse_time(get("CUSTOM.dateTime"))
            # The drone's flight clock does NOT always start at 0: if you land
            # and take off again without switching the drone off, it carries
            # on from the last flight. So count from this file's first row.
            clock = num(get("OSD.flyTime"), 0.0)
            if clock_base is None:
                clock_base = clock
            t = max(0.0, clock - clock_base)
            if when and start is None:
                start = when - timedelta(seconds=t)

            lat, lon = num(get("OSD.latitude")), num(get("OSD.longitude"))
            has_fix = valid_coord(lat, lon)
            if has_fix:
                last_lat, last_lon = lat, lon

            # App messages ("Flight mode changed to ...", warnings, ...).
            for kind, col in (("tip", "APP.tip"), ("warn", "APP.warn")):
                text = (get(col) or "").strip()
                if text and text != last_text[kind]:
                    events.append({"t": round(t, 1), "kind": kind, "text": text,
                                   "lat": last_lat, "lon": last_lon})
                last_text[kind] = text or None

            if not has_fix:
                continue  # no GPS lock yet: nothing to draw for this row

            x_speed = num(get("OSD.xSpeed"), 0.0)
            y_speed = num(get("OSD.ySpeed"), 0.0)
            points.append({
                "t": round(t, 1),                                   # seconds since start
                "lat": round(lat, 8),
                "lon": round(lon, 8),
                "h": round(num(get("OSD.height"), 0.0), 1),         # metres above take-off
                "spd": round(math.hypot(x_speed, y_speed), 2),      # m/s across the ground
                "vs": round(num(get("OSD.zSpeed"), 0.0), 2),        # m/s up/down
                "yaw": num(get("OSD.yaw"), 0.0),                    # heading, 0 = north
                "bat": num(get("BATTERY.chargeLevel")),             # percent
                "sats": num(get("OSD.gpsNum")),                     # GPS satellites
                "mode": get("OSD.flycState") or "",
            })

    return {
        "points": points,
        "events": events,
        "start": start,
        "aircraftName": meta.get("aircraftName", ""),
        "serial": meta.get("serial", ""),
        "batterySerial": meta.get("batterySerial", ""),
        "appVersion": meta.get("appVersion", ""),
        "totalTime": num(meta.get("totalTime")),
        "photoNum": int(num(meta.get("photoNum"), 0)),
        "videoTime": num(meta.get("videoTime"), 0),
    }


def parse_geojson(path):
    """Read a GeoJSON flight log. It has positions but far fewer details."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        data = json.load(fh)
    feature = data
    if data.get("type") == "FeatureCollection":
        feature = (data.get("features") or [{}])[0]
    props = feature.get("properties") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    total = num(props.get("totalTime"), 0.0)

    points = []
    base_alt = None
    count = len(coords)
    for i, c in enumerate(coords):
        if len(c) < 2:
            continue
        lon, lat = num(c[0]), num(c[1])
        if not valid_coord(lat, lon):
            continue
        alt = num(c[2], 0.0) if len(c) > 2 else 0.0
        if base_alt is None:
            base_alt = alt
        points.append({
            # GeoJSON has no clock per point, so spread them over the flight time.
            "t": round(total * i / (count - 1), 1) if count > 1 else 0.0,
            "lat": round(lat, 8), "lon": round(lon, 8),
            "h": round(alt - base_alt, 1),
            "spd": None, "vs": None, "yaw": 0.0, "bat": None, "sats": None, "mode": "",
        })

    return {
        "points": points,
        "events": [],
        "start": parse_time(props.get("startTime")),
        "aircraftName": props.get("aircraftName", ""),
        "serial": props.get("aircraftSN", ""),
        "batterySerial": "",
        "appVersion": "",
        "totalTime": total,
        "photoNum": int(num(props.get("captureNum"), 0)),
        "videoTime": num(props.get("videoTime"), 0),
    }


def build_flight(path, rel_path, mtime):
    """Read one file and return (summary, detail)."""
    parsed = parse_csv(path) if path.lower().endswith(".csv") else parse_geojson(path)
    pts = parsed["points"]

    distance = 0.0
    for a, b in zip(pts, pts[1:]):
        distance += haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])

    duration = parsed["totalTime"] or (pts[-1]["t"] if pts else 0.0)
    start = parsed["start"]
    batteries = [p["bat"] for p in pts if p["bat"] is not None]
    speeds = [p["spd"] for p in pts if p["spd"] is not None]

    flight_id = hashlib.sha1(rel_path.encode("utf-8")).hexdigest()[:12]
    summary = {
        "id": flight_id,
        "file": rel_path,
        "source": "csv" if path.lower().endswith(".csv") else "geojson",
        "aircraftName": parsed["aircraftName"] or "Unknown aircraft",
        "serial": parsed["serial"],
        "batterySerial": parsed["batterySerial"],
        "appVersion": parsed["appVersion"],
        "start": start.isoformat() if start else None,
        "end": (start + timedelta(seconds=duration)).isoformat() if start else None,
        "sortKey": start.timestamp() if start else mtime,
        "duration": round(duration, 1),
        "distance": round(distance, 1),
        "maxHeight": max((p["h"] for p in pts), default=0.0),
        "maxSpeed": max(speeds, default=None),
        "batteryStart": batteries[0] if batteries else None,
        "batteryEnd": batteries[-1] if batteries else None,
        "photoNum": parsed["photoNum"],
        "videoTime": parsed["videoTime"],
        "warnings": sum(1 for e in parsed["events"] if e["kind"] == "warn"),
        "hasGps": bool(pts),
        "points": len(pts),
        "home": {"lat": pts[0]["lat"], "lon": pts[0]["lon"]} if pts else None,
        "last": ({"lat": pts[-1]["lat"], "lon": pts[-1]["lon"],
                  "h": pts[-1]["h"], "yaw": pts[-1]["yaw"]} if pts else None),
        "preview": [[round(p["lat"], 6), round(p["lon"], 6)]
                    for p in downsample(pts, PREVIEW_POINTS)],
    }
    detail = {
        "summary": summary,
        "track": downsample(pts, MAX_TRACK_POINTS),
        "events": parsed["events"],
    }
    return summary, detail


# --------------------------------------------------------------------------
# The flight library: keeps track of every file in DATA_DIR
# --------------------------------------------------------------------------
class FlightLibrary:
    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.entries = {}          # full path -> {"sig", "rel", "summary", "error"}
        self.by_id = {}            # flight id -> full path
        self.details = OrderedDict()
        self.version = 0           # goes up every time something changes
        self.scanning = True
        self.problem = None
        self.last_scan = None
        self._load_cache()

    # ---- remembering summaries between restarts --------------------------
    def _load_cache(self):
        try:
            with open(CACHE_FILE, encoding="utf-8") as fh:
                saved = json.load(fh)
            if saved.get("version") == CACHE_VERSION and saved.get("root") == self.root:
                for path, entry in saved.get("entries", {}).items():
                    entry["sig"] = tuple(entry["sig"])
                    self.entries[path] = entry
                self._reindex()
                log(f"Loaded {len(self.entries)} cached flight summaries")
        except FileNotFoundError:
            pass
        except Exception as exc:  # a broken cache is not fatal, just rebuild it
            log(f"Ignoring cache file {CACHE_FILE}: {exc}")

    def _save_cache(self):
        try:
            os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
            tmp = CACHE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": CACHE_VERSION, "root": self.root,
                           "entries": self.entries}, fh)
            os.replace(tmp, CACHE_FILE)
        except OSError as exc:
            log(f"Could not save cache file {CACHE_FILE}: {exc}")

    def _reindex(self):
        self.by_id = {e["summary"]["id"]: p for p, e in self.entries.items() if e.get("summary")}

    # ---- finding files -----------------------------------------------------
    def _find_files(self):
        """Return {full path: relative path} for every log in the folder.

        If 'Flight_X.csv' and 'Flight_X.geojson' are both there, the CSV wins
        because it has far more detail.
        """
        chosen = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                stem, ext = os.path.splitext(name)
                ext = ext.lower()
                if name.startswith(".") or ext not in (".csv", ".geojson"):
                    continue
                key = os.path.join(dirpath, stem)
                if ext == ".csv" or key not in chosen:
                    chosen[key] = os.path.join(dirpath, name)
        return {path: os.path.relpath(path, self.root) for path in chosen.values()}

    def scan(self):
        if not os.path.isdir(self.root):
            with self.lock:
                self.problem = f"Data folder not found: {self.root}"
                self.scanning = False
            return

        files = self._find_files()
        changed = False
        new_entries = {}
        for path, rel in files.items():
            try:
                st = os.stat(path)
            except OSError:
                continue
            sig = (st.st_mtime, st.st_size)
            old = self.entries.get(path)
            if old and old["sig"] == sig:
                new_entries[path] = old
                continue
            changed = True
            try:
                summary, detail = build_flight(path, rel, st.st_mtime)
                new_entries[path] = {"sig": sig, "rel": rel, "summary": summary, "error": None}
                with self.lock:
                    self._remember_detail(path, sig, detail)
                log(f"Read {rel}: {len(detail['track'])} points")
            except Exception as exc:
                new_entries[path] = {"sig": sig, "rel": rel, "summary": None, "error": str(exc)}
                log(f"Could not read {rel}: {exc}")

        if set(new_entries) != set(self.entries):
            changed = True

        with self.lock:
            self.entries = new_entries
            self._reindex()
            self.problem = None
            self.scanning = False
            self.last_scan = datetime.now(timezone.utc).isoformat()
            if changed:
                self.version += 1
        if changed:
            self._save_cache()

    # ---- answering the web page -------------------------------------------
    @staticmethod
    def _same_flight_key(summary):
        """Two files are the same flight if they share serial number + start time."""
        if summary["start"]:
            return f"{summary['serial']}|{summary['start'][:19]}"
        # No clock in the log: fall back to the file name without its folder.
        return "file|" + os.path.splitext(os.path.basename(summary["file"]))[0]

    def _unique_flights(self):
        """Pick one file per flight. Prefers CSV, then the most GPS points,
        then the most recently saved copy."""
        best = {}
        copies = {}
        for entry in self.entries.values():
            summary = entry.get("summary")
            if not summary:
                continue
            key = self._same_flight_key(summary)
            copies[key] = copies.get(key, 0) + 1
            rank = (summary["source"] == "csv", summary.get("points", 0), entry["sig"][0])
            if key not in best or rank > best[key][0]:
                best[key] = (rank, summary)
        flights = []
        for key, (_, summary) in best.items():
            flights.append(dict(summary, copies=copies[key]))
        return flights

    def listing(self):
        with self.lock:
            flights = self._unique_flights()
            errors = [{"file": e["rel"], "error": e["error"]}
                      for e in self.entries.values() if e.get("error")]
            flights.sort(key=lambda s: s["sortKey"], reverse=True)
            return {
                "auth": AUTH_ENABLED,
                "files": len(self.entries),
                "version": self.version,
                "scanning": self.scanning,
                "problem": self.problem,
                "dataDir": self.root,
                "lastScan": self.last_scan,
                "flights": flights,
                "errors": errors,
            }

    def _remember_detail(self, path, sig, detail):
        self.details[(path, sig)] = detail
        self.details.move_to_end((path, sig))
        while len(self.details) > DETAIL_CACHE_SIZE:
            self.details.popitem(last=False)

    def detail(self, flight_id):
        with self.lock:
            path = self.by_id.get(flight_id)
            entry = self.entries.get(path) if path else None
            if not entry:
                return None
            key = (path, entry["sig"])
            if key in self.details:
                self.details.move_to_end(key)
                return self.details[key]
        # Not in memory: read the file again (outside the lock, it can be slow).
        st = os.stat(path)
        _, detail = build_flight(path, entry["rel"], st.st_mtime)
        with self.lock:
            self._remember_detail(path, entry["sig"], detail)
        return detail


LIBRARY = None   # created in main()


def scan_forever():
    while True:
        try:
            LIBRARY.scan()
        except Exception as exc:
            log(f"Scan failed: {exc}")
        time.sleep(SCAN_SECONDS)


# --------------------------------------------------------------------------
# Login (only used when AUTH_USER and AUTH_PASSWORD_HASH are set)
# --------------------------------------------------------------------------
# Passwords are stored as a PBKDF2 hash: a one-way scramble that is slow to
# guess. Format:  pbkdf2_sha256:<rounds>:<salt hex>:<hash hex>
# (no "$" characters, so it is safe inside a systemd EnvironmentFile).
COOKIE_NAME = "flightmap_session"
PUBLIC_PATHS = {"/login", "/login.html", "/api/login", "/api/health", "/favicon.ico"}
FAILED_LOGINS = {}            # ip address -> list of times of failed logins
FAILED_LOCK = threading.Lock()
MAX_FAILURES = 10             # this many wrong passwords ...
FAILURE_WINDOW = 15 * 60      # ... within 15 minutes locks that address out


def hash_password(password, rounds=600_000):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
    return f"pbkdf2_sha256:{rounds}:{salt.hex()}:{digest.hex()}"


def verify_password(password, stored):
    try:
        algorithm, rounds, salt_hex, digest_hex = stored.split(":")
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     bytes.fromhex(salt_hex), int(rounds))
    except ValueError:
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


def load_session_secret():
    """A random key used to sign login cookies, kept so restarts don't log you out."""
    try:
        with open(SECRET_FILE, "rb") as fh:
            secret = fh.read()
        if len(secret) >= 32:
            return secret
    except OSError:
        pass
    secret = secrets.token_bytes(32)
    try:
        os.makedirs(os.path.dirname(SECRET_FILE), exist_ok=True)
        fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(secret)
    except OSError as exc:
        log(f"Could not save {SECRET_FILE} ({exc}); logins will end when the server restarts")
    return secret


SESSION_SECRET = b""


def _sign(text):
    # The password hash is part of the signature, so changing the password
    # signs everyone out.
    key = SESSION_SECRET + AUTH_PASSWORD_HASH.encode("utf-8")
    return hmac.new(key, text.encode("utf-8"), hashlib.sha256).hexdigest()


def make_session_cookie():
    expires = int(time.time()) + SESSION_DAYS * 86400
    body = f"{AUTH_USER}:{expires}"
    return f"{body}:{_sign(body)}"


def session_is_valid(cookie_header):
    if not cookie_header:
        return False
    try:
        cookie = SimpleCookie(cookie_header)
    except Exception:
        return False
    morsel = cookie.get(COOKIE_NAME)
    if not morsel:
        return False
    parts = morsel.value.rsplit(":", 2)
    if len(parts) != 3:
        return False
    user, expires, signature = parts
    if not hmac.compare_digest(_sign(f"{user}:{expires}"), signature):
        return False
    return user == AUTH_USER and expires.isdigit() and int(expires) > time.time()


def too_many_failures(ip):
    now = time.time()
    with FAILED_LOCK:
        recent = [t for t in FAILED_LOGINS.get(ip, []) if now - t < FAILURE_WINDOW]
        FAILED_LOGINS[ip] = recent
        return len(recent) >= MAX_FAILURES


def record_failure(ip):
    with FAILED_LOCK:
        FAILED_LOGINS.setdefault(ip, []).append(time.time())


# --------------------------------------------------------------------------
# The web server
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        # Tell browsers to re-check files, so updates show up straight away.
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Only log API calls and errors, not every image/script request.
        if self.path.startswith("/api/") or (args and str(args[1])[:1] in "45"):
            log(f"{self.address_string()} {fmt % args}")

    def send_json(self, obj, status=200):
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        compress = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if compress:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if compress:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location, cookie=None):
        self.send_response(303)
        self.send_header("Location", location)
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- the login gate ----------------------------------------------------
    def allowed(self, path):
        """True if this request may go ahead. Otherwise sends the right answer."""
        if not AUTH_ENABLED or path in PUBLIC_PATHS:
            return True
        if session_is_valid(self.headers.get("Cookie")):
            return True
        if path.startswith("/api/"):
            self.send_json({"error": "login required"}, 401)
        else:
            self.redirect("/login.html")
        return False

    def do_HEAD(self):
        path = urlparse(self.path).path
        if self.allowed(path):
            super().do_HEAD()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/login":
            return self.redirect("/login.html")
        if path == "/logout":
            return self.redirect("/login.html" if AUTH_ENABLED else "/",
                                 cookie=f"{COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax")
        if path == "/login.html" and not AUTH_ENABLED:
            return self.redirect("/")
        if not self.allowed(path):
            return
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/flights":
            return self.send_json(LIBRARY.listing())
        if path.startswith("/api/flights/"):
            flight_id = unquote(path[len("/api/flights/"):])
            try:
                detail = LIBRARY.detail(flight_id)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 500)
            if detail is None:
                return self.send_json({"error": "flight not found"}, 404)
            return self.send_json(detail)
        if path.startswith("/api/"):
            return self.send_json({"error": "unknown address"}, 404)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/login" or not AUTH_ENABLED:
            return self.send_json({"error": "unknown address"}, 404)
        ip = self.client_address[0]
        if too_many_failures(ip):
            log(f"{ip} login blocked: too many wrong passwords")
            return self.redirect("/login.html?error=locked")
        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        user = (form.get("username") or [""])[0]
        password = (form.get("password") or [""])[0]
        user_ok = hmac.compare_digest(user.encode("utf-8"), AUTH_USER.encode("utf-8"))
        password_ok = verify_password(password, AUTH_PASSWORD_HASH)  # always run: same timing
        if user_ok and password_ok:
            log(f"{ip} signed in as {AUTH_USER}")
            cookie = (f"{COOKIE_NAME}={make_session_cookie()}; Max-Age={SESSION_DAYS * 86400}; "
                      "Path=/; HttpOnly; SameSite=Lax")
            return self.redirect("/", cookie=cookie)
        record_failure(ip)
        log(f"{ip} wrong username or password")
        time.sleep(1)   # slows down anyone trying to guess
        return self.redirect("/login.html?error=1")


def main():
    global LIBRARY, SESSION_SECRET
    if "--hash-password" in sys.argv:
        # Used by deploy/set-login.sh: asks for a password, prints its hash.
        first = getpass.getpass("New password: ")
        if len(first) < 8:
            sys.exit("Please use at least 8 characters.")
        if getpass.getpass("Type it again: ") != first:
            sys.exit("The two passwords did not match.")
        print(hash_password(first))
        return

    if AUTH_USER and not re.fullmatch(r"[A-Za-z0-9._@-]{1,64}", AUTH_USER):
        sys.exit("AUTH_USER may only contain letters, numbers and . _ @ -")
    if AUTH_ENABLED:
        SESSION_SECRET = load_session_secret()
        log(f"Login page is ON (user: {AUTH_USER})")
    else:
        log("Login page is OFF (set it up with deploy/set-login.sh)")

    LIBRARY = FlightLibrary(DATA_DIR)
    log(f"DJI Flight Map: reading logs from {DATA_DIR}")
    threading.Thread(target=scan_forever, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"Open http://<this-container-ip>:{PORT} in a browser")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
