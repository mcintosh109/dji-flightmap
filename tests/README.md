# Tests

Run everything:

```bash
bash tests/run-all.sh
```

| Part | File | What it checks | Needs |
|---|---|---|---|
| 1. Privacy | `privacy_check.sh` | Nothing personal is about to be published: no flight logs, private network addresses, email addresses or map keys | git |
| 2. Syntax | (in `run-all.sh`) | Every Python, JavaScript and shell file can be read. If the linters are installed: `ruff` finds undefined or unused names in Python, `shellcheck` finds risky shell | Python 3, Node.js; optional `pip install ruff`, `apt install shellcheck` |
| 3. Server | `test_server.py` | Reading logs (normal flight, flight clock that doesn't start at 0, no GPS, GeoJSON only, junk CSV), duplicates shown once, settings rules, old settings converted, login, the web addresses | Python 3 only |
| 4. Browser | `browser.test.js` | Opens the real pages in a hidden browser: flight list, layers panel, Azure credit line, replay (gliding, trail, Follow), only the open flight shown, settings page, update notice, phone layout, login | Node.js + [Playwright](https://playwright.dev) |
| 5. Easy install | `easy-install.test.sh` | The one-command install: downloads the newest release (or the test version with `--test`), asks where the logs and the disk go, refuses missing folders, offers an update when the map is already installed, stops outside Proxmox. Uses a pretend GitHub copy and fake Proxmox commands in a temp folder | git |
| 5. NAS helper | `nas-watch.test.sh` | The helper that reconnects the NAS: leaves a restarting NAS alone, connects the share again when it is back, restarts the container when it still sees the empty folder (at most every 15 minutes, or straight away for "Reconnect now"), never restarts for an empty share or a wrong password, waits while an update runs. A pretend NAS (a listening port), fake mount commands and a fake `pct`, all in a temp folder | Python 3 |
| 6. Update scripts | `deploy.test.sh` | `update-ct.sh` keeps settings, puts back wiped settings, undoes a broken version; `restore-ct.sh` works | A **throw-away** Linux machine, as root |

**Part 6 changes system folders** (`/opt`, `/etc`, `/var/lib`), so it is
skipped unless you set `FLIGHTMAP_ALLOW_SYSTEM_TEST=1`, and it refuses to run on
a Proxmox host. Never run it on your server or inside the real container.

## Test flights

`fixtures.py` makes **made-up** flight logs (over Central Park, with fake
serial numbers) in the same format dji-log-parser writes. Never add real flight
logs to this repository: they show where you fly, and the repository is public.

```bash
python3 tests/fixtures.py /tmp/some-empty-folder
```

## Nothing goes to the internet

The browser tests answer every outside request themselves: map pictures,
Azure Maps (including its credit line) and the GitHub update check are all
fakes. So the tests show the page *works*, but not what real maps *look* like.
