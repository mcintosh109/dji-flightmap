"""The settings page's values: defaults, checking, loading and saving.

Saved in settings.json (readable only by the service: it may hold map keys).
"""
import json
import os
import re
import threading

from .config import SCAN_SECONDS, SESSION_DAYS, SETTINGS_FILE, log

# Map providers and layers the page knows (see PROVIDERS in static/maps.js).
MAP_PROVIDERS = {"free", "carto", "azure", "google", "mapbox", "maptiler", "custom"}
MAP_LAYERS = {"road", "satellite", "dark", "terrain"}
# Older versions saved one "mapStyle"; this turns it into provider + layer
# (+ whether "Details" was part of it).
OLD_MAP_STYLES = {
    "osm-dark": ("free", "dark", None), "osm": ("free", "road", None),
    "esri-satellite": ("free", "satellite", None),
    "carto-dark": ("carto", "dark", None), "carto-light": ("carto", "road", None),
    "mapbox-satellite": ("mapbox", "satellite", True), "mapbox-dark": ("mapbox", "dark", None),
    "mapbox-outdoors": ("mapbox", "terrain", None),
    "maptiler-hybrid": ("maptiler", "satellite", True), "maptiler-satellite": ("maptiler", "satellite", False),
    "maptiler-streets": ("maptiler", "road", None), "maptiler-outdoor": ("maptiler", "terrain", None),
    "azure-road": ("azure", "road", None), "azure-dark": ("azure", "dark", None),
    "azure-satellite": ("azure", "satellite", False), "azure-hybrid": ("azure", "satellite", True),
    "custom": ("custom", "road", None),
}
DEFAULT_SETTINGS = {
    # Map
    "mapProvider": "free",
    "mapLayer": "dark",
    "satelliteLabels": True,
    "cartoKey": "",
    "mapboxToken": "",
    "maptilerKey": "",
    "azureMapsKey": "",
    "googleMapsKey": "",
    "googlePlacesDailyLimit": 150,   # Google places searches a day (0 = off); ~4,500 a month
    "customTileUrl": "",
    "customTileName": "Custom map",
    "customAttribution": "",
    # Display
    "units": "imperial",
    "pathColor": "#36c2ff",
    "playbackSpeed": 5,
    "openAt": "last",
    "navApp": "google",
    "showAllPaths": True,
    "focusSelected": True,
    # Flight planner limits (metres, metres, percent, metres per second)
    "plannerMaxHeight": 122,      # 400 ft
    "plannerMaxDistance": 500,    # beyond this it's hard to keep the drone in sight
    "plannerReserve": 25,         # land with at least this much battery
    "plannerWindLimit": 10,       # Mini 4 Pro handles about 10.7 m/s (level 5)
    # Flights
    "minFlightSeconds": 0,
    "hideNoGps": False,
    "aircraftNames": {},
    # Server
    "scanSeconds": SCAN_SECONDS,
    "sessionDays": SESSION_DAYS,
    "checkUpdates": True,
}
SETTINGS = dict(DEFAULT_SETTINGS)
SETTINGS_LOCK = threading.Lock()
KEY_RE = re.compile(r"^[A-Za-z0-9._-]{0,300}$")
SERIAL_RE = re.compile(r"^[A-Za-z0-9]{1,64}$")


def clean_settings(incoming):
    """Check values sent by the settings page.

    Returns (new settings, list of problems). Unknown names are ignored;
    anything missing keeps its current value.
    """
    problems = []
    with SETTINGS_LOCK:
        new = dict(SETTINGS)

    def pick(name, check, message):
        if name not in incoming:
            return
        value = incoming[name]
        try:
            ok = check(value)
        except Exception:
            ok = False
        if ok:
            new[name] = value
        else:
            problems.append(message)

    def whole(lo, hi):
        return lambda v: isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi

    is_bool = lambda v: isinstance(v, bool)
    plain = lambda n: (lambda v: isinstance(v, str) and len(v) <= n and not re.search(r"[<>\"\\\x00-\x1f]", v))

    pick("mapProvider", lambda v: v in MAP_PROVIDERS, "Unknown map provider.")
    pick("mapLayer", lambda v: v in MAP_LAYERS, "Unknown map layer.")
    pick("satelliteLabels", is_bool, "Satellite labels must be on or off.")
    pick("cartoKey", lambda v: isinstance(v, str) and KEY_RE.match(v.strip()),
         "The CARTO key can only contain letters, numbers, dots, dashes and underscores.")
    pick("mapboxToken", lambda v: isinstance(v, str) and KEY_RE.match(v.strip()),
         "The Mapbox token can only contain letters, numbers, dots, dashes and underscores.")
    pick("maptilerKey", lambda v: isinstance(v, str) and KEY_RE.match(v.strip()),
         "The MapTiler key can only contain letters, numbers, dots, dashes and underscores.")
    pick("azureMapsKey", lambda v: isinstance(v, str) and KEY_RE.match(v.strip()),
         "The Azure Maps key can only contain letters, numbers, dots, dashes and underscores.")
    pick("googleMapsKey", lambda v: isinstance(v, str) and KEY_RE.match(v.strip()),
         "The Google Maps key can only contain letters, numbers, dots, dashes and underscores.")
    pick("googlePlacesDailyLimit", whole(0, 5000), "Google places searches a day must be 0 to 5000.")
    pick("customTileUrl", lambda v: isinstance(v, str) and (v == "" or (
        len(v) <= 500 and re.match(r"^https?://[^\s<>\"']+$", v)
        and all(part in v for part in ("{z}", "{x}", "{y}")))),
         "The custom map address must start with https:// and contain {z}, {x} and {y}.")
    pick("customTileName", plain(40), "The custom map name is too long or has odd characters.")
    pick("customAttribution", plain(200), "The custom map credit line is too long or has odd characters.")
    pick("units", lambda v: v in ("imperial", "metric"), "Units must be imperial or metric.")
    pick("pathColor", lambda v: isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v),
         "The path colour must look like #36c2ff.")
    pick("playbackSpeed", lambda v: v in (1, 2, 5, 10, 25), "Unknown replay speed.")
    pick("openAt", lambda v: v in ("last", "start"), "Unknown start position.")
    pick("navApp", lambda v: v in ("google", "apple", "waze"), "Unknown navigation app.")
    pick("showAllPaths", is_bool, "Show all paths must be on or off.")
    pick("focusSelected", is_bool, "Hide other flights must be on or off.")
    pick("plannerMaxHeight", whole(10, 500), "Height limit must be 10 to 500 metres.")
    pick("plannerMaxDistance", whole(50, 20000), "Distance warning must be 50 to 20000 metres.")
    pick("plannerReserve", whole(5, 60), "Battery reserve must be 5 to 60 percent.")
    pick("plannerWindLimit", whole(3, 25), "Wind limit must be 3 to 25 m/s.")
    pick("minFlightSeconds", whole(0, 3600), "Shortest flight must be 0 to 3600 seconds.")
    pick("hideNoGps", is_bool, "Hide flights without GPS must be on or off.")
    pick("aircraftNames", lambda v: isinstance(v, dict) and len(v) <= 50 and all(
        isinstance(k, str) and SERIAL_RE.match(k) and plain(40)(n) for k, n in v.items()),
         "Aircraft nicknames can be up to 40 characters.")
    pick("scanSeconds", whole(5, 3600), "Check for new files every 5 to 3600 seconds.")
    pick("sessionDays", whole(1, 365), "Stay signed in for 1 to 365 days.")
    pick("checkUpdates", is_bool, "Check for updates must be on or off.")

    for key in ("cartoKey", "mapboxToken", "maptilerKey", "azureMapsKey", "googleMapsKey",
                "customTileName", "customAttribution"):
        new[key] = new[key].strip()
    new["aircraftNames"] = {k: n.strip() for k, n in new["aircraftNames"].items() if n.strip()}
    return new, problems


def load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as fh:
            saved = json.load(fh)
    except FileNotFoundError:
        return
    except Exception as exc:
        log(f"Ignoring broken settings file {SETTINGS_FILE}: {exc}")
        return
    if not isinstance(saved, dict):
        saved = {}
    if "mapProvider" not in saved and saved.get("mapStyle") in OLD_MAP_STYLES:
        provider, layer, details = OLD_MAP_STYLES[saved["mapStyle"]]
        saved.update(mapProvider=provider, mapLayer=layer)
        if details is not None:
            saved["satelliteLabels"] = details
        log(f"Settings: map style '{saved['mapStyle']}' is now provider '{provider}', layer '{layer}'")
    migrated = "mapStyle" in saved and "mapProvider" in saved and saved.get("mapStyle") is not None
    new, problems = clean_settings(saved)
    for problem in problems:
        log(f"Settings file: {problem} (using the default instead)")
    with SETTINGS_LOCK:
        SETTINGS.update(new)
    if migrated:
        try:
            save_settings(new)   # write the new format once, without the old "mapStyle"
        except OSError as exc:
            log(f"Could not save the converted settings: {exc}")


def save_settings(new):
    """Write settings.json (only root and the service can read it: it may hold API keys)."""
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(new, fh, indent=2)
    os.replace(tmp, SETTINGS_FILE)
    with SETTINGS_LOCK:
        SETTINGS.clear()
        SETTINGS.update(new)


def current_settings():
    with SETTINGS_LOCK:
        return json.loads(json.dumps(SETTINGS))   # a copy


# Keys that stay on the server: the page only learns whether one is saved.
SERVER_ONLY_KEYS = ("azureMapsKey", "googleMapsKey")


def public_settings():
    """Settings as sent to the browser: server-only keys replaced by
    "<name>Set": true/false, so the key itself never leaves the server."""
    settings = current_settings()
    for key in SERVER_ONLY_KEYS:
        settings[key + "Set"] = bool(settings.pop(key, ""))
    return settings
