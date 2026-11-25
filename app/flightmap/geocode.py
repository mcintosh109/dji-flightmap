"""Address search: type an address (or a town, a landmark) and get the places
on the map that match it, so the map can go there for planning.

Where the answers come from:
  - With the Azure Maps provider and a saved key: Azure's "Get Geocoding"
        GET https://atlas.microsoft.com/geocode?api-version=2026-01-01&query=...
    (research: "Azure Maps Get Geocoding"). It is the current Search API
    (not the old v1 that Azure places use). Each search is one billable
    transaction after Azure's free monthly amount, so there is a daily limit
    (DAILY_LIMIT). It knows streets, towns and counties, but hardly any
    named places: Microsoft says it returns no "points of interest". So
    Azure's place search is asked too (the old Search v1 "Get Search POI",
    the same family the Azure places on the map use, and it knew a waterfall
    the address search didn't), and OpenStreetMap as well. The lists are put
    together, best match first (see _merge). One search counts once towards
    the daily limit, though it is two Azure requests.
  - Always: OpenStreetMap's free Nominatim server
        GET https://nominatim.openstreetmap.org/search?q=...&format=jsonv2
    (research: "Nominatim usage policy"). Its rules (as found in Nov 2026;
    the policy page itself was not reachable from Claude's sandbox): at most
    1 search per second in total, a User-Agent that names the app (a stock
    one is refused), light use with answers remembered, and the credit
    "© OpenStreetMap contributors". So the page only searches when Enter is
    pressed (no search-as-you-type), this server leaves at least 1 second
    between searches, and answers are remembered.
  - Google is not used: the owner's Google key is kept to Map Tiles and
    Places, and OpenStreetMap's data may be shown on any map.

Answers are remembered in memory for a day (both companies allow it), so
searching the same thing again costs nothing.
"""
import json
import os
import re
import threading
import time
from urllib.parse import quote, urlencode

from .config import APP_VERSION, AZURE_MAPS_URL, STATE_DIR, log
from .settings import current_settings
from .upstream import Upstream

NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org").rstrip("/")
AZURE = Upstream(AZURE_MAPS_URL, timeout=10)
OSM = Upstream(NOMINATIM_URL, timeout=10)
USER_AGENT = f"dji-flightmap/{APP_VERSION} (self-hosted flight log map)"
USAGE_FILE = os.path.join(STATE_DIR, "azure-geocode-usage.json")
DAILY_LIMIT = 200          # Azure address searches a day (then OpenStreetMap is asked)
TOP = 5                    # answers per search, from each company
SHOWN = 8                  # answers shown, both companies together
MAX_QUERY = 200            # characters
REMEMBER_S = 24 * 3600
REMEMBER_MAX = 300
OSM_GAP_S = 1.1            # Nominatim: at most 1 search per second

_lock = threading.Lock()           # the remembered answers and the daily count
_osm_lock = threading.Lock()       # one Nominatim search at a time
_osm_last = 0.0
_remembered = {}                   # key -> (time, answer)


def search(query, lat=None, lon=None):
    """Up to 8 places matching `query`. lat/lon (the middle of the map) make
    nearby answers come first. Returns (answer dict, HTTP status)."""
    query = " ".join(str(query or "").split())[:MAX_QUERY]
    if len(query) < 3:
        return {"error": "type at least 3 letters"}, 400
    near = None
    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
        near = (round(lat, 1), round(lon, 1))      # ~10 km: nearby views share an answer
    settings = current_settings()
    use_azure = settings.get("mapProvider") == "azure" and bool(settings.get("azureMapsKey"))
    key = f"{'azure' if use_azure else 'osm'}|{query.lower()}|{near}"
    with _lock:
        hit = _remembered.get(key)
        if hit and time.time() - hit[0] < REMEMBER_S:
            return dict(hit[1], remembered=True), 200
    azure, osm, note, complete = None, None, "", True
    if use_azure:
        try:
            azure = _azure(query, near, settings["azureMapsKey"])
        except _Skip as why:
            note, complete = str(why), False
            log(f"Address search: {why}; only OpenStreetMap is asked")
        if azure is not None:
            try:
                azure = _azure_places(query, near, settings["azureMapsKey"]) + azure
            except _Skip as why:
                complete = False          # Search v1 may be switched off one day: the rest still works
                log(f"Address search: Azure's place search: {why}")
    try:
        osm = _osm(query, near)
    except _Skip as why:
        log(f"Address search: {why}")
        if azure is None:
            return {"error": f"the address search is not available right now ({why})"}, 502
        complete = False
    answer = {"results": _merge(query, azure or [], osm or []),
              "source": "+".join(name for name, got in (("azure", azure), ("osm", osm)) if got is not None)}
    if note:
        answer["note"] = note
    if not complete:
        # Something didn't answer: not remembered, so it is asked again next time.
        return answer, 200
    with _lock:
        _remembered[key] = (time.time(), answer)
        if len(_remembered) > REMEMBER_MAX:
            for old in sorted(_remembered, key=lambda k: _remembered[k][0])[:len(_remembered) - REMEMBER_MAX]:
                del _remembered[old]
    return answer, 200


class _Skip(Exception):
    """This source can't answer now (the reason is the message)."""


# ---- Azure Maps -------------------------------------------------------------------------------
def _azure(query, near, key):
    with _lock:
        _count_one()
    params = {"api-version": "2026-01-01", "query": query, "top": TOP, "subscription-key": key}
    if near:
        params["coordinates"] = f"{near[1]},{near[0]}"     # Azure wants longitude first
    try:
        status, _, body, _ = AZURE.request("GET", "/geocode?" + urlencode(params, quote_via=quote),
                                           headers={"Accept-Language": "en-US"})
    except OSError:
        raise _Skip("could not reach Azure Maps") from None
    if status != 200:
        raise _Skip(f"Azure Maps answered {status}")
    try:
        features = json.loads(body).get("features") or []
    except (ValueError, AttributeError):
        raise _Skip("Azure Maps sent something unexpected") from None
    results = [r for r in (_azure_result(f) for f in features) if r]
    return results[:TOP]


def _azure_result(feature):
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) < 2 or not all(isinstance(c, (int, float)) for c in coords[:2]):
        return None
    addr = props.get("address") or {}
    name = str(addr.get("formattedAddress") or addr.get("addressLine") or addr.get("locality") or "").strip()
    if not name:
        return None
    country = str((addr.get("countryRegion") or {}).get("name", "")).strip()
    result = {"name": name[:150], "detail": _kind(props.get("type")), "lat": round(coords[1], 6),
              "lon": round(coords[0], 6), "from": "azure"}
    if country and country not in name:
        result["detail"] = ", ".join(x for x in (result["detail"], country) if x)
    box = feature.get("bbox")
    if isinstance(box, list) and len(box) == 4 and all(isinstance(c, (int, float)) for c in box):
        result["box"] = [round(box[1], 6), round(box[0], 6), round(box[3], 6), round(box[2], 6)]   # S, W, N, E
    return result


def _azure_places(query, near, key):
    """Named places (a waterfall, a park, a shop) from Azure's Search v1 "Get Search POI"."""
    params = {"api-version": "1.0", "query": query, "limit": TOP, "language": "en-US", "subscription-key": key}
    if near:
        params.update(lat=near[0], lon=near[1])      # answers near the map's middle first
    try:
        status, _, body, _ = AZURE.request("GET", "/search/poi/json?" + urlencode(params, quote_via=quote))
    except OSError:
        raise _Skip("could not reach Azure Maps") from None
    if status != 200:
        raise _Skip(f"Azure Maps answered {status}")
    try:
        found = json.loads(body).get("results") or []
    except (ValueError, AttributeError):
        raise _Skip("Azure Maps sent something unexpected") from None
    return [r for r in (_azure_place(p) for p in found) if r][:TOP]


def _azure_place(r):
    if not isinstance(r, dict):
        return None
    poi, pos, addr = r.get("poi") or {}, r.get("position") or {}, r.get("address") or {}
    lat, lon = pos.get("lat"), pos.get("lon")
    name = str(poi.get("name", "")).strip()
    if not name or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    where = str(addr.get("freeformAddress") or addr.get("municipality") or "").strip()
    classes = poi.get("classifications") or [{}]
    label = str(((classes[0] or {}).get("names") or [{}])[0].get("name", "") or "Place").strip()
    result = {"name": (f"{name}, {where}" if where else name)[:150], "detail": (label[:1].upper() + label[1:])[:40],
              "lat": round(lat, 6), "lon": round(lon, 6), "from": "azure"}
    view = r.get("viewport") or {}
    try:
        top, bottom = view["topLeftPoint"], view["btmRightPoint"]
        result["box"] = [round(float(bottom["lat"]), 6), round(float(top["lon"]), 6),
                         round(float(top["lat"]), 6), round(float(bottom["lon"]), 6)]   # S, W, N, E
    except (KeyError, TypeError, ValueError):
        pass
    return result


AZURE_KINDS = {"Address": "Address", "RoadBlock": "Street", "RoadIntersection": "Crossroads",
               "Neighborhood": "Neighborhood", "PopulatedPlace": "Town or city", "Postcode1": "Postal code",
               "AdminDivision1": "State or region", "AdminDivision2": "County", "CountryRegion": "Country",
               "PointOfInterest": "Place", "LandmarkBuilding": "Landmark"}


def _kind(code):
    return AZURE_KINDS.get(str(code or ""), "")


def _today():
    return time.strftime("%Y-%m-%d")


def _count_one():
    """Count one Azure search, or skip Azure when today's limit is used. (Called with _lock held.)"""
    try:
        with open(USAGE_FILE, encoding="utf-8") as fh:
            saved = json.load(fh)
        used = int(saved.get("count", 0)) if saved.get("day") == _today() else 0
    except (OSError, ValueError, AttributeError, TypeError):
        used = 0
    if used >= DAILY_LIMIT:
        raise _Skip(f"today's {DAILY_LIMIT} Azure address searches are used up")
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = USAGE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"day": _today(), "count": used + 1}, fh)
        os.replace(tmp, USAGE_FILE)
    except OSError as err:
        raise _Skip(f"could not save today's count of Azure searches: {err}") from None


# ---- OpenStreetMap (Nominatim) -------------------------------------------------------------------
def _osm(query, near):
    global _osm_last
    params = {"q": query, "format": "jsonv2", "limit": TOP, "addressdetails": 0}
    if near:
        # Prefer (not limit to) an area about 100 km around the map's middle.
        lat, lon = near
        params["viewbox"] = f"{lon - 1},{lat + 1},{lon + 1},{lat - 1}"
    with _osm_lock:
        wait = _osm_last + OSM_GAP_S - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            status, _, body, _ = OSM.request("GET", "/search?" + urlencode(params, quote_via=quote),
                                             headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
        except OSError:
            raise _Skip("could not reach OpenStreetMap") from None
        finally:
            _osm_last = time.monotonic()
    if status != 200:
        raise _Skip(f"OpenStreetMap answered {status}" + (" (too many searches, wait a minute)" if status == 429 else ""))
    try:
        found = json.loads(body)
    except ValueError:
        raise _Skip("OpenStreetMap sent something unexpected") from None
    results = [r for r in (_osm_result(p) for p in (found if isinstance(found, list) else [])) if r]
    return results[:TOP]


def _osm_result(place):
    if not isinstance(place, dict):
        return None
    try:
        lat, lon = float(place["lat"]), float(place["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    name = str(place.get("display_name", "")).strip()
    if not name:
        return None
    result = {"name": name[:150], "detail": osm_kind(place), "lat": round(lat, 6), "lon": round(lon, 6),
              "from": "osm"}
    box = place.get("boundingbox")
    try:
        s, n, w, e = (float(x) for x in box)
        result["box"] = [round(s, 6), round(w, 6), round(n, 6), round(e, 6)]   # S, W, N, E
    except (TypeError, ValueError):
        pass
    return result


# OpenStreetMap describes a place with two words, its "category" and "type"
# (research: "OpenStreetMap map features"), e.g. highway + tertiary for a
# minor road. These turn them into plain words. Checked in this order:
# (category, type), then the type alone, then the category alone.
OSM_WORDS = {
    ("highway", "path"): "Trail or path", ("highway", "footway"): "Trail or path",
    ("highway", "bridleway"): "Trail or path", ("highway", "cycleway"): "Bike path",
    ("highway", "track"): "Dirt road", ("highway", "motorway"): "Highway", ("highway", "trunk"): "Highway",
    ("highway", "bus_stop"): "Bus stop",
    ("place", "city"): "Town or city", ("place", "town"): "Town or city", ("place", "village"): "Village",
    ("place", "hamlet"): "Village", ("place", "suburb"): "Neighborhood", ("place", "neighbourhood"): "Neighborhood",
    ("place", "quarter"): "Neighborhood", ("place", "county"): "County", ("place", "state"): "State or region",
    ("place", "country"): "Country", ("place", "house"): "Address", ("place", "locality"): "Place",
    ("boundary", "national_park"): "National park", ("boundary", "protected_area"): "Park or forest",
    ("waterway", "river"): "River", ("waterway", "stream"): "Stream", ("waterway", "dam"): "Dam",
    ("tourism", "attraction"): "Attraction",
}
OSM_TYPE_WORDS = {
    "waterfall": "Waterfall", "peak": "Mountain top", "water": "Lake or pond", "lake": "Lake or pond",
    "reservoir": "Lake or pond", "wood": "Woods", "forest": "Forest", "beach": "Beach", "cliff": "Cliff",
    "spring": "Spring", "viewpoint": "Viewpoint", "camp_site": "Campground", "picnic_site": "Picnic area",
    "park": "Park", "nature_reserve": "Nature reserve", "slipway": "Boat ramp", "parking": "Parking",
    "trailhead": "Trailhead", "golf_course": "Golf course", "pitch": "Sports field", "playground": "Playground",
    "house": "Address", "postcode": "Postal code", "administrative": "Area", "bridge": "Bridge",
}
OSM_CATEGORY_WORDS = {
    "highway": "Road", "building": "Building", "tourism": "Tourist spot", "natural": "Nature",
    "leisure": "Park or leisure", "waterway": "River or stream", "railway": "Railway", "aeroway": "Airport",
    "shop": "Shop", "office": "Office", "landuse": "Area", "boundary": "Area", "historic": "Historic site",
}
OSM_LEVELS = {"county": "County", "state": "State or region", "country": "Country", "city": "Town or city",
              "town": "Town or city", "village": "Village", "hamlet": "Village"}


def osm_kind(place):
    """Plain words for what an OpenStreetMap answer is ("Road", "Waterfall"...)."""
    category = str(place.get("category") or place.get("class") or "")
    kind = str(place.get("type") or "")
    level = str(place.get("addresstype") or "")
    if category == "boundary" and kind == "administrative" and level in OSM_LEVELS:
        return OSM_LEVELS[level]            # a county's or a town's border: say which
    words = (OSM_WORDS.get((category, kind)) or OSM_TYPE_WORDS.get(kind) or OSM_CATEGORY_WORDS.get(category)
             or OSM_LEVELS.get(level) or OSM_TYPE_WORDS.get(level))
    if words:
        return words
    other = (kind if kind not in ("", "yes") else level).replace("_", " ")   # something else: its own word
    return other[:1].upper() + other[1:40]


# ---- both lists together ---------------------------------------------------------------------------
def _words(text):
    """The words of a name or a search, in small letters: "FS 12, Springfield" -> {"fs", "12", "springfield"}."""
    return {w for w in re.split(r"[^0-9a-z]+", str(text).lower()) if len(w) >= 2}


ROAD_KINDS = {"Road", "Street", "Highway", "Dirt road", "Crossroads", "Bike path"}
ROAD_WORDS = {"road", "rd", "street", "st", "avenue", "ave", "highway", "hwy", "lane", "ln", "drive", "dr", "route",
              "rte", "fs", "way", "blvd", "boulevard", "parkway", "pkwy", "court", "ct", "circle", "cir", "pike",
              "trail", "tr", "loop", "us", "sr", "cr", "interstate"}


def _merge(query, azure, osm):
    """Azure's answers, then OpenStreetMap's, best match first:
      1. more of the searched words in the name ("Bow Bridge" before "Bridge County"),
      2. then a name that is exactly what was typed,
      3. then roads last, unless a road word was typed: "Bow Bridge" is
         the bridge, not "Bow Bridge Road" (the owner searched for a
         waterfall and the road named after it came first).
    Equal ones keep their order (each company lists its best first). The
    same place from both companies is shown once."""
    wanted = _words(query)
    roads_wanted = bool(wanted & ROAD_WORDS)
    shown = []
    for r in azure + osm:
        first = _words(r["name"].split(",")[0])
        if any(_close(r, o) and first == _words(o["name"].split(",")[0]) for o in shown):
            continue
        shown.append(r)
    def rank(r):
        exact = _words(r["name"].split(",")[0]) == wanted
        road = not roads_wanted and r.get("detail", "").split(",")[0] in ROAD_KINDS
        return (-len(wanted & _words(r["name"])), not exact, road)
    shown.sort(key=rank)   # sort() keeps equal ones in order
    return shown[:SHOWN]


def _close(a, b):
    """Within about 50 m."""
    return abs(a["lat"] - b["lat"]) < 0.0005 and abs(a["lon"] - b["lon"]) < 0.0005
