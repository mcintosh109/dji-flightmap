"""Sending plans to the DJI RC 2 through the dock (the Raspberry Pi of dji-rc2-dock).

DJI Fly has no import button: a plan is put on the RC 2 in place of a
"placeholder" mission made in DJI Fly (see djifly.py). The Pi does the
copying, because the RC 2 is plugged into it. This file is the map's side:

  1. The owner makes a DOCK KEY on the settings page and gives it to the Pi
     once (dji-rc2-dock: sudo dji-map-link). Only a scrambled copy (a SHA-256
     "hash") is kept here, like a password.
  2. The Pi reports the missions it finds on the RC 2 (PUT /api/dock/missions):
     each mission's .kmz file and DJI Fly's small preview picture. The map
     reads the route out of each file, so the owner can see which is which.
  3. In the planner, "Send to RC 2" picks one of those missions to replace.
     The new .kmz is made right then (exactly what the owner approved) and
     waits in a queue, together with a fingerprint (SHA-256) of the
     placeholder as the Pi last saw it.
  4. The Pi asks for the queue (GET /api/dock/queue) on plug-in and every
     minute or two while docked. For each waiting send it checks the
     placeholder still has that fingerprint (so a mission that changed in
     DJI Fly since is never overwritten), backs the old file up, writes the
     new one, reads it back, and reports the result (POST /api/dock/result/<id>).

Files (all in STATE_DIR, readable only by the map):
  dock-key.json       the hash of the dock key, and when the dock was last seen
  rc2-missions.json   the missions the Pi last reported
  rc2-previews/       DJI Fly's preview picture of each mission
  rc2-queue.json      sends: waiting, done, failed, cancelled (the last 30)
  rc2-outbox/         the .kmz of each send

Research: "bearer token", "SHA-256 checksum", "MTP".
"""
import base64
import hashlib
import hmac
import io
import json
import math
import os
import re
import secrets
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

from .config import STATE_DIR, log

KEY_FILE = os.path.join(STATE_DIR, "dock-key.json")
MISSIONS_FILE = os.path.join(STATE_DIR, "rc2-missions.json")
QUEUE_FILE = os.path.join(STATE_DIR, "rc2-queue.json")
PREVIEW_DIR = os.path.join(STATE_DIR, "rc2-previews")
OUTBOX_DIR = os.path.join(STATE_DIR, "rc2-outbox")

LOCK = threading.Lock()
UUID_RE = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
SEND_ID_RE = re.compile(r"^[0-9a-f]{12}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_MISSIONS = 100
MAX_KMZ = 2 * 1024 * 1024        # bytes: DJI Fly's files are a few KB
MAX_INSIDE = 8 * 1024 * 1024     # bytes: a file inside the .kmz, unpacked
MAX_PREVIEW = 512 * 1024         # bytes
KEEP_SENDS = 30
MAX_POINTS = 500


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as exc:
        log(f"Ignoring broken file {path}: {exc}")
        return default


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


def _write_bytes(path, body):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(body)
    os.replace(tmp, path)


def _hash(key):
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


# ---- the dock key ------------------------------------------------------------
def new_key():
    """Make a new dock key (the old one stops working). Returns it: it is shown once."""
    key = "dock_" + secrets.token_urlsafe(32)
    with LOCK:
        _write(KEY_FILE, {"hash": _hash(key), "created": _now(), "seen": "", "seenFrom": ""})
    log("A new dock key was made (the RC 2 dock needs it: sudo dji-map-link)")
    return key


def remove_key():
    with LOCK:
        try:
            os.remove(KEY_FILE)
        except FileNotFoundError:
            pass
    log("The dock key was removed: the RC 2 dock can't reach the map until a new one is made")


def dock_allowed(authorization, ip):
    """True if the request carries the dock key ("Authorization: Bearer <key>")."""
    stored = _read(KEY_FILE, {}).get("hash", "")
    given = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not stored or not given or not hmac.compare_digest(_hash(given), stored):
        return False
    with LOCK:
        info = _read(KEY_FILE, {})
        if info.get("hash") == stored:
            info["seen"], info["seenFrom"] = _now(), ip
            _write(KEY_FILE, info)
    return True


# ---- reading a DJI Fly mission ---------------------------------------------------
def _distance(a, b):
    """Metres between two (lat, lon) points (haversine)."""
    r = 6371000.0
    la1, la2 = math.radians(a[0]), math.radians(b[0])
    dla, dlo = la2 - la1, math.radians(b[1] - a[1])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def read_mission(body):
    """What a DJI Fly .kmz holds: {"points": [[lat, lon, height], ...], "lengthM", "updated"}.

    Raises ValueError if it isn't a mission we can read.
    """
    if len(body) > MAX_KMZ:
        raise ValueError("mission file too large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile as exc:
        raise ValueError("not a .kmz (zip) file") from exc
    texts = {}
    for name in ("wpmz/waylines.wpml", "wpmz/template.kml"):
        try:
            info = zf.getinfo(name)
        except KeyError:
            continue
        if info.file_size > MAX_INSIDE:
            raise ValueError("mission file too large unpacked")
        texts[name] = zf.read(info)
    route = texts.get("wpmz/waylines.wpml") or texts.get("wpmz/template.kml")
    if not route:
        raise ValueError("no route inside")
    try:
        root = ET.fromstring(route)
    except ET.ParseError as exc:
        raise ValueError("route can't be read") from exc
    points = []
    for mark in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        coords = mark.find(".//{http://www.opengis.net/kml/2.2}coordinates")
        height = next((el.text for el in mark if el.tag.endswith("}executeHeight") or el.tag.endswith("}height")), None)
        try:
            lon, lat = (float(v) for v in (coords.text or "").strip().split(",")[:2])
            h = float(height) if height is not None else 0.0
        except (AttributeError, ValueError):
            continue
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            points.append([round(lat, 7), round(lon, 7), round(h, 2)])
        if len(points) >= MAX_POINTS:
            break
    updated = ""
    template = texts.get("wpmz/template.kml", b"")
    m = re.search(rb"<wpml:updateTime>(\d{10,14})</wpml:updateTime>", template)
    if m:
        updated = datetime.fromtimestamp(int(m.group(1)) / 1000, timezone.utc).isoformat(timespec="seconds")
    length = sum(_distance(points[i], points[i + 1]) for i in range(len(points) - 1))
    return {"points": points, "lengthM": round(length, 1), "updated": updated}


def _image_type(body):
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if body.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "webp"
    return ""


# ---- the Pi reports the RC 2's missions --------------------------------------------
def report_missions(incoming):
    """PUT /api/dock/missions from the Pi. Returns (answer, status)."""
    missions = incoming.get("missions")
    if not isinstance(missions, list) or len(missions) > MAX_MISSIONS:
        return {"error": f"missions must be a list of up to {MAX_MISSIONS}"}, 400
    seen, kept, problems = set(), [], []
    previews = {}
    for item in missions:
        uuid = item.get("uuid") if isinstance(item, dict) else None
        if not isinstance(uuid, str) or not UUID_RE.match(uuid) or uuid.upper() in seen:
            problems.append("a mission with a missing or odd name was skipped")
            continue
        seen.add(uuid.upper())
        try:
            body = base64.b64decode(item.get("kmz") or "", validate=True)
            info = read_mission(body)
        except (ValueError, TypeError) as exc:
            problems.append(f"{uuid}: {exc}")
            continue
        entry = {
            "uuid": uuid,
            "sha256": hashlib.sha256(body).hexdigest(),
            "size": len(body),
            "modified": str(item.get("modified", ""))[:40],
            "waypoints": len(info["points"]),
            "lengthM": info["lengthM"],
            "updated": info["updated"],
            "points": info["points"],
            "preview": False,
        }
        try:
            picture = base64.b64decode(item.get("preview") or "", validate=True)
        except (ValueError, TypeError):
            picture = b""
        kind = _image_type(picture)
        if kind and len(picture) <= MAX_PREVIEW:
            previews[uuid] = (kind, picture)
            entry["preview"] = kind
        kept.append(entry)
    with LOCK:
        for name in os.listdir(PREVIEW_DIR) if os.path.isdir(PREVIEW_DIR) else []:
            os.remove(os.path.join(PREVIEW_DIR, name))
        for uuid, (kind, picture) in previews.items():
            _write_bytes(os.path.join(PREVIEW_DIR, f"{uuid}.{kind}"), picture)
        _write(MISSIONS_FILE, {"reported": _now(), "missions": kept, "problems": problems[:20]})
        queue = _read(QUEUE_FILE, [])
        for send in queue:
            if send.get("state") == "waiting" and send["uuid"].upper() not in seen:
                send["state"], send["finished"] = "failed", _now()
                send["message"] = "This mission is no longer on the RC 2 (deleted in DJI Fly?). Pick another one."
        _write(QUEUE_FILE, queue)
        _set_flag("want-list", False)
    log(f"The RC 2 dock reported {len(kept)} mission(s)" + (f" ({len(problems)} skipped)" if problems else ""))
    return {"ok": True, "missions": len(kept), "problems": problems[:20]}, 200


def preview(uuid):
    """(content type, bytes) of a mission's preview picture, or None."""
    if not UUID_RE.match(uuid):
        return None
    for kind, ctype in (("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp")):
        try:
            with open(os.path.join(PREVIEW_DIR, f"{uuid}.{kind}"), "rb") as fh:
                return ctype, fh.read()
        except FileNotFoundError:
            continue
    return None


def _set_flag(name, on):
    path = os.path.join(STATE_DIR, f"rc2-{name}")
    if on:
        _write_bytes(path, b"1")
    else:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def ask_for_list():
    """The page's "Refresh the list": the Pi sends the list next time it checks."""
    with LOCK:
        _set_flag("want-list", True)


# ---- the send queue -------------------------------------------------------------------
def queue_send(plan_id, plan, uuid, kmz):
    """Planner "Send to RC 2": queue kmz for the mission uuid. Returns (answer, status)."""
    if not isinstance(uuid, str) or not UUID_RE.match(uuid):
        return {"error": "Pick a mission on the RC 2 to replace."}, 400
    with LOCK:
        listed = {m["uuid"].upper(): m for m in _read(MISSIONS_FILE, {}).get("missions", [])}
        target = listed.get(uuid.upper())
        if target is None:
            return {"error": "That mission isn't in the RC 2's list any more. Refresh the list and pick again."}, 409
        queue = _read(QUEUE_FILE, [])
        now = _now()
        for send in queue:
            if send.get("state") == "waiting" and send["uuid"].upper() == uuid.upper():
                send["state"], send["finished"] = "cancelled", now
                send["message"] = "Replaced by a newer send to the same mission."
        send_id = secrets.token_hex(6)
        _write_bytes(os.path.join(OUTBOX_DIR, f"{send_id}.kmz"), kmz)
        send = {
            "id": send_id, "uuid": target["uuid"], "expectSha256": target["sha256"],
            "sha256": hashlib.sha256(kmz).hexdigest(), "size": len(kmz),
            "planId": plan_id, "planName": str(plan.get("name", ""))[:60],
            "created": now, "state": "waiting", "message": "", "finished": "", "backup": "",
        }
        queue.append(send)
        _write(QUEUE_FILE, _trim(queue))
    log(f"Plan {plan_id} is waiting to be sent to RC 2 mission {target['uuid']}")
    return {"ok": True, "send": send}, 200


def _trim(queue):
    """Keep every waiting send, and only the newest finished ones (and their files)."""
    finished = [s for s in queue if s.get("state") != "waiting"]
    drop = {s["id"] for s in finished[:-KEEP_SENDS]} if len(finished) > KEEP_SENDS else set()
    for send_id in drop:
        try:
            os.remove(os.path.join(OUTBOX_DIR, f"{send_id}.kmz"))
        except FileNotFoundError:
            pass
    return [s for s in queue if s["id"] not in drop]


def cancel(send_id):
    with LOCK:
        queue = _read(QUEUE_FILE, [])
        for send in queue:
            if send["id"] == send_id and send.get("state") == "waiting":
                send["state"], send["finished"], send["message"] = "cancelled", _now(), "Cancelled on the map."
                _write(QUEUE_FILE, queue)
                return True
    return False


def dock_queue():
    """GET /api/dock/queue: what the Pi should send now."""
    with LOCK:
        queue = _read(QUEUE_FILE, [])
        want = os.path.exists(os.path.join(STATE_DIR, "rc2-want-list")) or not os.path.exists(MISSIONS_FILE)
    sends = [{k: s[k] for k in ("id", "uuid", "expectSha256", "sha256", "size", "planName")}
             | {"url": f"/api/dock/kmz/{s['id']}"} for s in queue if s.get("state") == "waiting"]
    return {"send": sends, "wantList": want}


def outbox_kmz(send_id):
    """The bytes of a waiting send's .kmz, or None."""
    if not SEND_ID_RE.match(send_id):
        return None
    with LOCK:
        if not any(s["id"] == send_id and s.get("state") == "waiting" for s in _read(QUEUE_FILE, [])):
            return None
        try:
            with open(os.path.join(OUTBOX_DIR, f"{send_id}.kmz"), "rb") as fh:
                return fh.read()
        except FileNotFoundError:
            return None


def dock_result(send_id, incoming):
    """POST /api/dock/result/<id> from the Pi: {"ok": bool, "message": str, "backup": str}."""
    if not SEND_ID_RE.match(send_id):
        return {"error": "unknown send"}, 404
    ok = incoming.get("ok") is True
    clean = lambda v, n: re.sub(r"[\x00-\x1f<>]", " ", str(v or ""))[:n]
    with LOCK:
        queue = _read(QUEUE_FILE, [])
        send = next((s for s in queue if s["id"] == send_id), None)
        if send is None:
            return {"error": "unknown send"}, 404
        if send.get("state") != "waiting":
            return {"ok": True, "state": send["state"]}, 200
        send["state"] = "done" if ok else "failed"
        send["finished"] = _now()
        send["message"] = clean(incoming.get("message"), 300)
        send["backup"] = clean(incoming.get("backup"), 200)
        _write(QUEUE_FILE, queue)
        if ok:
            # Until the Pi reports the list again, the mission now holds our file.
            data = _read(MISSIONS_FILE, {})
            for m in data.get("missions", []):
                if m["uuid"].upper() == send["uuid"].upper():
                    m["sha256"], m["size"] = send["sha256"], send["size"]
            if data:
                _write(MISSIONS_FILE, data)
    log(f"The RC 2 dock {'sent' if ok else 'could NOT send'} plan {send['planId']} "
        f"to mission {send['uuid']}" + (f": {send['message']}" if send["message"] else ""))
    return {"ok": True, "state": send["state"]}, 200


# ---- for the page ---------------------------------------------------------------------------
def page_status():
    """GET /api/rc2: everything the planner and settings page show."""
    with LOCK:
        key = _read(KEY_FILE, {})
        data = _read(MISSIONS_FILE, {})
        queue = _read(QUEUE_FILE, [])
        want = os.path.exists(os.path.join(STATE_DIR, "rc2-want-list"))
    sent = {}   # sha256 -> plan name, for missions that now hold one of our plans
    for s in queue:
        if s.get("state") == "done":
            sent[s["sha256"]] = s.get("planName", "")
    missions = []
    for m in data.get("missions", []):
        missions.append(dict(m, fromMap=sent.get(m["sha256"])))
    return {
        "keySet": bool(key.get("hash")),
        "keyCreated": key.get("created", ""),
        "dockSeen": key.get("seen", ""),
        "listReported": data.get("reported", ""),
        "listWanted": want,
        "problems": data.get("problems", []),
        "missions": missions,
        "sends": list(reversed(queue))[:KEEP_SENDS],
        "now": _now(),
        "time": time.time(),
    }
