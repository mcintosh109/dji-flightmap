"""Google Maps through this server, so the key never goes to the browser.

Uses Google's Map Tiles API (research: "Google Map Tiles API 2D tiles").
It works in two steps:
  1. a "session" is made for one kind of map (road, satellite, ...):
       POST https://tile.googleapis.com/v1/createSession?key=KEY
     Google answers with a session code that is valid for about two weeks.
     It is kept in memory and made again when it runs out.
  2. each map picture is then fetched with the session code and the key:
       GET  https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=...&key=...

Google's rules (Map Tiles API policies) that shape this file:
  - Map pictures must NOT be stored by us. Unlike Azure, nothing is
    remembered on the server; the browser may keep a picture only as long
    as Google's own Cache-Control header allows.
  - The Google logo and Google's copyright text for the area on screen
    must be shown on the map. The text comes from the "viewport" request
    (google_credits below); the page shows the logo next to it.
"""
import json
import threading
import time
from urllib.parse import quote, urlencode

from .azure import html_to_text
from .config import GOOGLE_TILES_URL, log
from .settings import current_settings
from .upstream import Upstream

GOOGLE = Upstream(GOOGLE_TILES_URL, timeout=10)

# Dark map: Google's "night" colours (research: "Google Maps styling").
DARK_STYLE = [
    {"elementType": "geometry", "stylers": [{"color": "#1d2026"}]},
    {"elementType": "labels.text.stroke", "stylers": [{"color": "#1d2026"}]},
    {"elementType": "labels.text.fill", "stylers": [{"color": "#8a919c"}]},
    {"featureType": "poi", "elementType": "geometry", "stylers": [{"color": "#23272e"}]},
    {"featureType": "poi.park", "elementType": "geometry", "stylers": [{"color": "#1f2a24"}]},
    {"featureType": "road", "elementType": "geometry", "stylers": [{"color": "#363c46"}]},
    {"featureType": "road.highway", "elementType": "geometry", "stylers": [{"color": "#4a505c"}]},
    {"featureType": "transit", "elementType": "geometry", "stylers": [{"color": "#2a2f37"}]},
    {"featureType": "water", "elementType": "geometry", "stylers": [{"color": "#0e1626"}]},
]

# The kinds of map ("sets") the page can ask for, and what Google is told.
GOOGLE_SETS = {
    "roadmap": {"mapType": "roadmap"},
    "satellite": {"mapType": "satellite"},
    # satellite + roads and names on top ("layerRoadmap")
    "hybrid": {"mapType": "satellite", "layerTypes": ["layerRoadmap"]},
    # Google's terrain map always needs the roads layer with it
    "terrain": {"mapType": "terrain", "layerTypes": ["layerRoadmap"]},
    "dark": {"mapType": "roadmap", "styles": DARK_STYLE},
}

_sessions = {}                    # (set, key) -> (session code, valid until)
_refused = {}                     # (set, key) -> (ask again after, status): Google said no
_sessions_lock = threading.Lock()
RETRY_AFTER = 60                  # after Google refuses a session, wait this long before asking again


def _error_text(body, key):
    """Google's error message (e.g. "Map Tiles API has not been used in
    project ..."), its status word and reasons, for the log. Never includes the key."""
    try:
        error = json.loads(body).get("error", {})
        parts = [str(error.get("message", "")), str(error.get("status", ""))]
        for detail in error.get("details") or []:
            if isinstance(detail, dict) and detail.get("reason"):
                parts.append(f"reason {detail['reason']}")
    except (ValueError, AttributeError):
        parts = []
    return " / ".join(p for p in parts if p).replace(key, "<key>")[:400] or "(no details)"


def _session(tileset, key, fresh=False):
    """A session code for this kind of map (made once, then reused)."""
    with _sessions_lock:
        hit = _sessions.get((tileset, key))
        if hit and not fresh and hit[1] > time.time() + 3600:
            return hit[0]
        # Google said no a moment ago: don't ask again for every map picture.
        refused = _refused.get((tileset, key))
        if refused and refused[0] > time.time():
            raise GoogleError(refused[1])
        body = json.dumps({**GOOGLE_SETS[tileset], "language": "en-US", "region": "US"}).encode()
        status, _, answer, _ = GOOGLE.request(
            "POST", "/v1/createSession?" + urlencode({"key": key}, quote_via=quote),
            body=body, headers={"Content-Type": "application/json"})
        if status != 200:
            log(f"Google Maps: making a {tileset} session failed ({status}): {_error_text(answer, key)}. "
                "Check in Google Cloud that the Map Tiles API is enabled for this key's project, "
                f"billing is set up, and the key may use it. Trying again in {RETRY_AFTER} s.")
            _refused[(tileset, key)] = (time.time() + RETRY_AFTER, status)
            raise GoogleError(status)
        _refused.pop((tileset, key), None)
        data = json.loads(answer)
        try:
            expires = float(data.get("expiry", 0)) or time.time() + 86400
        except (TypeError, ValueError):
            expires = time.time() + 86400
        _sessions[(tileset, key)] = (data["session"], expires)
        log(f"Google Maps: new {tileset} session")
        return data["session"]


class GoogleError(Exception):
    def __init__(self, status):
        super().__init__(f"Google Maps answered {status}")
        self.status = status


def _ask(tileset, path, params):
    """GET from Google with the saved key and a session. Retries once with a
    new session if Google no longer accepts the old one."""
    key = current_settings().get("googleMapsKey", "")
    if not key:
        return 404, "application/json", b'{"error":"no Google Maps key saved"}', ""
    try:
        for fresh in (False, True):
            session = _session(tileset, key, fresh)
            query = urlencode({**params, "session": session, "key": key}, quote_via=quote)
            status, ctype, body, cache_control = GOOGLE.request("GET", f"{path}?{query}")
            if status == 200:
                return 200, ctype, body, cache_control
            if status in (400, 401, 403) and not fresh:
                continue           # perhaps the session ran out: make a new one and try again
            if status != 404:      # 404 = no picture at this zoom here (normal)
                log(f"Google Maps answered {status} for {path}: {_error_text(body, key)}")
            break
    except GoogleError as err:
        status = err.status
    except (OSError, ValueError, KeyError) as err:
        log(f"Could not reach Google Maps: {err}")
        return 502, "application/json", b'{"error":"could not reach Google Maps"}', ""
    # Don't pass Google's error text on (it can echo the request); just the status.
    return 502 if status != 404 else 404, "application/json", json.dumps(
        {"error": f"Google Maps answered {status}"}).encode(), ""


def google_tile(tileset, z, x, y):
    """One map picture. Returns (status, content type, body, Cache-Control).

    Not remembered on this server (Google's rules); Google's Cache-Control is
    passed on so the browser follows Google's own instructions.
    """
    return _ask(tileset, f"/v1/2dtiles/{z}/{x}/{y}", {})


def google_credits(tileset, zoom, west, south, east, north):
    """Google's copyright text for the area on screen, and the closest zoom
    that has pictures there. Returns ({"copyright": ..., "maxZoom": ...}, status)."""
    status, _, body, _ = _ask(tileset, "/tile/v1/viewport", {
        "zoom": zoom, "north": north, "south": south, "east": east, "west": west})
    if status != 200:
        return {"copyright": ""}, status
    try:
        data = json.loads(body)
    except ValueError:
        return {"copyright": ""}, 502
    answer = {"copyright": html_to_text(data.get("copyright", ""))[:300]}
    zoom = closest_zoom(data.get("maxZoomRects") or data.get("maxZoomRect") or [],
                        (float(south) + float(north)) / 2, (float(west) + float(east)) / 2)
    if zoom is not None:
        answer["maxZoom"] = zoom
    return answer, 200


def closest_zoom(rects, lat, lon):
    """The closest zoom Google has pictures for at (lat, lon).

    Google lists areas with the closest zoom available in each; they
    overlap, and one usually covers the whole world with a LOW zoom. The
    answer is the highest zoom among the areas that contain the point (the
    lowest would stretch one world-sized picture over the screen).
    """
    def zoom_of(r):
        z = r.get("maxzoom", r.get("maxZoom"))
        return z if isinstance(z, int) else None

    def contains(r):
        try:
            return (float(r["south"]) <= lat <= float(r["north"])
                    and float(r["west"]) <= lon <= float(r["east"]))
        except (KeyError, TypeError, ValueError):
            return True   # no corners given: assume it covers the point

    rects = [r for r in rects if isinstance(r, dict) and zoom_of(r) is not None]
    here = [zoom_of(r) for r in rects if contains(r)]
    return max(here) if here else None


# ---- "python3 server.py --check-google": try each kind of map once -------------------
def check():
    """Ask Google for a session and one picture of each kind of map, and
    describe what Google said. Returns lines of text (never the key)."""
    key = current_settings().get("googleMapsKey", "")
    if not key:
        return ["No Google Maps key is saved. Add it on the settings page (Settings -> Map)."]
    tries = [(name, {**body, "language": "en-US", "region": "US"}) for name, body in GOOGLE_SETS.items()]
    # Other ways of asking, to narrow down what Google objects to.
    tries += [
        ("roadmap, no language/region", {"mapType": "roadmap"}),
        ("roads as a separate layer", {"mapType": "satellite", "layerTypes": ["layerRoadmap"], "overlay": True,
                                       "language": "en-US", "region": "US"}),
    ]
    lines = [f"Asking Google ({GOOGLE_TILES_URL}) with the saved key:"]
    for name, body in tries:
        try:
            status, _, answer, _ = GOOGLE.request(
                "POST", "/v1/createSession?" + urlencode({"key": key}, quote_via=quote),
                body=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        except OSError as err:
            lines.append(f"  {name:30} could not reach Google: {err}")
            continue
        if status != 200:
            lines.append(f"  {name:30} session REFUSED ({status}): {_error_text(answer, key)}")
            continue
        try:
            session = json.loads(answer)["session"]
        except (ValueError, KeyError):
            lines.append(f"  {name:30} session: unexpected answer from Google")
            continue
        query = urlencode({"session": session, "key": key}, quote_via=quote)
        status, ctype, answer, _ = GOOGLE.request("GET", f"/v1/2dtiles/0/0/0?{query}")
        picture = (f"OK ({ctype}, {len(answer)} bytes)" if status == 200
                   else f"REFUSED ({status}): {_error_text(answer, key)}")
        lines.append(f"  {name:30} session OK, picture {picture}")
    return lines
