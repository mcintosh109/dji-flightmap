"""Maintenance reminders (5.6.0): checking, loading and saving (maintenance.json).

A reminder is a job you do now and then (replace the propellers, clean the
motors...) with up to three limits: flying hours, flights and days since it
was last done. It is due when ANY limit is reached. The server only stores
the reminders; the page counts the hours and flights from the flight list.

Only reminders: DJI's checks before every flight still apply.
"""
import json
import os
import re
import threading
from datetime import date, datetime, timedelta, timezone

from .config import MAINTENANCE_FILE, log

MAINT_LOCK = threading.Lock()
MAINT_ID_RE = re.compile(r"^[0-9a-f]{12}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_ITEMS = 100
MAX_HISTORY = 50          # dates kept per reminder ("done on ...")
LIMITS = {                # name: (smallest, largest)
    "everyHours": (0.1, 1000),
    "everyFlights": (1, 10000),
    "everyDays": (1, 3650),
}


def load_items():
    try:
        with open(MAINTENANCE_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        items = data.get("items", {}) if isinstance(data, dict) else {}
        return {k: v for k, v in items.items() if MAINT_ID_RE.match(k) and isinstance(v, dict)}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        log(f"Ignoring broken maintenance file {MAINTENANCE_FILE}: {exc}")
        return {}


def save_items(items):
    os.makedirs(os.path.dirname(MAINTENANCE_FILE), exist_ok=True)
    tmp = MAINTENANCE_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "items": items}, fh, indent=1)
    os.replace(tmp, MAINTENANCE_FILE)


def _text_ok(value, longest):
    return isinstance(value, str) and len(value) <= longest and not re.search(r"[<>\x00-\x09\x0b-\x1f]", value)


def clean_date(value):
    """'YYYY-MM-DD' if it is a real date not in the future, else None."""
    if not (isinstance(value, str) and DATE_RE.match(value)):
        return None
    try:
        day = date.fromisoformat(value)
    except ValueError:
        return None
    # One day of slack: the browser's "today" (local time) can be a day
    # ahead of the server's (UTC).
    return value if date(2000, 1, 1) <= day <= date.today() + timedelta(days=1) else None


def clean_item(incoming, old=None):
    """Check a reminder sent by the page. Returns (item, list of problems)."""
    problems = []
    name = incoming.get("name", "")
    if not _text_ok(name, 60) or not name.strip():
        problems.append("Give the reminder a name (up to 60 characters, without < or >).")
        name = ""
    drone = incoming.get("drone", "all")
    if not _text_ok(drone, 80) or not drone.strip():
        problems.append("Choose a drone (or All drones).")
        drone = "all"
    notes = incoming.get("notes", "")
    if not _text_ok(notes, 500):
        problems.append("Notes can be up to 500 characters, without < or >.")
        notes = ""

    item = {"name": name.strip(), "drone": drone.strip(), "notes": notes}
    for key, (lo, hi) in LIMITS.items():
        value = incoming.get(key)
        if value in (None, "", 0):
            item[key] = None
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
            what = {"everyHours": "Hours", "everyFlights": "Flights", "everyDays": "Days"}[key]
            problems.append(f"{what} must be between {lo:g} and {hi:g} (or empty).")
            item[key] = None
            continue
        item[key] = round(float(value), 1) if key == "everyHours" else int(value)
    if not any(item[k] for k in LIMITS):
        problems.append("Set at least one limit: hours, flights or days.")

    last = clean_date(incoming.get("lastDone"))
    if last is None:
        problems.append("'Last done' must be a date, not in the future.")
    item["lastDone"] = last
    # doneAt = the moment "Mark done" was pressed (only kept while lastDone is
    # that day), so flights earlier that same day don't count again.
    old_done_at = (old or {}).get("doneAt")
    item["doneAt"] = old_done_at if old_done_at and (old or {}).get("lastDone") == last else None
    # The history of "done" dates is only changed by marking it done.
    item["history"] = list((old or {}).get("history", []))[-MAX_HISTORY:]
    return item, problems


def mark_done(item, when):
    """Mark a reminder done on that date (counting starts again from it)."""
    history = [d for d in item.get("history", []) if d != when] + [when]
    item["history"] = sorted(history)[-MAX_HISTORY:]
    if when >= (item.get("lastDone") or when):
        item["lastDone"] = when
        # Marked done today: count from this moment, not from midnight.
        item["doneAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds") if abs((date.fromisoformat(when) - date.today()).days) <= 1 else None
    return item
