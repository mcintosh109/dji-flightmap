"""Places from Google (shops, gas stations, doctors...), for the Google map.

Google's map pictures only show some places. The Google Maps app gets the
rest from Google's Places service, and so does this file:
    POST https://places.googleapis.com/v1/places:searchNearby
(research: "Places API (New) Nearby Search"). Each search gives the 20
places closest to the middle of the screen.

Rules that shape this file:
  - Google charges per search after a free amount each month, so there is
    a DAILY LIMIT (Settings -> Map, default 150, about 4,500 a month).
    The count is saved in google-places-usage.json, so restarts don't reset it.
  - Only "Pro" fields are asked for (name, place, type, short address, link).
    Ratings or opening hours would move every search to a dearer price.
  - Google's place data may only be shown on a Google map, so this is only
    used when Google Maps is the map provider.
  - Nothing is stored on the server; the browser keeps the pins only while
    the page is open.
"""
import json
import os
import threading
import time

from .config import GOOGLE_PLACES_URL, STATE_DIR, log
from .settings import current_settings
from .upstream import Upstream

PLACES = Upstream(GOOGLE_PLACES_URL, timeout=15)
USAGE_FILE = os.path.join(STATE_DIR, "google-places-usage.json")
FIELDS = ",".join(f"places.{f}" for f in (
    "id", "displayName", "location", "primaryType", "primaryTypeDisplayName",
    "shortFormattedAddress", "googleMapsUri"))
MIN_RADIUS, MAX_RADIUS = 50, 2000   # metres
_lock = threading.Lock()

# Google place type -> our kind (the same kinds and icons as the
# OpenStreetMap places). Checked in order; a type can also just END with
# one of these (e.g. "hardware_store" -> "store").
TYPE_KINDS = [
    ("air", ("airport", "heliport", "airstrip")),
    ("car", ("gas_station", "car_repair", "car_wash", "car_dealer", "electric_vehicle_charging_station",
             "auto_parts_store", "tire_shop")),
    ("health", ("hospital", "doctor", "dentist", "pharmacy", "drugstore", "medical_clinic", "medical_lab",
                "physiotherapist", "chiropractor", "veterinary_care")),
    ("school", ("school", "primary_school", "secondary_school", "university", "preschool", "library",
                "child_care_agency")),
    ("food", ("restaurant", "cafe", "bar", "bakery", "coffee_shop", "meal_takeaway", "meal_delivery",
              "ice_cream_shop", "food_court", "pub", "diner")),
    ("worship", ("church", "place_of_worship", "mosque", "synagogue", "hindu_temple")),
    ("public", ("city_hall", "post_office", "police", "fire_station", "courthouse", "local_government_office",
                "bank", "atm", "community_center", "government_office", "cemetery")),
    ("park", ("park", "playground", "dog_park", "golf_course", "stadium", "sports_complex", "campground",
              "national_park", "marina", "athletic_field")),
    ("stay", ("lodging", "hotel", "motel", "inn", "bed_and_breakfast", "rv_park")),
    ("sight", ("tourist_attraction", "museum", "zoo", "art_gallery", "historical_landmark")),
    ("fun", ("movie_theater", "gym", "fitness_center", "bowling_alley", "night_club", "casino")),
    ("transport", ("train_station", "bus_station", "transit_station", "ferry_terminal")),
    ("shop", ("store", "supermarket", "market", "shopping_mall", "florist", "pet_store")),
]


class LimitReached(Exception):
    pass


def kind_of(place_type):
    t = str(place_type or "")
    for kind, types in TYPE_KINDS:
        if t in types or any(t.endswith("_" + x) for x in types):
            return kind
    return "work"   # any other business


# ---- the daily count ---------------------------------------------------------------------
def _today():
    return time.strftime("%Y-%m-%d")


def usage():
    """{"used": n, "limit": n} for today."""
    limit = int(current_settings().get("googlePlacesDailyLimit", 150))
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
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = USAGE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"day": _today(), "count": now["used"] + 1}, fh)
    os.replace(tmp, USAGE_FILE)


# ---- one search ---------------------------------------------------------------------------
def search(lat, lon, radius):
    """The 20 places closest to (lat, lon). Returns (answer dict, HTTP status)."""
    settings = current_settings()
    key = settings.get("googleMapsKey", "")
    if settings.get("mapProvider") != "google" or not key:
        return {"error": "Google places are only used with the Google Maps provider and a saved key"}, 400
    if int(settings.get("googlePlacesDailyLimit", 150)) <= 0:
        return {"error": "Google places are turned off in Settings (daily limit 0)", "off": True}, 403
    with _lock:
        try:
            _count_one()
        except LimitReached:
            return {"error": "today's limit of Google places searches is used up", "limit": True, **usage()}, 429
        except OSError as err:
            log(f"Google places: could not save today's count: {err}")
            return {"error": "could not save the daily count"}, 500
    body = json.dumps({
        "maxResultCount": 20,
        "rankPreference": "DISTANCE",
        "languageCode": "en",
        "locationRestriction": {"circle": {
            "center": {"latitude": lat, "longitude": lon},
            "radius": float(max(MIN_RADIUS, min(MAX_RADIUS, radius)))}},
    }).encode()
    try:
        status, _, answer, _ = PLACES.request("POST", "/v1/places:searchNearby", body=body, headers={
            "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS})
    except OSError as err:
        log(f"Google places: could not reach Google: {err}")
        return {"error": "could not reach Google", **usage()}, 502
    if status != 200:
        log(f"Google places answered {status}: {_error_text(answer, key)}. Check in Google Cloud that "
            "'Places API (New)' is enabled and allowed for this key.")
        return {"error": f"Google answered {status}", **usage()}, 502
    try:
        found = json.loads(answer).get("places") or []
    except ValueError:
        found = []
    places = []
    for p in found:
        place = _place(p)
        if place:
            places.append(place)
    return {"places": places, **usage()}, 200


def _place(p):
    if not isinstance(p, dict):
        return None
    loc = p.get("location") or {}
    lat, lon = loc.get("latitude"), loc.get("longitude")
    name = str((p.get("displayName") or {}).get("text", "")).strip()
    if not name or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    place = {"id": "g:" + str(p.get("id", ""))[:100], "lat": round(lat, 6), "lon": round(lon, 6),
             "name": name[:100], "kind": kind_of(p.get("primaryType")),
             "label": str((p.get("primaryTypeDisplayName") or {}).get("text", "") or "Place")[:40]}
    if p.get("shortFormattedAddress"):
        place["addr"] = str(p["shortFormattedAddress"])[:100]
    link = str(p.get("googleMapsUri", ""))
    if link.startswith("https://"):
        place["link"] = link[:300]
    return place


def _error_text(body, key):
    try:
        error = json.loads(body).get("error", {})
        text = " / ".join(str(x) for x in (error.get("message"), error.get("status")) if x)
    except (ValueError, AttributeError):
        text = ""
    return (text or "(no details)").replace(key, "<key>")[:300]
