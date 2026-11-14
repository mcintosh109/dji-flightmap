# Tests

Run everything:

```bash
bash tests/run-all.sh
```

| Part | File | What it checks | Needs |
|---|---|---|---|
| 1. Privacy | `privacy_check.sh` | Nothing personal is about to be published: no flight logs, private network addresses, email addresses or map keys | git |
| 2. Syntax | (in `run-all.sh`) | Every Python, JavaScript and shell file can be read | Python 3, Node.js |
| 3. Server | `test_server.py` | Reading logs (normal flight, flight clock that doesn't start at 0, no GPS, GeoJSON only, junk CSV), duplicates shown once, settings rules, old settings converted, login, the web addresses | Python 3 only |
| 4. Browser | `browser.test.js` | Opens the real pages in a hidden browser: flight list, layers panel, Azure credit line, replay (gliding, trail, Follow), only the open flight shown, settings page, update notice, phone layout, login | Node.js + [Playwright](https://playwright.dev) |
| 5. Update scripts | `deploy.test.sh` | `update-ct.sh` keeps settings, puts back wiped settings, undoes a broken version; `restore-ct.sh` works | A **throw-away** Linux machine, as root |

**Part 5 changes system folders** (`/opt`, `/etc`, `/var/lib`), so it is
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
