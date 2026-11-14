"""Places on the map (shops, schools, parks, ...), from OpenStreetMap.

The map can show what is around you, like the businesses and parks on
Google Maps. The places come from OpenStreetMap (research: "OpenStreetMap",
"Overpass API"): free, no key, made by volunteers. Coverage is good in
towns and thinner in the countryside.

How it works:
  - The world is cut into squares (map "tiles" at zoom level 15, about
    1 km across). The browser asks for the squares on screen:
        /api/places?x0=9650&x1=9652&y0=12317&y1=12318
  - This server asks the Overpass API once for all the squares it doesn't
    know yet, sorts the answer into squares and remembers each square for
    a week (places rarely change). Looking at the same area again, from
    any browser, doesn't ask OpenStreetMap at all.
  - Only one question goes to Overpass at a time: it is a free service
    shared by everyone, and it asks users to be gentle with it.

Each place sent to the browser is small:
    {"id": "n123", "lat": .., "lon": .., "name": "Joe's Cafe",
     "kind": "food", "label": "Cafe", "addr": "12 Main St", "hours": "Mo-Fr 07:00-15:00"}
"""
import json
import math
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from urllib.parse import urlencode

from .config import APP_VERSION, OVERPASS_URL, log

GRID_ZOOM = 15                 # size of the squares (zoom 15 tiles: ~1.2 km at the equator)
MAX_TILES = 30                 # most squares in one request (a big screen at zoom 16)
MAX_PLACES = 4000              # most places Overpass sends in one answer
CACHE_SECONDS = 7 * 24 * 3600  # remember a square for a week
CACHE_TILES = 3000             # remember at most this many squares (oldest forgotten first)
TIMEOUT = 40                   # seconds to wait for Overpass

# What to show, as OpenStreetMap tags (research: "OpenStreetMap map features").
# kind -> (tag, values or None for "any value", label used when no better one)
# The order matters: the first match wins (a car repair shop is "car", not "shop").
KINDS = [
    ("air", "aeroway", {"aerodrome", "heliport", "helipad", "airstrip"}),
    ("food", "amenity", {"restaurant", "cafe", "fast_food", "bar", "pub", "ice_cream", "food_court", "biergarten"}),
    ("school", "amenity", {"school", "college", "university", "kindergarten", "library", "childcare"}),
    ("health", "amenity", {"hospital", "clinic", "doctors", "dentist", "pharmacy", "veterinary"}),
    ("health", "healthcare", None),
    ("car", "amenity", {"fuel", "charging_station", "car_wash", "car_rental"}),
    ("car", "shop", {"car", "car_repair", "car_parts", "tyres", "motorcycle"}),
    ("worship", "amenity", {"place_of_worship"}),
    ("public", "amenity", {"police", "fire_station", "townhall", "post_office", "courthouse",
                           "community_centre", "bank", "prison", "ranger_station"}),
    ("fun", "amenity", {"cinema", "theatre", "arts_centre", "nightclub", "casino"}),
    ("fun", "leisure", {"fitness_centre", "bowling_alley", "water_park", "ice_rink", "amusement_arcade"}),
    ("park", "leisure", {"park", "playground", "garden", "nature_reserve", "dog_park", "sports_centre",
                         "stadium", "pitch", "golf_course", "recreation_ground", "marina", "track"}),
    ("stay", "tourism", {"hotel", "motel", "hostel", "guest_house", "camp_site", "caravan_site"}),
    ("sight", "tourism", {"attraction", "museum", "viewpoint", "zoo", "theme_park", "gallery", "picnic_site"}),
    ("transport", "railway", {"station", "halt"}),
    ("transport", "amenity", {"bus_station", "ferry_terminal"}),
    ("shop", "shop", None),
    ("work", "office", None),
]

_cache = OrderedDict()          # (x, y) -> (expires, [places]); oldest first
_cache_lock = threading.Lock()
_fetch_lock = threading.Lock()  # one question to Overpass at a time


class PlacesError(Exception):
    """Overpass couldn't answer. `busy` = try again later."""

    def __init__(self, message, busy=False):
        super().__init__(message)
        self.busy = busy


# ---- squares (tiles) and their corners ----------------------------------------------
def tile_bounds(x, y, z=GRID_ZOOM):
    """South, west, north, east of square x/y (the usual web-map tile numbers)."""
    n = 2 ** z

    def lat(row):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * row / n))))
    return lat(y + 1), x / n * 360 - 180, lat(y), (x + 1) / n * 360 - 180


def tile_of(lat, lon, z=GRID_ZOOM):
    n = 2 ** z
    lat = max(-85.0511, min(85.0511, lat))
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


# ---- the question to Overpass ----------------------------------------------------------
def _query(south, west, north, east):
    """Overpass QL: every named place of the kinds above, in this box."""
    lines = []
    for _, tag, values in KINDS:
        if values:
            pattern = "|".join(sorted(values))
            lines.append(f'  nwr["name"]["{tag}"~"^({pattern})$"];')
        else:
            lines.append(f'  nwr["name"]["{tag}"];')
    unique = list(dict.fromkeys(lines))   # same line twice is pointless
    box = f"{south:.6f},{west:.6f},{north:.6f},{east:.6f}"
    return f"[out:json][timeout:25][bbox:{box}];\n(\n" + "\n".join(unique) + f"\n);\nout center {MAX_PLACES};"


def _label(value):
    """'fast_food' -> 'Fast food'."""
    text = str(value).replace("_", " ").strip()
    return text[:1].upper() + text[1:]


def classify(tags):
    """Which kind of place this is, and a short label. None if not one we show."""
    for kind, tag, values in KINDS:
        value = tags.get(tag)
        if value and (values is None or value in values):
            if kind == "work" and value in ("yes", "company"):
                return kind, "Business"
            if kind == "shop" and value == "yes":
                return kind, "Shop"
            return kind, _label(value)
    return None


def _place(element):
    """One Overpass element -> the small dict the browser gets (or None)."""
    tags = element.get("tags") or {}
    name = str(tags.get("name", "")).strip()
    found = classify(tags)
    if not name or not found:
        return None
    if "lat" in element and "lon" in element:
        lat, lon = element["lat"], element["lon"]
    else:
        center = element.get("center") or {}
        lat, lon = center.get("lat"), center.get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    kind, label = found
    place = {"id": f"{str(element.get('type', 'x'))[:1]}{int(element.get('id', 0))}",
             "lat": round(lat, 6), "lon": round(lon, 6), "name": name[:100], "kind": kind, "label": label[:40]}
    street = " ".join(str(tags.get(k, "")).strip() for k in ("addr:housenumber", "addr:street")).strip()
    if street:
        place["addr"] = street[:100]
    if tags.get("opening_hours"):
        place["hours"] = str(tags["opening_hours"])[:100]
    return place


def _ask_overpass(south, west, north, east):
    """Send the question. Returns the list of elements."""
    data = urlencode({"data": _query(south, west, north, east)}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data, headers={
        "User-Agent": f"dji-flightmap/{APP_VERSION} (self-hosted flight log map)",
        "Content-Type": "application/x-www-form-urlencoded",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            answer = json.loads(res.read())
    except urllib.error.HTTPError as err:
        # 429 = "too many questions", 504 = "too busy right now".
        busy = err.code in (429, 503, 504)
        raise PlacesError(f"OpenStreetMap (Overpass) answered {err.code}", busy=busy) from None
    except (urllib.error.URLError, OSError, ValueError) as err:
        raise PlacesError(f"could not reach OpenStreetMap (Overpass): {err}") from None
    if not isinstance(answer, dict) or not isinstance(answer.get("elements"), list):
        raise PlacesError("OpenStreetMap (Overpass) sent something unexpected")
    if "remark" in answer and "runtime error" in str(answer["remark"]):
        raise PlacesError("OpenStreetMap (Overpass) is too busy right now", busy=True)
    return answer["elements"]


# ---- remembering squares ----------------------------------------------------------------
def _cache_get(tile):
    with _cache_lock:
        hit = _cache.get(tile)
        if not hit:
            return None
        if hit[0] < time.time():
            del _cache[tile]
            return None
        _cache.move_to_end(tile)   # recently used: forget it last
        return hit[1]


def _cache_put(tile, places):
    with _cache_lock:
        _cache[tile] = (time.time() + CACHE_SECONDS, places)
        _cache.move_to_end(tile)
        while len(_cache) > CACHE_TILES:
            _cache.popitem(last=False)


# ---- the one function the web server calls ---------------------------------------------
def places_in(x0, x1, y0, y1):
    """Places in squares x0..x1, y0..y1 (zoom 15 tile numbers, inclusive).

    Returns {"places": [...], "truncated": bool}. Raises PlacesError.
    """
    tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    found, missing = {}, []
    for tile in tiles:
        hit = _cache_get(tile)
        if hit is None:
            missing.append(tile)
        else:
            found[tile] = hit
    truncated = False
    if missing:
        with _fetch_lock:
            # Another request may have fetched them while we waited.
            still = [t for t in missing if _cache_get(t) is None]
            for tile in missing:
                if tile not in still:
                    found[tile] = _cache_get(tile) or []
            if still:
                fresh, truncated = _fetch(still)
                found.update(fresh)
    places = [p for tile in tiles for p in found.get(tile, [])]
    return {"places": places, "truncated": truncated}


def _fetch(tiles):
    """Ask Overpass for these squares in one go. Returns ({tile: places}, truncated)."""
    xs = [t[0] for t in tiles]
    ys = [t[1] for t in tiles]
    south, west, _, _ = tile_bounds(min(xs), max(ys))
    _, _, north, east = tile_bounds(max(xs), min(ys))
    started = time.time()
    elements = _ask_overpass(south, west, north, east)
    truncated = len(elements) >= MAX_PLACES
    wanted = set(tiles)
    by_tile = {t: [] for t in tiles}
    seen = set()
    for element in elements:
        place = _place(element)
        if not place or place["id"] in seen:
            continue
        tile = tile_of(place["lat"], place["lon"])
        if tile in wanted:
            seen.add(place["id"])
            by_tile[tile].append(place)
    if not truncated:
        # Only remember complete answers: a cut-off answer would leave
        # holes that look like "nothing here" for a week.
        for tile, places in by_tile.items():
            _cache_put(tile, places)
    log(f"Places: {len(seen)} from OpenStreetMap for {len(tiles)} map squares "
        f"in {time.time() - started:.1f} s" + (" (cut off: too many)" if truncated else ""))
    return by_tile, truncated


def parse_range(query):
    """Read x0/x1/y0/y1 from the query string. Returns the four ints or None."""
    try:
        x0, x1, y0, y1 = (int(query.get(k, [""])[0]) for k in ("x0", "x1", "y0", "y1"))
    except ValueError:
        return None
    n = 2 ** GRID_ZOOM
    if not (0 <= x0 <= x1 < n and 0 <= y0 <= y1 < n):
        return None
    if (x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES:
        return None
    return x0, x1, y0, y1

