"""The connection to the flight logs on the NAS (TrueNAS), for the settings page.

How the logs reach the map: the Proxmox server (the "host") connects the NAS
share at /mnt/dji-archive, and passes that folder into this container,
read-only, as DATA_DIR (/srv/dji-logs).

This container can't connect the share itself: an unprivileged container
isn't allowed to mount network shares. So the work is split:
  - here, the map only CHECKS: does the NAS answer on the network, is the
    share connected, can the logs be read?
  - a helper on the host, deploy/nas-watch.sh (every minute), REPAIRS: it
    connects the share again after the NAS restarts, and restarts this
    container when it still sees the empty folder. It writes what it found
    to nas-host.json, and answers "Reconnect now" requests that this page
    leaves in nas-request.json.
(Research: "proxmox lxc bind mount", "cifs mount".)
"""
import json
import os
import socket
import threading
import time

from .config import DATA_DIR, STATE_DIR

# Where the list of mounted folders is (the tests use a pretend one).
MOUNTINFO = os.environ.get("NAS_MOUNTINFO", "/proc/self/mountinfo")
NAS_PORT = int(os.environ.get("NAS_PORT", "445"))   # SMB, Windows file sharing
REQUEST_FILE = os.path.join(STATE_DIR, "nas-request.json")   # written here
HOST_FILE = os.path.join(STATE_DIR, "nas-host.json")         # written by the host's helper
SHARE_TYPES = ("cifs", "smb3", "smbfs")
HELPER_STALE = 300      # the helper checks every minute; older than this = not running
READ_WAIT = 8           # seconds to wait for the NAS to list the folder
REQUEST_GAP = 15        # a second "Reconnect now" within this many seconds is ignored


def _unescape(text):
    """mountinfo writes a space as \\040 (and a few others like it)."""
    for code, char in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        text = text.replace(code, char)
    return text


def folder_mount(path=None):
    """What is mounted at `path`: (filesystem type, source).
    e.g. ("cifs", "//192.168.1.10/Share") for a NAS share, ("ext4", "/dev/...")
    for an ordinary folder, or (None, None) if it can't be told."""
    path = os.path.realpath(path or DATA_DIR)
    try:
        with open(MOUNTINFO, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None, None
    best = None   # the deepest mount that contains `path`; later lines win (mounted on top)
    for line in lines:
        parts = line.split(" ")
        if "-" not in parts or len(parts) < 5:
            continue
        dash = parts.index("-")
        if len(parts) < dash + 3:
            continue
        point = _unescape(parts[4])
        if path == point or path.startswith(point.rstrip("/") + "/"):
            if best is None or len(point) >= len(best[0]):
                best = (point, parts[dash + 1], _unescape(parts[dash + 2]))
    return (best[1], best[2]) if best else (None, None)


def server_from(source):
    """"//192.168.1.10/Share/folder" -> "192.168.1.10"."""
    source = (source or "").replace("\\", "/")
    return source[2:].split("/")[0] if source.startswith("//") else ""


def reachable(server, timeout=3):
    """Does the NAS answer on the network (its file-sharing port)?"""
    try:
        with socket.create_connection((server, NAS_PORT), timeout=timeout):
            return True
    except OSError:
        return False


_reading = {"thread": None}
_reading_lock = threading.Lock()


def _list(path, box):
    try:
        box["count"] = len(os.listdir(path))
    except OSError as exc:
        box["error"] = exc.strerror or str(exc)


def readable(path=None, wait=READ_WAIT):
    """Can the logs folder be read? Returns (True, number of entries) or
    (False, the reason). A NAS that stopped answering can make reading hang,
    so this waits at most `wait` seconds, and doesn't start another read while
    an earlier one is still stuck."""
    path = path or DATA_DIR
    with _reading_lock:
        earlier = _reading["thread"]
        if earlier is not None and earlier.is_alive():
            return False, "the NAS still hasn't answered an earlier read"
        box = {}
        reader = threading.Thread(target=_list, args=(path, box), daemon=True)
        _reading["thread"] = reader
        reader.start()
    reader.join(wait)
    if reader.is_alive():
        return False, f"the NAS didn't answer within {wait} seconds"
    if "error" in box:
        return False, box["error"]
    if not box.get("count"):
        return False, "the folder is empty"
    return True, box["count"]


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def host_report():
    """What the host's helper last found and did (see deploy/nas-watch.sh)."""
    return _read_json(HOST_FILE)


def request_time():
    return _number(_read_json(REQUEST_FILE).get("at"))


def request_reconnect(now=None):
    """Leave a "please reconnect now" note for the host's helper. Returns the
    note's time. Pressing the button again straight away changes nothing."""
    now = int(now or time.time())
    earlier = request_time()
    if earlier and now - earlier < REQUEST_GAP and earlier > _number(host_report().get("handled")):
        return earlier
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = REQUEST_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"at": now}, fh)
    os.replace(tmp, REQUEST_FILE)
    return now


def _ago(seconds):
    seconds = max(0, int(seconds))
    if seconds < 90:
        return f"{seconds} seconds ago"
    if seconds < 5400:
        return f"{round(seconds / 60)} minutes ago"
    return f"{round(seconds / 3600)} hours ago"


def status(flight_count=0, now=None):
    """Everything the settings page shows about the NAS connection."""
    now = now or time.time()
    fs, source = folder_mount()
    report = host_report()
    connected = fs in SHARE_TYPES
    is_share = connected or bool(report.get("share"))
    server = server_from(source) if connected else str(report.get("server") or "")
    checked = _number(report.get("at"))
    helper_on = bool(checked) and now - checked < HELPER_STALE
    asked = request_time()
    pending = bool(asked) and asked > _number(report.get("handled"))
    can_read, read_info = readable()

    checks = []
    if is_share:
        if server:
            near = reachable(server)
            checks.append({"id": "reachable", "ok": near, "text":
                           f"The NAS ({server}) answers on the network" if near else
                           f"The NAS ({server}) doesn't answer on the network: is it switched on, or restarting?"})
        else:
            checks.append({"id": "reachable", "ok": None, "text": "The NAS's address isn't known yet"})
        checks.append({"id": "connected", "ok": connected, "text":
                       "The NAS share is connected to the map" if connected else
                       "The NAS share isn't connected to the map (it sees an empty folder)"})
    checks.append({"id": "readable", "ok": can_read, "text":
                   f"The flight logs can be read ({flight_count} flights on the map)" if can_read else
                   f"The flight logs can't be read: {read_info}"})
    if is_share:
        checks.append({"id": "helper", "ok": helper_on, "text":
                       f"Automatic reconnect is on (the Proxmox server last checked {_ago(now - checked)})"
                       if helper_on else
                       "Automatic reconnect isn't running on the Proxmox server. To set it up, run the update there "
                       "(Settings → Updates shows the command)."})

    all_ok = all(c["ok"] for c in checks if c["ok"] is not None)
    if pending:
        summary = ("⏳ Asked the Proxmox server to reconnect. It checks every minute, so this can take up to "
                   "2 minutes; if needed, the map restarts itself (about 20 seconds).")
    elif all_ok:
        summary = ("✓ Connected: the flight logs on the NAS can be read." if is_share
                   else "✓ The flight logs can be read. They come from a folder on the Proxmox server, not a NAS share.")
    elif is_share:
        summary = ("⚠️ The map can't reach its flight logs on the NAS. The Proxmox server reconnects by itself "
                   "when the NAS is back; or press Reconnect now.")
    else:
        summary = "⚠️ The map can't read its flight logs."

    # What the helper did or found lately (shown for 15 minutes).
    message = ""
    if checked and now - checked < 900:
        message = str(report.get("problem") or report.get("action") or "")[:300]

    return {"kind": "share" if is_share else "folder", "ok": all_ok and not pending, "pending": pending,
            "summary": summary, "checks": checks, "message": message, "server": server,
            "helper": helper_on, "checkedAt": checked}
