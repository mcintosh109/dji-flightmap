"""Saved flight plans: checking, loading and saving (plans.json)."""
import json
import os
import re
import threading

from .config import PLANS_FILE, log

PLANS_LOCK = threading.Lock()
PLAN_ID_RE = re.compile(r"^[0-9a-f]{12}$")
MAX_PLANS = 500
MAX_WAYPOINTS = 200


def load_plans():
    try:
        with open(PLANS_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        plans = data.get("plans", {}) if isinstance(data, dict) else {}
        return {k: v for k, v in plans.items() if PLAN_ID_RE.match(k) and isinstance(v, dict)}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        log(f"Ignoring broken plans file {PLANS_FILE}: {exc}")
        return {}


def save_plans(plans):
    os.makedirs(os.path.dirname(PLANS_FILE), exist_ok=True)
    tmp = PLANS_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "plans": plans}, fh, indent=1)
    os.replace(tmp, PLANS_FILE)


def clean_plan(incoming):
    """Check a plan sent by the page. Returns (plan, list of problems)."""
    problems = []

    def number(value, lo, hi):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and lo <= value <= hi

    def point(p, what):
        if not (isinstance(p, dict) and number(p.get("lat"), -90, 90) and number(p.get("lon"), -180, 180)):
            problems.append(f"{what} needs a valid position.")
            return None
        return {"lat": round(float(p["lat"]), 7), "lon": round(float(p["lon"]), 7)}

    text_ok = lambda v, n: isinstance(v, str) and len(v) <= n and not re.search(r"[<>\x00-\x09\x0b-\x1f]", v)

    name = incoming.get("name", "")
    if not text_ok(name, 60):
        problems.append("The plan name can be up to 60 characters, without < or >.")
        name = ""
    notes = incoming.get("notes", "")
    if not text_ok(notes, 1000):
        problems.append("Notes can be up to 1000 characters, without < or >.")
        notes = ""

    home = incoming.get("home")
    home = point(home, "The take-off point") if home is not None else None

    waypoints = []
    raw = incoming.get("waypoints", [])
    if not isinstance(raw, list) or len(raw) > MAX_WAYPOINTS:
        problems.append(f"A plan can have up to {MAX_WAYPOINTS} waypoints.")
        raw = []
    for i, w in enumerate(raw, 1):
        pos = point(w, f"Waypoint {i}")
        if pos is None:
            continue
        alt, speed, hold = w.get("alt"), w.get("speed"), w.get("hold", 0)
        if not number(alt, 0, 500):
            problems.append(f"Waypoint {i}: height must be 0 to 500 metres.")
        if not number(speed, 0.5, 15):
            problems.append(f"Waypoint {i}: speed must be 0.5 to 15 m/s.")
        if not number(hold, 0, 300):
            problems.append(f"Waypoint {i}: pause must be 0 to 300 seconds.")
        # Two decimals, so 400 ft (121.92 m) or 18 mph (8.05 m/s) come back exactly.
        waypoints.append({**pos, "alt": round(float(alt or 0), 2), "speed": round(float(speed or 1), 2),
                          "hold": round(float(hold or 0))})
    if waypoints and home is None:
        problems.append("Set a take-off point before adding waypoints.")

    defaults = incoming.get("defaults", {"alt": 60, "speed": 8})
    if not (isinstance(defaults, dict) and number(defaults.get("alt"), 0, 500) and number(defaults.get("speed"), 0.5, 15)):
        problems.append("Default height must be 0-500 m and default speed 0.5-15 m/s.")
        defaults = {"alt": 60, "speed": 8}

    planned = incoming.get("plannedFor", "")
    if not (isinstance(planned, str) and (planned == "" or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", planned))):
        problems.append("The planned time must look like 2026-11-20T15:30.")
        planned = ""
    compare = incoming.get("compareFlight", "")
    if not (isinstance(compare, str) and re.fullmatch(r"[0-9a-f]{0,40}", compare)):
        problems.append("Unknown flight to compare with.")
        compare = ""
    battery = incoming.get("batteryStart", 100)
    if not number(battery, 10, 100):
        problems.append("Battery at take-off must be 10 to 100 percent.")
        battery = 100
    kind = incoming.get("battery", "standard")
    if kind not in ("standard", "plus"):
        problems.append("The battery must be the standard one or the Plus one.")
        kind = "standard"
    return_home = incoming.get("returnHome", True)
    if not isinstance(return_home, bool):
        problems.append("Return to take-off must be on or off.")
        return_home = True

    plan = {
        "name": name.strip() or "Untitled plan",
        "notes": notes.strip(),
        "home": home,
        "waypoints": waypoints,
        "defaults": {"alt": round(float(defaults["alt"]), 2), "speed": round(float(defaults["speed"]), 2)},
        "plannedFor": planned,
        "compareFlight": compare,
        "batteryStart": int(battery),
        "battery": kind,
        "returnHome": return_home,
    }
    return plan, problems
