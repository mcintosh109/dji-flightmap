# DJI Flight Map: notes for Claude

Read this first in every session. It records how to work with the owner of
this project, their setup, and lessons learned the hard way.

## Who you are helping

- The owner is **not a programmer, and is learning**. They are autistic and
  need things **broken down step by step**: one action per step, what it does,
  what they should see, and what to do if it looks different.
- Give **research keywords** for new ideas (e.g. *"proxmox bind mount"*).
- Put every command they will run in its **own** ```bash block, no `$` prompt.
  One command per block, so each can be copied on its own.
- They paste into the Proxmox web Shell with **Ctrl+Shift+V**.
- They use the map from a Windows PC in a browser.
- Explain *why* when they ask "why" — they want to understand, not just follow.
- **Never ask them to paste passwords or API keys into the chat.** Keys go into
  the settings page; passwords go into the Proxmox Shell prompts.
- Ask before anything hard to undo or public (force-push, deleting a container).
- **Disagree when there's a reason to.** The owner asked for this: if an idea
  is risky, there's a better way, or one of your own earlier choices was wrong,
  say so plainly and explain why. Then the owner decides.
- **Safety comes first** for anything about flying: never let the app suggest a
  flight is "safe". The planner checks height, distance, battery and weather
  only, and must always say that airspace, obstacles and local rules are not
  checked, and that the pilot must check local laws and regulations.

## Privacy: this repository is PUBLIC

Never commit (the privacy check in `tests/run-all.sh` looks for these):

- real flight logs (`.csv`, `.geojson`, `.txt`): they show where the owner flies
- their network addresses, server names, usernames, email addresses
- map keys, passwords, drone/battery serial numbers, GPS coordinates of their flights

Use made-up values instead: `192.168.1.x` addresses, the test flights in
`tests/fixtures.py` (Central Park, fake serials). Once, the TrueNAS address was
committed by mistake and the history had to be rewritten; don't repeat that.

## Their setup (in general terms)

- **Proxmox VE 9** (Debian trixie) on an **x86_64 / amd64** server, using the
  free *No-Subscription* package repository.
- The app runs in an **unprivileged LXC container** named `dji-flightmap`,
  made by `deploy/create-ct.sh`. Its number varies: find it with `pct list`.
  The disk lives on a storage the owner chose (not always `local-lvm`).
- **Where the logs come from:** the owner's other project
  [dji-rc2-dock](https://github.com/mcintosh109/dji-rc2-dock): a Raspberry Pi
  copies logs off a DJI RC 2, decrypts them with dji-log-parser, and saves them
  on a **TrueNAS SMB share**. Each dock session makes
  `archive/<YYYY-MM-DD_HH-MM-SS>/parsed/*.csv|*.geojson` (and `raw/*.txt`).
- Only the **`archive`** folder is used. The Proxmox **host** mounts it
  read-only at `/mnt/dji-archive` (`deploy/setup-truenas-mount.sh` asks for the
  address and login; credentials in `/etc/smb-dji-flightmap.cred`), and the
  container sees it read-only at `/srv/dji-logs`.
- Map provider in use: **Azure Maps** (key saved on the settings page).
- Drone: DJI Mini 4 Pro.

## Licence

Apache 2.0, copyright "mcintosh109" (the owner chose the GitHub username, not
a real name: don't add one). `LICENSE` is the official text; the owner filled
in the copyright line in its appendix themselves. `NOTICE` credits the owner
as the creator, and its last lines are the owner's own words (written on
GitHub): don't reword either without asking. Keep `NOTICE` accurate: if
another third-party library is ever bundled, add its notice there.

## How the project is built

| Path | What |
|---|---|
| `app/server.py` | Python, standard library only. Entry point: the `Handler` class (every web address) and start-up. |
| `app/flightmap/` | One module per job: `config` (env + paths), `flightlogs` (read one log), `library` (all flights), `settings`, `plans`, `auth` (login), `azure` (key-hiding proxy), `places` (OpenStreetMap places). Modules read the environment at import, so tests set env vars first and re-import. |
| `app/version.json` | Version number + "what's new" notes. The page compares it with GitHub to show the update notice. |
| `app/static/` | Classic scripts sharing globals, loaded in this order by `index.html`: `common.js` (helpers), `updates.js`, `maps.js` (providers/layers), `app.js` (state, formatting, map, icons), `layers.js`, `places.js` (shops/schools/parks layer), `overview.js` (sidebar + all flights), `flight.js` (open flight + replay), `update-notice.js`, `main.js` (refresh + start), `planner.js`. Each file wires its own buttons at the bottom. Also `settings.*`, `login.html` (self-contained), `style.css`, `vendor/leaflet` (1.9.4). |
| `deploy/` | `setup-truenas-mount.sh`, `create-ct.sh` (host), `install.sh` (in container), `update-ct.sh` + `restore-ct.sh` + `ct-backup.sh` (host), `set-login.sh` (container). |
| `tests/` | `run-all.sh` runs everything (privacy, syntax + ruff/shellcheck when installed, server, browser, update scripts). See `tests/README.md`. |

Inside the container: settings in `/var/lib/dji-flightmap/settings.json`
(0600), login in `/etc/default/dji-flightmap` (0600), service `dji-flightmap`.

## Making a change

Use the **release** skill (`.claude/skills/release/SKILL.md`) for every change.
Version numbers follow the owner's rule: a **whole new function** raises the
first number (the flight planner made it 2.0.0); improvements raise the middle
one; bug fixes the last one.
In short: raise the version in `app/version.json` and write plain-English
notes, update the README, run `FLIGHTMAP_ALLOW_SYSTEM_TEST=1 bash tests/run-all.sh`,
commit, push to `main`. That makes it a **test version**: nothing offers it
yet. Ask the owner to try it:

```bash
cd /root/dji-flightmap && bash deploy/update-ct.sh --test
```

…and to press **Ctrl+Shift+R** on the map page afterwards. **Only when the
owner confirms it works**, release it with a tag (`git tag -a vX.Y.Z` +
`git push origin vX.Y.Z`). The update notice and a normal
`bash deploy/update-ct.sh` only see tagged versions.

## Lessons learned (don't relearn these)

- **Flight clock:** `OSD.flyTime` does not always start at 0. If the drone lands
  and takes off again without being switched off, it keeps counting (seen: 407 s).
  Time is counted from each file's first row.
- **Junk columns:** `HOME.latitude/longitude` can be garbage (e.g. 45836623…);
  the first GPS fix is used as the take-off point. First rows are dated 1970
  and sit at 0,0 until GPS locks.
- **`OSD.zSpeed` is negative when climbing** (DJI counts down as positive).
- **Proxmox templates:** `pveam available` lists both `amd64` and `arm64`;
  always match `dpkg --print-architecture` (picking arm64 caused "Exec format error").
- **Proxmox package updates** fail with `401 Unauthorized` until the
  enterprise repository is disabled and No-Subscription is added.
- **Unprivileged containers can't mount SMB.** Mount on the host
  (`x-systemd.before=pve-guests.service`) and bind-mount it in read-only.
- **CARTO** basemaps need a (free) key since late 2026, otherwise tiles say
  "API KEY REQUIRED". The free "Dark" layer is OpenStreetMap with a CSS filter.
- **Bing Maps** is retired for free accounts; **Azure Maps** replaces it.
  Azure's *Get Map Attribution* returns credits as **HTML** — show only the text,
  and the credit must be shown (Azure terms).
- **Azure key stays on the server** (2.1.0): tiles go through
  `/tiles/azure/<tileset>/<z>/<x>/<y>.png` and credits through
  `/api/azure-credits`; `public_settings()` replaces the key with
  `azureMapsKeySet`. On save, an empty key box means "keep", `removeAzureMapsKey`
  deletes it. Tests use `AZURE_MAPS_URL` to point the server at a fake Azure.
- **Backups** (2.2.0): host `/root/dji-flightmap-backups` (10 kept) and, if
  connected, TrueNAS `flightmap-backups` mounted read-write at
  `/mnt/dji-flightmap-backups` (30 kept). It sits NEXT TO `DJI Flight logs`,
  not inside it, because the Pi dock has write access inside. `copy_offsite`
  refuses to write if the folder isn't a mount point (TrueNAS down). Daily
  `dji-flightmap-backup.timer` on the host runs `deploy/backup-ct.sh`.
- **Speed of the Azure proxy** (2.2.2): `azure.py` keeps a pool of open
  connections to Azure (a new TLS handshake per tile was the slow part) and
  remembers answers in memory only as long as Azure's `Cache-Control` allows
  (never for `private`/`no-store`; Microsoft's terms allow latency caching
  within the header's validity). The web server speaks HTTP/1.1 keep-alive,
  which has three traps: one Handler object serves many requests, so reset
  per-request state (`cache_control`) in `end_headers`; set
  `disable_nagle_algorithm` or every reply stalls ~40 ms; and requests with a
  body get `Connection: close` so unread data can't be taken for the next request.
- **Copy buttons:** `navigator.clipboard` needs https; the map is plain http,
  so `updates.js` falls back to `document.execCommand('copy')`.
- **Claude's sandbox can't reach tile servers or most websites.** The tests
  fake them. Anything about how real maps *look* needs a screenshot from the owner.
- **Very long heredoc commands can be blocked** by a safety check. Write the
  script to a file in the scratchpad first, then run it.
- **Flight planner** (`planner.js`, `/api/plans`): heights are metres above
  take-off, speeds m/s; the page converts to ft/mph. Values are saved with two
  decimals so 400 ft (121.92 m) round-trips exactly. Weather is Open-Meteo,
  called from the browser (free, no key); its hourly times are the location's
  local time, matched against the planned time as text.
- **Releases** (2.3.0): a version is released when a `vX.Y.Z` tag exists.
  `updates.js` asks `api.github.com/repos/<repo>/tags` (60 requests/hour per
  address without a login; a 403 there means "busy", not broken) and reads
  the notes from `raw.githubusercontent.com/<repo>/vX.Y.Z/app/version.json`.
  `update-ct.sh` checks out the newest tag's scripts (TOOL) and installs the
  chosen ref with `git archive` (INSTALL), so `--version` can go back without
  leaving old scripts on the host. First tag is v2.3.0: never tag anything
  older, its `update-ct.sh` can't run from a detached checkout.
- **The owner sometimes edits files on GitHub's website** (they did for
  `LICENSE` and `NOTICE`). Before every push: `git fetch origin`, look at
  `git log HEAD..origin/main`, and `git rebase origin/main`. Never force-push
  over their commits, and keep their wording.
- **Places** (2.4.0): from OpenStreetMap's Overpass API, through the server
  (`/api/places?x0=&x1=&y0=&y1=`, zoom-15 tile numbers, at most 30). One
  Overpass question at a time, per-tile memory cache for a week; a cut-off
  answer (>= 4000 places) is never cached. Azure was ruled out: its new
  Search 2026-01-01 has **no POI search**, only the superseded v1 does.
  Shown from zoom 16, names from 17, in a pane under the flight paths;
  `#map.planning` makes them click-through. Never call it a no-fly map.
  Tests use `OVERPASS_URL` to point at a fake.
- **Overpass is often slow** (2.4.1): 2.4.0 stuck on "Loading places…" on the
  owner's server. Now: two servers (overpass-api.de, then
  overpass.private.coffee; `OVERPASS_URL` takes a comma list), 25 s each,
  the one that worked is asked first; the query collects named objects once
  (`nwr["name"]->.named`) and filters that set; the browser says "still
  waiting" after 8 s and gives up at 70 s. overpass-api.de wants a custom
  User-Agent (a stock one gets 406). Claude's sandbox can't reach Overpass.
- Old installs had an `update-ct.sh` that could not download its own
  replacement; the current one does `git pull` and restarts itself.
