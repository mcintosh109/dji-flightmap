"""Settings from environment variables, where files live, and the log helper.

See deploy/dji-flightmap.env for what each environment variable means.
"""
import json
import os
import sys

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the "app" folder

DATA_DIR = os.environ.get("DATA_DIR", "/srv/dji-logs")
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
SCAN_SECONDS = max(5, int(os.environ.get("SCAN_SECONDS", "30")))
CACHE_FILE = os.environ.get("CACHE_FILE", "/var/lib/dji-flightmap/summaries.json")
# Folder for everything the server saves (settings, plans, login secret).
STATE_DIR = os.path.dirname(CACHE_FILE)
AUTH_USER = os.environ.get("AUTH_USER", "").strip()
AUTH_PASSWORD_HASH = os.environ.get("AUTH_PASSWORD_HASH", "").strip()
AUTH_ENABLED = bool(AUTH_USER and AUTH_PASSWORD_HASH)
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))   # stay signed in this long
SECRET_FILE = os.path.join(STATE_DIR, "session-secret")
SETTINGS_FILE = os.path.join(STATE_DIR, "settings.json")
# Where Azure Maps is reached (only changed by the tests, to use a fake one).
AZURE_MAPS_URL = os.environ.get("AZURE_MAPS_URL", "https://atlas.microsoft.com").rstrip("/")
# Where Google's Map Tiles API is reached (only changed by the tests).
GOOGLE_TILES_URL = os.environ.get("GOOGLE_TILES_URL", "https://tile.googleapis.com").rstrip("/")
# Where Google's Places service is reached (only changed by the tests).
GOOGLE_PLACES_URL = os.environ.get("GOOGLE_PLACES_URL", "https://places.googleapis.com").rstrip("/")
PLANS_FILE = os.path.join(STATE_DIR, "plans.json")
# HTTPS (set by deploy/set-https.sh; empty = plain http). See flightmap/https.py.
TLS_MODE = os.environ.get("TLS_MODE", "").strip()           # private | letsencrypt
TLS_CERT = os.environ.get("TLS_CERT", "").strip()
TLS_KEY = os.environ.get("TLS_KEY", "").strip()
HTTPS_PORT = int(os.environ.get("HTTPS_PORT", "443"))
# Where places (shops, schools, parks...) come from: the free OpenStreetMap
# Overpass API. These are public servers shared by everyone and can be slow,
# so if the first doesn't answer, the next is tried. A different list can be
# given, separated by commas (the tests point it at a fake one).
OVERPASS_URLS = [u.strip() for u in os.environ.get(
    "OVERPASS_URL", "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter"
).split(",") if u.strip()]
# The version number and "what's new" list live in app/version.json, so the
# web page can compare them with the newest copy on GitHub.
try:
    with open(os.path.join(APP_DIR, "version.json"), encoding="utf-8") as _fh:
        VERSION_INFO = json.load(_fh)
except (OSError, ValueError):
    VERSION_INFO = {"version": "0.0.0", "notes": []}
APP_VERSION = VERSION_INFO.get("version", "0.0.0")

STATIC_DIR = os.path.join(APP_DIR, "static")
MAX_TRACK_POINTS = 3000   # most points sent to the browser for one flight
PREVIEW_POINTS = 80       # points in the small "overview" line of each flight
DETAIL_CACHE_SIZE = 16    # how many full flights to keep in memory
CACHE_VERSION = 3         # bump this when the summary format changes

def log(message):
    """Print a line to the log (systemd/journalctl picks this up)."""
    print(message, file=sys.stderr, flush=True)
