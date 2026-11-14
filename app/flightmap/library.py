"""The flight library: keeps track of every log file in the data folder."""
import json
import os
import threading
from collections import OrderedDict
from datetime import datetime, timezone

from .config import CACHE_FILE, CACHE_VERSION, DETAIL_CACHE_SIZE, log
from .flightlogs import build_flight


class FlightLibrary:
    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.scan_lock = threading.Lock()   # only one scan at a time
        self.entries = {}          # full path -> {"sig", "rel", "summary", "error"}
        self.by_id = {}            # flight id -> full path
        self.details = OrderedDict()
        self.version = 0           # goes up every time something changes
        self.scanning = True
        self.problem = None
        self.last_scan = None
        self._load_cache()

    # ---- remembering summaries between restarts --------------------------
    def _load_cache(self):
        try:
            with open(CACHE_FILE, encoding="utf-8") as fh:
                saved = json.load(fh)
            if saved.get("version") == CACHE_VERSION and saved.get("root") == self.root:
                for path, entry in saved.get("entries", {}).items():
                    entry["sig"] = tuple(entry["sig"])
                    self.entries[path] = entry
                self._reindex()
                log(f"Loaded {len(self.entries)} cached flight summaries")
        except FileNotFoundError:
            pass
        except Exception as exc:  # a broken cache is not fatal, just rebuild it
            log(f"Ignoring cache file {CACHE_FILE}: {exc}")

    def _save_cache(self):
        try:
            os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
            tmp = CACHE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": CACHE_VERSION, "root": self.root,
                           "entries": self.entries}, fh)
            os.replace(tmp, CACHE_FILE)
        except OSError as exc:
            log(f"Could not save cache file {CACHE_FILE}: {exc}")

    def _reindex(self):
        self.by_id = {e["summary"]["id"]: p for p, e in self.entries.items() if e.get("summary")}

    # ---- finding files -----------------------------------------------------
    def _find_files(self):
        """Return {full path: relative path} for every log in the folder.

        If 'Flight_X.csv' and 'Flight_X.geojson' are both there, the CSV wins
        because it has far more detail.
        """
        chosen = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                stem, ext = os.path.splitext(name)
                ext = ext.lower()
                if name.startswith(".") or ext not in (".csv", ".geojson"):
                    continue
                key = os.path.join(dirpath, stem)
                if ext == ".csv" or key not in chosen:
                    chosen[key] = os.path.join(dirpath, name)
        return {path: os.path.relpath(path, self.root) for path in chosen.values()}

    def scan(self):
        with self.scan_lock:
            self._scan()

    def _scan(self):
        if not os.path.isdir(self.root):
            with self.lock:
                self.problem = f"Data folder not found: {self.root}"
                self.scanning = False
            return

        files = self._find_files()
        changed = False
        new_entries = {}
        for path, rel in files.items():
            try:
                st = os.stat(path)
            except OSError:
                continue
            sig = (st.st_mtime, st.st_size)
            old = self.entries.get(path)
            if old and old["sig"] == sig:
                new_entries[path] = old
                continue
            changed = True
            try:
                summary, detail = build_flight(path, rel, st.st_mtime)
                new_entries[path] = {"sig": sig, "rel": rel, "summary": summary, "error": None}
                with self.lock:
                    self._remember_detail(path, sig, detail)
                log(f"Read {rel}: {len(detail['track'])} points")
            except Exception as exc:
                new_entries[path] = {"sig": sig, "rel": rel, "summary": None, "error": str(exc)}
                log(f"Could not read {rel}: {exc}")

        if set(new_entries) != set(self.entries):
            changed = True

        with self.lock:
            self.entries = new_entries
            self._reindex()
            self.problem = None
            self.scanning = False
            self.last_scan = datetime.now(timezone.utc).isoformat()
            if changed:
                self.version += 1
        if changed:
            self._save_cache()

    # ---- answering the web page -------------------------------------------
    @staticmethod
    def _same_flight_key(summary):
        """Two files are the same flight if they share serial number + start time."""
        if summary["start"]:
            return f"{summary['serial']}|{summary['start'][:19]}"
        # No clock in the log: fall back to the file name without its folder.
        return "file|" + os.path.splitext(os.path.basename(summary["file"]))[0]

    def _unique_flights(self):
        """Pick one file per flight. Prefers CSV, then the most GPS points,
        then the most recently saved copy."""
        best = {}
        copies = {}
        for entry in self.entries.values():
            summary = entry.get("summary")
            if not summary:
                continue
            key = self._same_flight_key(summary)
            copies[key] = copies.get(key, 0) + 1
            rank = (summary["source"] == "csv", summary.get("points", 0), entry["sig"][0])
            if key not in best or rank > best[key][0]:
                best[key] = (rank, summary)
        flights = []
        for key, (_, summary) in best.items():
            flights.append(dict(summary, copies=copies[key]))
        return flights

    def listing(self):
        with self.lock:
            flights = self._unique_flights()
            errors = [{"file": e["rel"], "error": e["error"]}
                      for e in self.entries.values() if e.get("error")]
            flights.sort(key=lambda s: s["sortKey"], reverse=True)
            return {
                "files": len(self.entries),
                "version": self.version,
                "scanning": self.scanning,
                "problem": self.problem,
                "dataDir": self.root,
                "lastScan": self.last_scan,
                "flights": flights,
                "errors": errors,
            }

    def _remember_detail(self, path, sig, detail):
        self.details[(path, sig)] = detail
        self.details.move_to_end((path, sig))
        while len(self.details) > DETAIL_CACHE_SIZE:
            self.details.popitem(last=False)

    def detail(self, flight_id):
        with self.lock:
            path = self.by_id.get(flight_id)
            entry = self.entries.get(path) if path else None
            if not entry:
                return None
            key = (path, entry["sig"])
            if key in self.details:
                self.details.move_to_end(key)
                return self.details[key]
        # Not in memory: read the file again (outside the lock, it can be slow).
        st = os.stat(path)
        _, detail = build_flight(path, entry["rel"], st.st_mtime)
        with self.lock:
            self._remember_detail(path, entry["sig"], detail)
        return detail
