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
| `app/flightmap/` | One module per job: `config` (env + paths), `flightlogs` (read one log), `library` (all flights), `settings`, `plans`, `auth` (login), `azure` / `google` (key-hiding proxies), `upstream` (shared connection pool), `places` (OpenStreetMap places), `geocode` (address search), `djifly` (DJI Fly .kmz), `rc2` (Send to RC 2 via the dock). Modules read the environment at import, so tests set env vars first and re-import. |
| `app/version.json` | Version number + "what's new" notes. The page compares it with GitHub to show the update notice. |
| `app/static/` | Classic scripts sharing globals, loaded in this order by `index.html`: `common.js` (helpers), `updates.js`, `maps.js` (providers/layers), `app.js` (state, formatting, map, icons), `layers.js`, `places.js` (shops/schools/parks layer), `overview.js` (sidebar + all flights), `flight.js` (open flight + replay), `update-notice.js`, `main.js` (refresh + start), `planner.js`, `address.js` (address search). Each file wires its own buttons at the bottom. Also `settings.*`, `login.html` (self-contained), `style.css`, `vendor/leaflet` (1.9.4). |
| `deploy/` | `easy-install.sh` (host, the one-command install that runs the others), `nas-watch.sh` (host, every minute, reconnects the NAS) + `nas-view.sh`, `setup-truenas-mount.sh`, `create-ct.sh` (host), `install.sh` (in container), `update-ct.sh` + `restore-ct.sh` + `ct-backup.sh` (host), `set-login.sh` (container). |
| `tests/` | `run-all.sh` runs everything (privacy, syntax + ruff/shellcheck when installed, server, browser, update scripts). See `tests/README.md`. |

Inside the container: settings in `/var/lib/dji-flightmap/settings.json`
(0600), login in `/etc/default/dji-flightmap` (0600), service `dji-flightmap`.

## Making a change

Use the **release** skill (`.claude/skills/release/SKILL.md`) for every change.
Version numbers follow the owner's rule: a **whole new function** raises the
first number (the flight planner made it 2.0.0); improvements raise the middle
one; bug fixes the last one. **But for now, stay on 5.x.x** (the owner, Nov
2026: "we will not be moving to ver6 any time soon"): a whole new function
raises the MIDDLE number too (5.3.0 → 5.4.0). Never make 6.0.0 unless the
owner asks for it.
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
  `/mnt/dji-flightmap-backups` (10 kept, the owner's choice in 4.1.1). It sits NEXT TO `DJI Flight logs`,
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
  answer (>= 4000 places) is never cached. Azure's new Search 2026-01-01
  has **no POI search**; the superseded v1 does (see "Azure places").
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
- **Google Maps** (3.0.0): Map Tiles API 2D tiles through the server
  (`/tiles/google/<set>/...`, `/api/google-credits`), sets roadmap,
  satellite, hybrid (satellite + `layerRoadmap`), terrain (needs
  `layerRoadmap`), dark (roadmap + `styles`). Sessions are made per set and
  renewed on a 400/401/403. **Google's rules: never store tiles on the
  server** (only pass Google's Cache-Control on), always show the Google
  logo + the viewport `copyright` text. The viewport's `maxZoomRects` lowers
  `maxNativeZoom` where imagery stops: use the HIGHEST zoom among the rects
  containing the view's centre (one rect is the whole world at zoom ~3;
  taking the lowest stretched a world picture over the screen, 3.0.3).
  `server.py --check-google` prints Google's answer per map kind. `liftCredits()` in app.js keeps the
  credit line above the bottom panels (they used to cover it). The Google
  places data must not be put on a non-Google map, so Places stays
  OpenStreetMap. Tests use `GOOGLE_TILES_URL`. developers.google.com is not
  reachable from Claude's sandbox; rules came from search results.
- **Google places** (3.0.5): Google's 2D tiles leave out many businesses
  (the owner's DG, gas stations, doctor). With the Google provider, Places
  use Places API (New) `places:searchNearby` (20 nearest, rankPreference
  DISTANCE, Pro-only field mask: no rating/hours or the price goes up),
  through `/api/google-places`, with a daily limit `googlePlacesDailyLimit`
  (default 150, count in `google-places-usage.json`). Nothing stored on the
  server; the browser re-searches only after moving half the radius. The
  owner keeps a key restricted to Map Tiles + Places (New); don't suggest
  their 32-API key. The owner called this 3.0.5 (a fix from users' view).
- **HTTPS** (4.1.0): ON BY DEFAULT (owner's wish) with a private certificate;
  changed in Settings → Secure connection (`httpsMode` private/letsencrypt/
  off, `httpsName`, `httpsPort` 443, `httpsDnsApi`, server-only
  `httpsDnsCredentials` dict: the page only gets `httpsDnsCredentialsSet`
  names). `server.py` `Listeners.apply()` switches http/https live in a
  background thread after Save; `https.py` makes the private CA (P-256,
  10 years, nameConstraints = this IP + name) and an 825-day leaf whose CN is
  "DJI Flight Map" (an address-like CN breaks name constraints: OpenSSL
  "permitted subtree violation"), or runs acme.sh (/opt/acme.sh, installed by
  install.sh; `--server letsencrypt`; secrets by env, scrubbed from output).
  The old PORT only redirects (301/308), answers /api/health (with
  `httpsPort`) and serves /flightmap-ca.crt. Anything failing = plain http
  and an error on the settings page. Recovery: `set-https.sh --off`.
  Cloudflare (5.1.1): acme.sh's dns_cf finds the zone with `GET zones?name=`,
  so the help asks for **Zone.Zone:Read + Zone.DNS:Edit** (acme.sh's guide).
  "invalid domain" = zone not found; the owner's case was a misspelled name
  (Nov 2026), so `ACME_HINTS` in https.py puts a plain sentence first.
  Tests start servers with DEFAULT_HTTPS=off; FLIGHTMAP_IP fixes the address.
- **Release tags**: in Claude's sandbox, pushing a tag was blocked by the
  safety check (a public action). The owner then makes the release on
  GitHub: Releases → Draft a new release → new tag `vX.Y.Z` on `main`.
  Remind them of the **v**: a tag `3.0.5` (no v) is ignored by updates.js and
  update-ct.sh (it happened; they then added `v3.0.5`). It happened again
  with 4.2.0, so since 4.2.1 a tag without the v counts too
  (`deploy/release-tags.sh`, `TAG_RE` in updates.js; the v one wins when
  both exist). Older installs still only see v tags, so keep asking for the v. Don't push to `main`
  between asking for a release and the owner confirming it, or the tag
  lands on the wrong commit; work on a branch meanwhile.
- **Place names** (3.0.6): `hideOverlappingNames()` in places.js hides a
  name that would cover another name (6 px gap) or another icon (2 px
  tolerance); kinds in `NAME_ORDER` keep their names first.
- **No double places with Google** (3.0.7): while Google places show as pins
  (zoom 16+), the Google tile layer asks for `<set>-nopoi` (style hiding
  `poi` labels). The owner confirmed Google accepts it on hybrid (satellite +
  Details) too. A 400 on a -nopoi session falls back to the normal set.
- **Easy install** (4.2.0): `deploy/easy-install.sh`, run as
  `bash -c "$(curl -fsSL https://raw.githubusercontent.com/mcintosh109/dji-flightmap/main/deploy/easy-install.sh)"`
  (`bash -c "$(...)"`, not `curl | bash`, so the questions can read the
  keyboard). The copy on `main` is what users run, so keep it working with
  the scripts of the newest RELEASE: it clones to /root/dji-flightmap,
  checks out the newest `v` tag (`--test`: origin/main), and only calls
  setup-truenas-mount.sh, create-ct.sh (CTID/STORAGE/DATA_HOST_PATH env),
  setup-backup-share.sh and update-ct.sh from that checkout. Never deletes;
  an existing `dji-flightmap` container means "offer an update". The manual
  README steps also check out the newest tag (a plain clone is main = test).
  Tests: `tests/easy-install.test.sh` (pretend origin repo + fake pct/pvesm/pvesh).
- **NAS reconnect** (4.3.0): the container can't mount (unprivileged), and a
  container started while the host's share was missing keeps the EMPTY folder
  underneath its bind mount even after the host remounts (common after a
  power cut: Proxmox boots before TrueNAS). So: `flightmap/nas.py` only
  checks (mountinfo fstype of DATA_DIR = cifs?, TCP 445 to the NAS, listdir
  with an 8 s timeout in a thread) for `/api/nas`; the host's
  `deploy/nas-watch.sh` (dji-flightmap-nas.timer, every minute, installed by
  `install_nas_watch` in ct-backup.sh from update-ct.sh/create-ct.sh)
  repairs: NAS not answering = leave the old mount alone; host share
  unreadable = `umount -l` + `mount`; container not seeing it = `pct reboot`
  (max every 15 min, or at once for a "Reconnect now" request). They talk
  through files in STATE_DIR: the page writes `nas-request.json`, the host
  writes `nas-host.json` (via `pct exec ... sh -c 'cat > ...'`) and keeps its
  own memory in /var/lib/dji-flightmap-nas/state. `nas-view.sh` is piped into
  the container with `pct exec ... bash -s`, so it works whatever version is
  installed there. Never restart for an empty share (a new install), and skip
  while update/restore/create/easy-install runs. Tests: NasRules/LiveNas,
  `tests/nas-watch.test.sh`, the settings-page part of browser.test.js.
- **Visual Studio** (after 4.3.0): the owner edits in Visual Studio, so the
  repo has `dji-flightmap.sln` + `dji-flightmap.pyproj` (wildcard items, so
  new files need no change there), `.gitattributes` (`eol=lf` for
  everything except the VS files; `app/static/vendor/**` is `-text` so
  Leaflet's CRLF files stay as published) and `.editorconfig`. Their commits
  may now come from Windows: before building on them, check scripts still
  have LF endings and run the full tests.
- **Azure places** (5.1.0): with the Azure provider, Places come from Azure
  Search **v1** `GET /search/nearby/json?api-version=1.0` (100 nearest,
  radius 1/2/5 km) via `/api/azure-places` (`flightmap/azplaces.py`). v1 is
  "superseded" but "continues to function", no end date (Microsoft Learn,
  Nov 2026); places.js falls back to OpenStreetMap on ANY error or the daily
  limit (`azurePlacesDailyLimit`, default 150, `azure-places-usage.json`).
  Azure's terms allow caching up to 6 months, so answers are kept 30 days in
  `azure-places-cache.json`, searches snapped to a 0.01° grid so nearby
  views share one. Shown from zoom 14 (others 16); below 16 `hideOverlappingIcons()`
  draws icons at 75% and hides any covering another (ICON_ORDER: air, health,
  school... work last), because 100 places at zoom 14 were too noisy (owner). Classification codes ->
  kinds by whole words (BARBER_SHOP must not be a bar).
- **Black squares** (5.1.0): failed map pictures stayed empty. `azure.py`
  asks Azure twice (408/429/5xx or no answer); `retryFailedTiles()` in
  maps.js retries a failed square after 1, 3, 9 s (own-server URLs get
  `?r=n`). Tests: FakeAzure `fail_next`, browser `failTile`.
- **Azure road names look bold** (5.1.0): Azure's hybrid labels are thick white
  with a dark outline (owner: Windows 100%, browser 100%, so not stretching).
  The overlay is drawn at opacity 0.8 (`AZURE_LABELS_OPACITY` in maps.js), the
  owner's choice. Most Azure raster tilesets only come as 256 px
  (Microsoft Q&A), so 512-px tiles are no way to fewer requests.
- **DJI Fly missions** (5.0.0): `flightmap/djifly.py` + `/api/plans/<id>/djifly.kmz`
  (Download for DJI Fly… in the planner). DJI Fly (RC 2) has NO import: the
  file replaces a placeholder mission's `.kmz` in
  `Android/data/dji.go.v5/files/waypoint/<UUID>/<UUID>.kmz` (next to
  `capability/`, `map_preview/`; names are NOT in the file, DJI Fly keeps
  them elsewhere; its list shows length, waypoint count, date). The format
  was copied from three missions made by the owner's RC 2 (kept OUT of the
  repo: they hold real coordinates) and the builder reproduced all three
  byte for byte: namespace `uav.com/wpmz/1.0.2`, droneEnumValue 68, heights
  `relativeToStartPoint`, ONE global speed (waypointSpeed =
  globalTransitionalSpeed; autoFlightSpeed is always 2.5), first/last points
  "Stop" + headingAngleEnable 1, middle "Pass" (curves: DJI Fly has no
  straight option, and its map still drew curves for `useStraightLine=1`,
  so that option was removed), group 1 at a
  point = gimbalRotate at wp0 then hover (hoverTime s), group 2 =
  gimbalEvenlyRotate to the next point (none after the last), actionIds count
  up, zip entries dated 1980. Finish: goHome/autoLand; signal lost:
  goBack/landing (DJI Fly also has Hover/Back to Start/Continue: not seen in
  a file yet). The take-off point is NOT in the file (heights count from
  wherever the drone takes off): a checklist box says so. The owner's hand
  test (Nov 2026): DJI Fly opened our files, with the right waypoints and
  heights. First real flight (Nov 2026, 5.1.0 test version): the Mini 4 Pro
  flew all 4 waypoints, reached the planned heights counted from take-off
  (200 ft at the last point) and did Return to Home at the end. Plan: owner tests by hand first, then the dock copies missions
  (map lists the RC 2's missions, owner picks the placeholder, dock backs up).
- **Send to RC 2** (5.2.0): `flightmap/rc2.py` + dji-rc2-dock's `dji-missions.py`.
  The owner chose: the DOCK ASKS THE MAP (the map stays read-only on the NAS),
  routes go on plug-in AND every 2 min while docked. SLOTS (the owner's
  design, 5.2.0): up to 4 placeholders, told apart by waypoint count:
  2/3/4/5 waypoints = slot 1/2/3/4 (DJI Fly probably can't save 1 waypoint: unchecked), confirmed
  once in Settings ("Use as slot N", `rc2-slots.json` slot -> UUID), then
  remembered by UUID whatever they hold; sends go to a SLOT (POST
  /api/plans/<id>/rc2 {slot}); no other mission can be targeted. Dock key `dock_...` made in Settings → RC 2 dock,
  shown once, only its SHA-256 kept (`dock-key.json`); the Pi sends it as
  `Authorization: Bearer` to `/api/dock/*` (bypasses the login, counts as a
  failed login when wrong). The Pi reports each mission's whole .kmz + DJI
  Fly's `map_preview/` picture (PUT /api/dock/missions); the map reads the
  points itself. A send stores the .kmz made at send time (`rc2-outbox/`) and
  `expectSha256` = the placeholder as last reported: the Pi refuses if the
  file on the RC 2 differs (edited in DJI Fly since). Pi side: backup on the
  Pi (must work) + NAS `mission-backups/`, write over MTP (jmtpfs), read back,
  put the old one back on failure, POST /api/dock/result/<id>. Setup on the
  Pi: `sudo dji-map-link` (/etc/dji-map-link.conf 0600; a private-cert map's
  CA is fetched from :8080/flightmap-ca.crt after confirming its
  fingerprint). Tests: LiveRc2, browser "RC 2:", dock `tests/test-missions.py`
  + `tests/test-sync.sh`. First real send (24 Nov 2026): the 2-minute
  check wrote a route into slot 1 over MTP (jmtpfs), read it back
  ("Written to the RC 2 and checked"), and the map showed it done.
- **Address search** (5.3.0, owner's wish: "does not take up room on the
  map"): a magnifying-glass chip first in `#map-tools`, its panel drops down
  (`.addr-wrap` is NOT position:relative, so the panel lines up with the
  tools' right edge and fits on a phone). `/api/geocode?q=&lat=&lon=`
  (`flightmap/geocode.py`): with the Azure provider + key, Azure **Get
  Geocoding** `api-version=2026-01-01` (`coordinates` = lon,lat; GeoJSON
  answer, bbox W,S,E,N), max 200 a day (`azure-geocode-usage.json`), AND
  always OpenStreetMap **Nominatim** (`NOMINATIM_URL`): own User-Agent,
  >= 1.1 s between searches, `viewbox` ~1° to prefer nearby, only on Enter
  (no type-ahead). Why both: the owner searched for a waterfall (a hiking
  spot; its name stays out of this public repo) and Azure only matched
  words (a forest, a town, a county):
  Get Geocoding has hardly any POIs. So also Azure Search v1 **Get Search
  POI** (`/search/poi/json`, lat/lon bias; the owner's Azure Places icon knew
  the waterfall) - one daily count for both Azure requests; if v1 fails the
  rest still shows. `_merge`: Azure POIs, Azure addresses, then OSM, sorted
  by (searched words in the name, exact first part, road last unless a road
  word was typed: the owner picked "... Falls Road" over the falls), same
  place (~50 m + same first words) once, max 8; each result has `from`. Answers remembered in memory
  a day, unless a company failed. Coordinates (decimal, N/S/E/W, deg/min/sec,
  from Google Maps' right-click) are read in the page (`readCoordinates`)
  and go straight there, nothing sent. OSM's category/type words
  (highway/tertiary...) become plain words in `osm_kind` ("Road",
  "Waterfall"): the owner saw "Tertiary". The pin is `interactive: false` so waypoints
  can go on it. The Nominatim policy page was not reachable from Claude's
  sandbox (Nov 2026): rules taken from search results.
- **Right-click the map** (5.3.0, owner's wish: "right click then create
  flight plan here"): `mapMenu` in planner.js, a Leaflet popup like the
  waypoint menu. No plan open: "Create a flight plan here" = a new plan with
  `home` on that spot; with a plan: take-off, then "Add a waypoint here"
  (`addPoint`, shared with map clicks). Waypoint markers call
  `L.DomEvent.stopPropagation(e)` so their own menu wins. Phones: long press.
- **Plan flags** (5.3.0, owner's wish: "a blip on the map ... when you are in
  the plans module"): `showBlips()` in planner.js, a purple flag per saved
  plan at its `home`, only while `state.tab === 'plans'` and no plan is open
  (overview.js's tab click calls `Planner.showBlips({ fit: true })`: if none
  is on screen, fit them). Tooltip = name, waypoints, distance; click opens;
  hovering a plan card lights its flag. 5.4.0 (owner: "make the plans points
  stand out alot" = the flags, not the waypoints): 40 px icon, a 32 px
  #c04dff dot with a white rim and a pulsing `.ring` (`blip-pulse`, still
  under prefers-reduced-motion). zIndexOffset 3000: plans often start
  where the last flight took off, under the drone icon (500).
- **README pictures** (5.3.0): `docs/images/*.png`, made by
  `node docs/make-pictures.js` from the test flights (Central Park, fake
  serials) with pretend places/addresses/weather; the map underneath is
  plain because Claude's sandbox can't load map pictures (the README says
  so). Never use the owner's real screenshots there (they show where they
  fly). Re-run it after visible changes; check each picture before committing.
- **Planner layout** (5.3.0, owner's choice "A" after seeing mock-ups of two
  options; their 32-inch screen looked tight): on a wide screen
  (`min-width: 761px`), `placeEditor()` moves `#pl-editor` (name, Save, ✕,
  waypoints, When, Compare, Notes, DJI Fly) into `#panel` while a plan is
  open (`#panel.editing` hides the tabs, `:root.plan-open` makes the sidebar
  400 px); `#planner` at the bottom keeps the numbers, warnings, weather and
  the disclaimer. A phone keeps one panel (editor moved back into
  `#planner`, which scrolls with a sticky top row). Styles use `.plan-ui`,
  not `#planner`, since the editor moves. While editing, the tabs are hidden:
  ✕ is the way back (it asks if unsaved). The map's credit line floats above open bottom panels
  ON PURPOSE (`liftCredits`, map terms): the owner asked about it; keep it.
- **Why OpenStreetMap places** (5.4.0): the owner saw "Still waiting for
  OpenStreetMap" with Azure as provider: today's Azure places limit was used
  up, but the page didn't say so (the reason was overwritten) and the layers
  foot always said "Places come from OpenStreetMap". Now `azureWhy` stays in
  front of the status while OSM stands in, `#places-from` names the real
  source, and `azureOffUntil` = Infinity for 429 (used up) or now + 5 min for
  any other failure (then Azure is asked again on the next map move). The
  owner raised the limit to 200 on the settings page.
- **Place hover labels** (5.4.0, owner: "when you hover over a places icon it
  shows you what you are looking at"): `hoverText()` in places.js, a Leaflet
  tooltip `.place-tip` (name + label · kind group), replacing the old
  `title`. Leaflet also opens tooltips on click, so the tooltip is closed
  while the place's popup is open (`popupopen` / `tooltipopen`).
- **Battery choice** (5.4.0, owner's wish: select "the ultralight battery vs
  the normal" one in planning): Mini 4 Pro batteries per DJI's specs:
  standard 2590 mAh / 77.9 g / 34 min (drone under 249 g), Plus 3850 mAh /
  121 g / 45 min (over 249 g; not sold in Europe). `flightlogs.py` reads the
  first `BATTERY.fullCapacity` (mAh) per log; `battery_kind()` = "plus" if
  >= 3200 mAh (`PLUS_BATTERY_MAH`, midway, as batteries lose capacity with
  age), only for aircraft names containing "Mini", else "" (summary fields
  `batteryCapacity`, `batteryKind`; CACHE_VERSION 4). Plans store `battery`
  ("standard" default, old plans read as standard). `batteryRate(kind)` in
  planner.js: flights with that battery; none -> the other battery's rate
  scaled by DJI's times (34/45); logs without capacity -> all flights;
  nothing -> typical 3 %/min (standard) scaled. The note under the numbers
  says which, and for Plus that the drone is over 249 g (US: FAA
  registration + Remote ID; sources disagreed on Remote ID details, so the
  text stays general and says to check local rules). Fixture flight B is a
  Plus battery (3790 mAh); the others 2453 mAh. Confirmed on the owner's
  real logs (Nov 2026): "your last 13 flights with the Plus battery (about
  3.4% per minute)", so dji-log-parser's `BATTERY.fullCapacity` is filled.
- **Code review** (5.4.0, owner: "go through the code and clean it up"):
  ruff (strict), eslint (scripts concatenated in load order; MapStyles and
  Updates are `window.` globals) and shellcheck were clean. Bugs fixed, each
  with a test that FAILED on the old code: `loadWeather` wrote a late answer
  into the newer request's object (now each request fills its own `mine`);
  `save()` twice on a new plan made two plans (one save at a time, Save
  disabled meanwhile; edits during a save stay dirty); `body_length()` in
  server.py refuses a negative/garbled Content-Length (reading -1 bytes
  waited for the client, even on /api/login). Left alone on purpose:
  `renew_forever` re-applies the listeners twice a day (a ~0.5 s gap for new
  connections; HTTPS code is delicate), ruff's style-only notes (bare
  `return` in handlers, small lambdas), ElementTree on dock .kmz (the dock is
  authenticated; Python's expat resists entity bombs).
- **Login security review** (owner asked; the owner named this version
  **5.4.2** "since we are finding and fixing security bugs", skipping the
  never-released 5.4.0/5.4.1). Fixed: (1) the lock-out (10 failures / 15 min
  per IP) counted a failure only AFTER the ~1 s check, so guesses sent at
  once were all checked: now `auth.start_attempt(ip)` counts first (a
  ticket), `forget_attempt` takes it back on success, `end_attempt` keeps it;
  also used for dock keys. (2) The locked-out answer was sent before reading
  the form, so closing the socket with unread data sent a TCP RST (browser
  "connection reset" page); the form is now read first. Test:
  `LiveLoginLockout` (30 guesses at once, own server so it can't lock out
  the other tests). Fine as is: PBKDF2-SHA256 600k + salt, constant-time
  compares, HMAC-signed cookie (HttpOnly, SameSite=Lax, Secure on https,
  key = secret file + password hash), X-Frame-Options DENY, the error text
  is fixed strings via textContent, no X-Forwarded-For trust. Not done
  (offered to the owner): "sign out everywhere" (a copied cookie stays valid
  until it expires; changing the password signs everyone out).
  How big the race was depends on timing: with the REAL strength (600,000
  rounds) the old code let 11 (curl) to 30 of 30 (Python threads) guesses
  through; with a test hash of 1000 rounds the gap was too short to show it,
  so `LiveLoginLockout` uses 600_000 (and records broken connections instead
  of stopping, so both bugs fail separately on the old code).
- **Security check tools stay OUT of this repo** (owner's wish, 5.4.2): the
  owner keeps their own live-server security check on the Proxmox host,
  outside the project folder. Don't add attack or security-check scripts
  here; the automatic tests in `tests/` (e.g. `LiveLoginLockout`) stay.
- Old installs had an `update-ct.sh` that could not download its own
  replacement; the current one does `git pull` and restarts itself.
