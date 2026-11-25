"""Reading one flight log (CSV from dji-log-parser, or GeoJSON) into a
summary and a track the map can draw."""
import csv
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone

from .config import MAX_TRACK_POINTS, PREVIEW_POINTS

# DJI CSV rows can be very wide; raise Python's default field size limit.
csv.field_size_limit(10_000_000)


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

            # The battery's full capacity (mAh) tells the standard battery
            # from the Plus one (see battery_kind). Keep the first real value.
            if not meta.get("batteryCapacity"):
                capacity = num(get("BATTERY.fullCapacity"))
                if capacity and 500 <= capacity <= 20000:
                    meta["batteryCapacity"] = round(capacity)

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
        "batteryCapacity": meta.get("batteryCapacity"),
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
        "batteryCapacity": None,
        "appVersion": "",
        "totalTime": total,
        "photoNum": int(num(props.get("captureNum"), 0)),
        "videoTime": num(props.get("videoTime"), 0),
    }


# DJI Mini 3 / Mini 4 Pro batteries (DJI's specs): the standard one is
# 2590 mAh (the drone stays under 249 g, about 34 min in DJI's test), the
# "Plus" one 3850 mAh (over 249 g, about 45 min). A battery holds a little
# less as it ages, so the line between them is drawn in the middle.
PLUS_BATTERY_MAH = 3200


def battery_kind(aircraft_name, capacity):
    """'standard' or 'plus' for a Mini drone's battery, '' when unknown."""
    if not capacity or "mini" not in (aircraft_name or "").lower():
        return ""
    return "plus" if capacity >= PLUS_BATTERY_MAH else "standard"


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
        "batteryCapacity": parsed["batteryCapacity"],
        "batteryKind": battery_kind(parsed["aircraftName"], parsed["batteryCapacity"]),
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
