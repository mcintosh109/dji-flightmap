"""Places from Azure Maps (shops, gas stations, doctors...), for the Azure map.

OpenStreetMap often misses small-town businesses, and Azure's map pictures
show no businesses at all. Azure's Search can list them:
    GET https://atlas.microsoft.com/search/nearby/json?api-version=1.0
(research: "Azure Maps Get Search Nearby"). Each search gives up to 100
places nearest a point.

Things to know (Microsoft Learn, November 2026):
  - This is Search version 1.0. Microsoft calls it "superseded" by Search
    2026-01-01, which has NO business search, but says v1 "continues to
    function", with no end date announced. If Azure ever refuses, the page
    falls back to OpenStreetMap places by itself (places.js).
  - Each search is one billable transaction (after Azure's free monthly
    amount), so there is a DAILY LIMIT (Settings -> Map, default 150). The
    count is saved in azure-places-usage.json, so restarts don't reset it.
  - Azure's terms allow keeping its data for up to six months, so answers
    are remembered on the server (azure-places-cache.json, 30 days): looking
    at the same area again costs nothing. Searches are snapped to a grid
    (about 1 km) so nearby views share one answer.
"""
import json
import os
import threading
import time
from urllib.parse import quote, urlencode

from .config import AZURE_MAPS_URL, STATE_DIR, log
from .settings import current_settings
from .upstream import Upstream

SEARCH = Upstream(AZURE_MAPS_URL, timeout=15)
USAGE_FILE = os.path.join(STATE_DIR, "azure-places-usage.json")
CACHE_FILE = os.path.join(STATE_DIR, "azure-places-cache.json")
CACHE_DAYS = 30
CACHE_MAX = 2000           # areas remembered (oldest are dropped)
GRID = 0.01                # degrees: searches are snapped to this grid (~1 km)
RADII = (1000, 2000, 5000)  # metres: the search sizes used
LIMIT = 100                # places per search (Azure's most)
_lock = threading.Lock()
_cache = None              # {"lat,lon,radius": {"at": time, "places": [...]}}

# Azure's classification code (e.g. "PETROL_STATION") -> our kind (the same
# kinds and icons as the other places). A single word matches a whole word
# of the code; a word_with_underscore matches anywhere. Checked in order.
KIND_RULES = [
    ("air", ("AIRPORT", "HELIPAD", "AIRFIELD")),
    ("car", ("PETROL", "FUEL", "ELECTRIC_VEHICLE", "REPAIR", "CAR_WASH", "AUTOMOTIVE", "RENT_A_CAR",
             "TRUCK_STOP", "PARKING", "MOTORING")),
    ("health", ("HOSPITAL", "POLYCLINIC", "DOCTOR", "DENTIST", "PHARMACY", "HEALTH", "MEDICAL",
                "VETERINARIAN", "CLINIC", "EMERGENCY_MEDICAL")),
    ("school", ("SCHOOL", "COLLEGE", "UNIVERSITY", "LIBRARY", "EDUCATION", "CHILD_CARE", "KINDERGARTEN")),
    ("food", ("RESTAURANT", "CAFE", "PUB", "BAR", "FAST_FOOD", "BAKERY", "COFFEE")),
    ("worship", ("WORSHIP", "CHURCH", "MOSQUE", "SYNAGOGUE", "TEMPLE")),
    ("public", ("POLICE", "FIRE_STATION", "GOVERNMENT", "CITY_HALL", "COURTHOUSE", "POST_OFFICE", "BANK",
                "ATM", "CEMETERY", "COMMUNITY", "EMBASSY", "WELFARE", "PRISON")),
    ("stay", ("HOTEL", "MOTEL", "HOSTEL", "LODGING", "RESORT", "CAMPING")),
    ("park", ("PARK", "SPORTS", "SPORT", "STADIUM", "GOLF", "BEACH", "MARINA", "TRAIL", "RECREATION",
              "SWIMMING", "ICE_SKATING")),
    ("sight", ("TOURIST", "MUSEUM", "ZOO", "ZOOS", "MONUMENT", "HISTORIC", "SCENIC", "LANDMARK", "GALLERY")),
    ("fun", ("CINEMA", "THEATER", "CASINO", "NIGHTLIFE", "AMUSEMENT", "BOWLING", "ENTERTAINMENT",
             "FITNESS", "GYM")),
    ("transport", ("RAILWAY", "BUS_STATION", "FERRY", "PUBLIC_TRANSPORT", "METRO")),
    ("shop", ("SHOP", "STORE", "MARKET", "MALL", "SUPERMARKETS", "RETAIL", "FLORIST", "SHOPPING")),
]


class LimitReached(Exception):
    pass


def kind_of(code):
    code = str(code or "").upper()
    words = set(code.split("_"))
    for kind, patterns in KIND_RULES:
        if any((p in code) if "_" in p else (p in words) for p in patterns):
            return kind
    return "work"   # any other business


def snap(lat, lon, radius):
    """The grid point and search size used for a view, so nearby views share
    one (remembered) answer."""
    size = next((r for r in RADII if radius <= r), RADII[-1])
    return round(round(lat / GRID) * GRID, 4), round(round(lon / GRID) * GRID, 4), size


# ---- the daily count ---------------------------------------------------------------------
def _today():
    return time.strftime("%Y-%m-%d")


def usage():
    """{"used": n, "limit": n} for today."""
    limit = int(current_settings().get("azurePlacesDailyLimit", 150))
    try:
        with open(USAGE_FILE, encoding="utf-8") as fh:
            saved = json.load(fh)
        used = int(saved.get("count", 0)) if saved.get("day") == _today() else 0
    except (OSError, ValueError, AttributeError, TypeError):
        used = 0
    return {"used": used, "limit": limit}


def _count_one():
    """Count one search, or raise LimitReached. (Called with _lock held.)"""
    now = usage()
    if now["used"] >= now["limit"]:
        raise LimitReached()
    _write(USAGE_FILE, {"day": _today(), "count": now["used"] + 1})


def _write(path, data):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


# ---- remembered answers -----------------------------------------------------------------------
def _load_cache():
    global _cache
    if _cache is None:
        try:
            with open(CACHE_FILE, encoding="utf-8") as fh:
                _cache = json.load(fh)
            if not isinstance(_cache, dict):
                _cache = {}
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _remembered(key):
    entry = _load_cache().get(key)
    if isinstance(entry, dict) and time.time() - entry.get("at", 0) < CACHE_DAYS * 86400:
        return entry.get("places")
    return None


def _remember(key, places):
    cache = _load_cache()
    cache[key] = {"at": time.time(), "places": places}
    if len(cache) > CACHE_MAX:
        for old in sorted(cache, key=lambda k: cache[k].get("at", 0))[:len(cache) - CACHE_MAX]:
            del cache[old]
    try:
        _write(CACHE_FILE, cache)
    except OSError as err:
        log(f"Azure places: could not save the remembered places: {err}")


# ---- one search ---------------------------------------------------------------------------
def search(lat, lon, radius):
    """Up to 100 places near (lat, lon). Returns (answer dict, HTTP status)."""
    settings = current_settings()
    key = settings.get("azureMapsKey", "")
    if settings.get("mapProvider") != "azure" or not key:
        return {"error": "Azure places are only used with the Azure Maps provider and a saved key"}, 400
    if int(settings.get("azurePlacesDailyLimit", 150)) <= 0:
        return {"error": "Azure places are turned off in Settings (daily limit 0)", "off": True}, 403
    lat, lon, size = snap(lat, lon, radius)
    cache_key = f"{lat},{lon},{size}"
    with _lock:
        places = _remembered(cache_key)
        if places is not None:
            return {"places": places, "remembered": True, **usage()}, 200
        try:
            _count_one()
        except LimitReached:
            return {"error": "today's limit of Azure places searches is used up", "limit": True, **usage()}, 429
        except OSError as err:
            log(f"Azure places: could not save today's count: {err}")
            return {"error": "could not save the daily count"}, 500
    query = urlencode({"api-version": "1.0", "lat": lat, "lon": lon, "radius": size, "limit": LIMIT,
                       "language": "en-US", "subscription-key": key}, quote_via=quote)
    try:
        status, _, answer, _ = SEARCH.request("GET", f"/search/nearby/json?{query}")
    except OSError as err:
        log(f"Azure places: could not reach Azure Maps: {err}")
        return {"error": "could not reach Azure Maps", **usage()}, 502
    if status != 200:
        log(f"Azure places: Azure Maps answered {status} (Search v1 'nearby'). If this keeps happening, "
            "Microsoft may have switched the old search off; the map then shows OpenStreetMap places.")
        return {"error": f"Azure Maps answered {status}", **usage()}, 502
    try:
        found = json.loads(answer).get("results") or []
    except ValueError:
        found = []
    places = [p for p in (_place(r) for r in found) if p]
    with _lock:
        _remember(cache_key, places)
    return {"places": places, **usage()}, 200


def _place(r):
    if not isinstance(r, dict):
        return None
    poi = r.get("poi") or {}
    pos = r.get("position") or {}
    lat, lon = pos.get("lat"), pos.get("lon")
    name = str(poi.get("name", "")).strip()
    if not name or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    classes = poi.get("classifications") or [{}]
    code = str((classes[0] or {}).get("code", ""))
    names = (classes[0] or {}).get("names") or [{}]
    label = str((names[0] or {}).get("name", "") or "Place").strip()
    place = {"id": "a:" + str(r.get("id", ""))[:100], "lat": round(lat, 6), "lon": round(lon, 6),
             "name": name[:100], "kind": kind_of(code), "label": (label[:1].upper() + label[1:])[:40]}
    addr = r.get("address") or {}
    street = " ".join(str(addr.get(k, "")) for k in ("streetNumber", "streetName")).strip()
    town = str(addr.get("municipality", "")).split(",")[0].strip()
    if street or town:
        place["addr"] = ", ".join(x for x in (street, town) if x)[:100]
    return place
