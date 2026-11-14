#!/usr/bin/env python3
"""
DJI Flight Map - server
=======================

A small web server that:
  1. watches a folder for decrypted DJI flight logs (.csv and .geojson),
  2. reads each log and works out a summary (date, duration, distance, ...),
  3. serves a web page (the files in ./static) that draws the flights on a map.

It only uses the Python standard library, so there is nothing to "pip install".

This file holds the web addresses (the Handler class) and start-up. The
rest lives in the flightmap/ folder, one file per job:
  config.py      environment settings and file locations
  flightlogs.py  reading one flight log into a summary + track
  library.py     the list of all flights (scanning, caching, duplicates)
  settings.py    the settings page's values
  plans.py       saved flight plans
  auth.py        the optional login
  azure.py       Azure Maps through this server (keeps the key private)
  places.py      shops, schools, parks... from OpenStreetMap

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
  /api/settings         GET: the settings page's values, PUT: save them
  /api/rescan           POST: look for new log files right now
  /tiles/azure/<tileset>/<z>/<x>/<y>.png
                        one Azure Maps picture, fetched by this server with
                        the saved key (the key never goes to the browser)
  /api/azure-credits    Azure's copyright line for the area on screen
  /api/places?x0=&x1=&y0=&y1=
                        places (shops, schools, parks...) in those map
                        squares, from OpenStreetMap (see flightmap/places.py)
  /api/plans            GET: saved flight plans
  /api/plans/<id>       PUT: save a plan (id "new" makes one), DELETE: remove it
  /login.html           the login page (only used when a login is set)
  /logout               signs you out
  /settings.html        the settings page

Settings changed on the settings page are saved in settings.json, next to
CACHE_FILE. SCAN_SECONDS and SESSION_DAYS above are only the starting values.

The same flight is often saved more than once (for example in several
dated archive folders). Copies are recognised by aircraft serial number +
start time, and only one is shown.
"""

import getpass
import gzip
import hmac
import json
import re
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from flightmap import auth
from flightmap.auth import (COOKIE_NAME, PUBLIC_PATHS, hash_password, make_session_cookie, record_failure,
                            session_days, session_is_valid, too_many_failures, verify_password)
from flightmap.azure import AZURE_TILESETS, azure_request, html_to_text
from flightmap.config import (APP_VERSION, AUTH_ENABLED, AUTH_PASSWORD_HASH, AUTH_USER, DATA_DIR, HOST, PORT,
                              STATIC_DIR, VERSION_INFO, log)
from flightmap.library import FlightLibrary
from flightmap.places import PlacesError, parse_range, places_in
from flightmap.plans import MAX_PLANS, PLAN_ID_RE, PLANS_LOCK, clean_plan, load_plans, save_plans
from flightmap.settings import (DEFAULT_SETTINGS, SERVER_ONLY_KEYS, clean_settings, current_settings,
                                load_settings, public_settings, save_settings)

LIBRARY = None   # created in main()


def scan_forever():
    while True:
        try:
            LIBRARY.scan()
        except Exception as exc:
            log(f"Scan failed: {exc}")
        time.sleep(current_settings()["scanSeconds"])


# --------------------------------------------------------------------------
# The web server
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 lets the browser reuse a connection for many requests (a
    # screen of map is 20-40 pictures) instead of reconnecting for each one.
    # One Handler object then serves several requests, so anything set per
    # request (like cache_control) must be reset after each answer.
    protocol_version = "HTTP/1.1"
    timeout = 65           # close a connection that has been idle this long (seconds)
    # Send each reply straight away. Without this, a reply sent in two pieces
    # (headers, then body) on a reused connection waits about 40 ms for the
    # browser to acknowledge the first piece ("Nagle's algorithm").
    disable_nagle_algorithm = True
    cache_control = None   # set per request to override "no-cache"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        # Tell browsers to re-check files, so updates show up straight away
        # (map pictures are the exception: they set cache_control).
        self.send_header("Cache-Control", self.cache_control or "no-cache")
        self.cache_control = None
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        if self.command not in ("GET", "HEAD"):
            # Requests that carry data (saving, signing in) get their own
            # connection: if we answer without reading all of the data, the
            # leftover would be mistaken for the next request.
            self.send_header("Connection", "close")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Only log API calls and errors, not every picture/script request or
        # idle connections timing out.
        if fmt.startswith("Request timed out"):
            return
        is_api = getattr(self, "path", "").startswith("/api/")
        is_error = len(args) > 1 and str(args[1])[:1] in "45"
        if is_api or is_error:
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
            return self.send_json(self.flights_payload())
        if path == "/api/settings":
            return self.send_json(self.settings_payload())
        if path.startswith("/tiles/azure/"):
            return self.azure_tile(path)
        if path == "/api/azure-credits":
            return self.azure_credits()
        if path == "/api/places":
            return self.places()
        if path == "/api/plans":
            with PLANS_LOCK:
                plans = [dict(p, id=k) for k, p in load_plans().items()]
            plans.sort(key=lambda p: p.get("updated", ""), reverse=True)
            return self.send_json({"plans": plans})
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

    # ---- Azure Maps through this server -----------------------------------
    def azure_tile(self, path):
        m = re.fullmatch(r"/tiles/azure/([a-z.]+)/(\d{1,2})/(\d{1,7})/(\d{1,7})\.png", path)
        if not m or m.group(1) not in AZURE_TILESETS:
            return self.send_json({"error": "unknown map picture"}, 400)
        tileset, z, x, y = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
        if z > 22 or x >= 2 ** z or y >= 2 ** z:
            return self.send_json({"error": "map picture out of range"}, 400)
        status, ctype, body, headers = azure_request("/map/tile", {
            "tilesetId": tileset, "zoom": z, "x": x, "y": y, "tileSize": 256})
        if status != 200:
            return self.send_raw(status, ctype, body)
        # Let the browser keep pictures for a while (Azure's own advice if given).
        self.cache_control = headers.get("Cache-Control") or "private, max-age=86400"
        return self.send_raw(200, ctype, body)

    def azure_credits(self):
        q = parse_qs(urlparse(self.path).query)
        tileset = (q.get("tileset") or [""])[0]
        zoom = (q.get("zoom") or [""])[0]
        bounds = (q.get("bounds") or [""])[0]
        if (tileset not in AZURE_TILESETS or not zoom.isdigit() or int(zoom) > 22
                or not re.fullmatch(r"-?\d{1,3}(\.\d+)?(,-?\d{1,3}(\.\d+)?){3}", bounds)):
            return self.send_json({"error": "bad request"}, 400)
        status, _, body, _ = azure_request("/map/attribution", {"tilesetId": tileset, "zoom": zoom, "bounds": bounds})
        if status != 200:
            return self.send_json({"copyrights": []}, 200 if status == 404 else status)
        try:
            raw = json.loads(body).get("copyrights", [])
        except ValueError:
            raw = []
        credits = []
        for item in raw if isinstance(raw, list) else []:
            text = html_to_text(item)
            if text and text not in credits:
                credits.append(text[:200])
        return self.send_json({"copyrights": credits})

    # ---- places from OpenStreetMap ------------------------------------------
    def places(self):
        squares = parse_range(parse_qs(urlparse(self.path).query))
        if squares is None:
            return self.send_json({"error": "bad or too large map area"}, 400)
        try:
            answer = places_in(*squares)
        except PlacesError as err:
            log(f"Places: {err}")
            if err.busy:
                return self.send_json({"error": "OpenStreetMap is busy, try again in a minute", "busy": True}, 503)
            return self.send_json({"error": "could not get places from OpenStreetMap"}, 502)
        return self.send_json(answer)

    def send_raw(self, status, ctype, body):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- settings + rescan --------------------------------------------------
    def from_our_page(self):
        """Changes must come from our own page's JavaScript.

        Browsers won't let another website add this header without our
        permission, so a random web page can't change your settings.
        """
        if self.headers.get("X-Requested-With") == "flightmap":
            return True
        self.send_json({"error": "missing X-Requested-With header"}, 403)
        return False

    def flights_payload(self):
        """The flight list, plus what the page needs to know about the app."""
        return {
            "auth": AUTH_ENABLED,
            "app": {"version": APP_VERSION, "repo": VERSION_INFO.get("repo", "")},
            "settings": public_settings(),
            **LIBRARY.listing(),
        }

    def settings_payload(self):
        aircraft = {}
        for f in LIBRARY.listing()["flights"]:
            if f["serial"] and f["serial"] not in aircraft:
                aircraft[f["serial"]] = f["aircraftName"]
        return {
            "settings": public_settings(),
            "defaults": DEFAULT_SETTINGS,
            "info": {
                "version": APP_VERSION,
                "released": VERSION_INFO.get("released", ""),
                "notes": VERSION_INFO.get("notes", []),
                "repo": VERSION_INFO.get("repo", ""),
                "auth": AUTH_ENABLED,
                "user": AUTH_USER if AUTH_ENABLED else "",
                "dataDir": DATA_DIR,
                "aircraft": [{"serial": k, "model": v} for k, v in aircraft.items()],
            },
        }

    def read_json_body(self, limit=65536):
        """Read a JSON object sent by the page. Returns None after answering an error."""
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            self.send_json({"error": "too much data"}, 413)
            return None
        try:
            incoming = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(incoming, dict):
                raise ValueError
        except ValueError:
            self.send_json({"error": "not valid JSON"}, 400)
            return None
        return incoming

    def plan_id_from(self, path):
        plan_id = unquote(path[len("/api/plans/"):])
        if plan_id == "new":
            return secrets.token_hex(6)
        return plan_id if PLAN_ID_RE.match(plan_id) else None

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/plans/"):
            return self.send_json({"error": "unknown address"}, 404)
        if not self.allowed(path) or not self.from_our_page():
            return
        plan_id = self.plan_id_from(path)
        with PLANS_LOCK:
            plans = load_plans()
            if plan_id not in plans:
                return self.send_json({"error": "plan not found"}, 404)
            del plans[plan_id]
            save_plans(plans)
        log(f"{self.client_address[0]} deleted plan {plan_id}")
        return self.send_json({"ok": True})

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/plans/"):
            return self.put_plan(path)
        if path != "/api/settings":
            return self.send_json({"error": "unknown address"}, 404)
        if not self.allowed(path) or not self.from_our_page():
            return
        incoming = self.read_json_body()
        if incoming is None:
            return
        # The page never sees saved keys, so an empty box means "keep it";
        # "remove<Key>": true deletes it.
        for key in SERVER_ONLY_KEYS:
            remove_flag = "remove" + key[0].upper() + key[1:]
            if incoming.pop(remove_flag, False) is True:
                incoming[key] = ""
            elif not str(incoming.get(key, "")).strip():
                incoming.pop(key, None)
            incoming.pop(key + "Set", None)
        new, problems = clean_settings(incoming)
        if problems:
            return self.send_json({"error": " ".join(problems), "problems": problems}, 400)
        try:
            save_settings(new)
        except OSError as exc:
            return self.send_json({"error": f"could not save: {exc}"}, 500)
        log(f"{self.client_address[0]} saved settings")
        return self.send_json(self.settings_payload())

    def put_plan(self, path):
        if not self.allowed(path) or not self.from_our_page():
            return
        plan_id = self.plan_id_from(path)
        if plan_id is None:
            return self.send_json({"error": "bad plan id"}, 400)
        incoming = self.read_json_body(limit=262144)
        if incoming is None:
            return
        plan, problems = clean_plan(incoming)
        if problems:
            return self.send_json({"error": " ".join(problems[:5]), "problems": problems}, 400)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with PLANS_LOCK:
            plans = load_plans()
            if plan_id not in plans and len(plans) >= MAX_PLANS:
                return self.send_json({"error": f"You can save up to {MAX_PLANS} plans."}, 400)
            plan["created"] = plans.get(plan_id, {}).get("created", now)
            plan["updated"] = now
            plans[plan_id] = plan
            try:
                save_plans(plans)
            except OSError as exc:
                return self.send_json({"error": f"could not save: {exc}"}, 500)
        log(f"{self.client_address[0]} saved plan {plan_id}")
        return self.send_json(dict(plan, id=plan_id))

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/rescan":
            if not self.allowed(path) or not self.from_our_page():
                return
            LIBRARY.scan()
            return self.send_json(self.flights_payload())
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
            cookie = (f"{COOKIE_NAME}={make_session_cookie()}; Max-Age={session_days() * 86400}; "
                      "Path=/; HttpOnly; SameSite=Lax")
            return self.redirect("/", cookie=cookie)
        record_failure(ip)
        log(f"{ip} wrong username or password")
        time.sleep(1)   # slows down anyone trying to guess
        return self.redirect("/login.html?error=1")


def main():
    global LIBRARY
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
        auth.start()
        log(f"Login page is ON (user: {AUTH_USER})")
    else:
        log("Login page is OFF (set it up with deploy/set-login.sh)")

    load_settings()
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
