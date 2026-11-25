# DJI Flight Map

A self-hosted web page that shows your DJI flight logs on a map: where each
aircraft was **last seen**, every flight's path, and a replay of the flight
with height, speed, battery and GPS details. An optional login page keeps it
private.

It runs in a small **Proxmox LXC container** and reads the decrypted `.csv`
(and `.geojson`) files that the
[dji-rc2-dock](https://github.com/mcintosh109/dji-rc2-dock) sync service
saves to TrueNAS.

```
 RC 2 controller ─▶ Raspberry Pi (dji-rc2-dock) ─▶ TrueNAS
                                                   \\<truenas-ip>\<share>\...\archive
                                                               │
                                     connected read-only (SMB) │  setup-truenas-mount.sh
                                                               ▼
                                         Proxmox host:  /mnt/dji-archive
                                                               │
                                         shared read-only      │  create-ct.sh
                                                               ▼
                                   LXC container "dji-flightmap":  /srv/dji-logs
                                   server.py  →  http://<container-ip>:8080
```

Only the `archive` folder is read. Each dock session's dated folder
(`archive/2026-11-13_14-39-15/parsed/…`) is found automatically, and the
`raw/` `.txt` files are ignored. If the same flight was saved in more than
one folder, it is shown only once.

---

## What you need

- A Proxmox VE server (version 8 or 9) and its root shell.
- The TrueNAS username and password you use to open the share in Windows.
- Internet access for the container during install (to download Debian
  packages). Your browser needs internet to load the map pictures.

---

## Installing: the quick way (one command)

1. In the Proxmox web page, click your server's name on the left (under
   *Datacenter*), then **>_ Shell**.
2. Copy this whole line, paste it into the Shell with **Ctrl+Shift+V**, and
   press **Enter**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/mcintosh109/dji-flightmap/main/deploy/easy-install.sh)"
```

3. Answer its questions. Pressing **Enter** picks the suggested answer
   (shown in `[brackets]`):

| Question | What to answer |
|---|---|
| **Where are your flight logs?** | `1` for TrueNAS or another network share (where the dji-rc2-dock Pi saves them), `2` for a folder on the Proxmox server |
| TrueNAS address, folder, username, password | Only for `1`. See [Step 2](#step-2-connect-the-truenas-archive-folder) below for examples. Nothing shows while you type the password; that's normal |
| **Where to keep the container's disk** | Only asked if you have more than one storage. Enter = `local-lvm` |
| **Network address** | Enter = automatic, or type a fixed address like `192.168.1.50` |
| **Add a login page?** | Enter = yes, then choose a username and password (at least 8 characters) |
| **Backups on TrueNAS?** | Only with `1`. See [Backups on TrueNAS](#backups-on-truenas-recommended); Enter = later |

4. At the end it prints the map's address, like `https://192.168.1.50`.
   Go to [Step 4: Open the map](#step-4-open-the-map).

What it does: it downloads the newest **released** version to
`/root/dji-flightmap`, then runs the same scripts as the step-by-step way
below, so you end up with exactly the same result. If the map is already
installed, it offers to **update** it instead. Running it again is safe: it
never deletes anything. If it stops, it says why; fix that and paste the
same command again.

> **Pasting a command from the internet as root** gives it full control of
> your server, so only do it for projects you trust. To read the script
> first, open the address inside the quotes in your browser. (Research:
> *"curl pipe bash security"*.)

---

## Installing step by step (instead of the quick way)

The same install as the one command, one step at a time. Useful if you want
to see each part, or if the quick way stopped and you want to retry one
step.

## Step 1: Open the Proxmox shell and download this project

In the Proxmox web UI, click your node (the server name on the left), then
**>_ Shell**. Everything below is typed there.

Install git (only needed once):

```bash
apt-get update && apt-get install -y git
```

Download the project:

```bash
git clone https://github.com/mcintosh109/dji-flightmap.git /root/dji-flightmap
```

Go into the project folder (the next steps assume you are here):

```bash
cd /root/dji-flightmap
```

Switch to the newest **released** version (without this you would get the
newest *test* version):

```bash
git checkout -q "$(bash deploy/release-tags.sh | head -1)"
```

---

## Step 2: Connect the TrueNAS archive folder

```bash
bash deploy/setup-truenas-mount.sh
```

It asks four questions:

1. **TrueNAS IP address**, for example `192.168.1.10`.
2. **Folder**: copy it from the address bar in Windows Explorer. If Explorer
   shows `\\192.168.1.10\MyShare\DJI logs\archive`, type
   `MyShare/DJI logs/archive`. Pasting the whole Explorer address also works.
3. **TrueNAS username**.
4. **TrueNAS password**. Nothing shows on screen while you type it; that is normal.

Your address and login are saved only on the Proxmox host, never in this project.

What it does:

1. Installs `cifs-utils`, the Linux tool for Windows/SMB shares.
2. Saves your login in `/etc/smb-dji-flightmap.cred`, a file only `root` can read.
3. Adds a line to `/etc/fstab`, the list of drives to connect at boot.
   It saves a backup copy first, as `/etc/fstab.bak-dji-flightmap`.
4. Connects the share **read-only** at `/mnt/dji-archive` and shows how many
   flight CSV files it found.

If it says `Permission denied`, the username or password is wrong, or that
TrueNAS user isn't allowed to read the share. Run the script again to retry.

> Research keywords: *"mount cifs fstab"*, *"linux smb credentials file"*.

---

## Step 3: Create the container

```bash
bash deploy/create-ct.sh
```

What it does, in order:

1. Finds and downloads the newest Debian container template.
2. Asks for the container's **network address**: press Enter for automatic
   (DHCP), or type a fixed address such as `192.168.1.50`. With a fixed
   address it also asks for your router (gateway) and suggests the one this
   Proxmox server uses; press Enter to accept it.
3. Creates an **unprivileged** container named `dji-flightmap`
   (1 CPU, 512 MB RAM, 4 GB disk, on `vmbr0`).
4. Shares `/mnt/dji-archive` into the container at `/srv/dji-logs`,
   **read-only**, so the map can never change or delete your logs.
5. Copies the app in and installs it.
6. Asks whether you want a **login page**. Press Enter for yes, then choose a
   username and a password (at least 8 characters).
7. Prints the web address.

Optional settings go in front of the command:

| Setting | Default | Meaning |
|---|---|---|
| `CTID` | next free number | container ID |
| `STORAGE` | `local-lvm` | where the container's disk is stored |
| `BRIDGE` | `vmbr0` | network bridge |
| `IP` / `GATEWAY` | asks | skip the network question, e.g. `IP=192.168.1.50/24 GATEWAY=192.168.1.1` |

Settings must be in **capital letters**: `STORAGE=...` works, `storage=...` doesn't.
Example, putting the disk on a storage called `VM-Storage-Array`:

```bash
STORAGE=VM-Storage-Array bash deploy/create-ct.sh
```

---

## Step 4: Open the map

Open the address the script printed, for example `http://192.168.1.50:8080`.

- **Aircraft** tab: each drone (grouped by serial number), when and where it
  was last seen, and a **Navigate** button that opens Google Maps directions
  to that spot.
- **Flights** tab: every flight, newest first, grouped by day. Type in the
  box to filter.
- Click a flight to see its path, statistics and a height chart. Press ▶ to
  replay it: only that flight's path is shown, the drone glides along it, the part already flown is drawn
  bright and the rest faint. **Follow** keeps the map centred on the drone;
  dragging the map turns it off.
  Keyboard: **Space** = play/pause, **← →** = skip, **F** = follow, **Esc** = close.
- Top-right: the **magnifying glass** (find an address, see below), the
  **layers button** (Road, Satellite, Dark, Terrain, each
  with a small picture of your area, plus **Details** for road and place names
  on satellite, and **Places**), ft/mph ↔ m/km/h, and show everything.
- Top of the left panel: ⚙ opens **Settings**, ↻ checks TrueNAS for new
  flights right away, and the door icon signs you out (when the login is on).

When the dock adds new flights, they show up within about a minute.

### Finding an address

To plan a flight somewhere new, go there on the map by its address:

1. Click the **magnifying glass** (top right, left of **Layers**). A search
   box opens. It closes again by itself, so it takes no room on the map.
2. Type an address, a town or a landmark, for example
   `12 Main St, Springfield, IL`, and press **Enter** (or **Find**).
3. Click the right answer in the list. The map goes there, close up, and puts
   a **red pin** with the name on it.
4. Plan as usual: the pin lets clicks through, so you can put a waypoint
   right on it. **Remove the pin** (in the search box) takes it away.

- Answers near the part of the map you're looking at come first. If the
  right one isn't listed, add the town or the state.
- **With Azure Maps as the provider, the addresses come from Azure Maps**
  (its *Get Geocoding* search; your key stays on the server). At most 200
  searches a day are sent to Azure; searching the same thing again within a
  day costs nothing. After that, or if Azure doesn't answer, OpenStreetMap is
  asked instead, and the box says so.
- **With the other providers, the addresses come from OpenStreetMap** (its
  free *Nominatim* search). It's a shared, free service, so it only searches
  when you press Enter, never while you type.
- It finds where a place is. It doesn't say whether you may fly there: check
  airspace and local rules as always.

### Places: what is around you

To help you get your bearings, the map can show shops, restaurants,
schools, parks, hospitals, petrol stations, hotels, airports and more, each
with a coloured icon. Turn it on or off with **Places** in the layers panel
(it starts on, and your choice is remembered in that browser).

- Places appear when you **zoom in** (about street level). Further out there
  would be thousands, so the layers panel says "Zoom in closer to see places".
- Zoom in one more step and the **names** appear under the icons.
- Click an icon for its name, address and opening hours (when known), a
  **Navigate** link, and a link to more details on OpenStreetMap.
- **With Google Maps as the provider, the places come from Google** (its
  Places service), so you see the same businesses as in the Google Maps app.
  Each search shows the 20 places nearest the middle of the map, and a new
  search only happens after you move the map a fair way. Searches count
  towards a **daily limit** (Settings → Map, 150 by default, which stays
  inside Google's free monthly amount); the layers panel shows how many are
  used today. When the limit is reached, places come back the next day.
  While Google's places show as pins, Google's own place labels are left out
  of the map pictures, so each place shows once (where Google allows that
  style; otherwise its labels stay).
- **With Azure Maps as the provider, the places come from Azure Maps**
  (its business search), which knows many small-town businesses that
  OpenStreetMap misses. They appear from a little further out (zoom 14, with
  smaller icons; where two would overlap, only the more useful one shows,
  e.g. a clinic before an office, until you zoom in to 16):
  each search shows the **100 places nearest the middle of the map**. New
  searches count towards a **daily limit** (Settings → Map, 150 by default),
  but answers are **remembered on your server for 30 days** (Azure's terms
  allow it), so looking at the same area again costs nothing. If Azure ever
  refuses, or the day's searches are used up, the map shows OpenStreetMap's
  places instead and says so. (Azure's business search is its older
  "Search 1.0": Microsoft's newest search has none. Microsoft says 1.0
  keeps working and hasn't announced an end date.)
- With every other provider, places come from **OpenStreetMap** (research:
  *"OpenStreetMap"*, *"Overpass API"*), the free map made by volunteers. It is very good in
  towns and can be thin in the countryside. If something is missing, anyone
  can add it at openstreetmap.org.
- It works with every map provider, needs no key and costs nothing. The
  container asks OpenStreetMap once per area and remembers the answer for a
  week, so looking around the same area again is instant.

> ⚠️ **Places is not a no-fly map.** Airports, heliports, schools, hospitals
> and stadiums are shown when OpenStreetMap knows them, but the map does not
> check airspace or local rules. Always check your local laws and
> regulations before flying.

---

## Planning a flight

Open the **Plans** tab in the sidebar and press **New plan**.

1. **Take-off point:** click the map where you'll take off, or press
   *Use the take-off point of my last flight*. It shows as **H**.
2. **Waypoints:** click the map to add them in order. **Right-click** a
   waypoint (or press and hold on a phone) for a menu with **Delete**. Drag a number to move
   it. In the table, change each waypoint's **height** (above take-off),
   **speed** and **pause**, or delete it with ✕. *Apply to all* gives every
   waypoint the "New waypoints" height and speed.
3. **The numbers:** distance, estimated flight time, battery used and battery
   left at landing. The battery estimate is based on **your own past flights**
   (how many % per minute they used). Wind can change it a lot.
4. **Warnings** appear when a waypoint is above your height limit, too far to
   keep in sight, the battery would land below your reserve, or the weather is
   a problem (strong wind up high, gusts, rain, cold, after sunset).
5. **When:** pick a date and time (up to 16 days ahead) to see the forecast at
   the take-off point: wind at ground level and at 80 m / 120 m, gusts, rain
   chance, temperature, sunrise and sunset. It comes from
   [Open-Meteo](https://open-meteo.com), free with no key.
6. **Compare with a past flight** draws one of your flights in grey dashes.
7. **Save plan**. Saved plans are listed in the Plans tab and kept on the server
   (`/var/lib/dji-flightmap/plans.json`, included in the update backups).

Limits are in **⚙ Settings → Flight planner**.

> ⚠ **The planner is a planning aid only.** It checks height, distance,
> battery and weather. It does **not** check airspace, obstacles (trees,
> towers, power lines) or local rules. **Always check your local laws and
> regulations before flying**: airspace (in the US: the FAA's
> [B4UFLY](https://www.faa.gov/uas/getting_started/b4ufly) app or Aloft), any
> permission you need, and the weather where you are. You are responsible for
> every flight.

### Sending a plan to DJI Fly (Mini 4 Pro, RC 2)

**Download for DJI Fly…** in a saved plan makes a DJI Fly **waypoint mission**
file (`.kmz`) that the drone flies **by itself**. (Research: *"DJI Fly
waypoints"*, *"KMZ WPML"*.)

**DJI Fly has no import button.** The file is put in place of a mission DJI Fly
made itself (a *placeholder*). DJI doesn't support this officially, so a DJI Fly
update could change it. The file is written exactly the way DJI Fly writes its
own missions: it was checked against three missions made by a real RC 2.

What the window does:

- **Blocks the download** until the plan is saved, has at least 2 waypoints,
  every waypoint is at least 5 m (16 ft) above take-off and under your height
  limit, and no ⛔ warning is left (battery, wind, ...).
- **One speed:** DJI Fly has one speed for the whole route. If your waypoints
  have different speeds, **Apply and save** gives them all one speed, so the
  planner's time and battery estimates stay true.
- **At the end** and **if the signal is lost**: *Return to home* (the default)
  or *Land*.
- **Curves:** DJI Fly flies **smooth curves** through the middle waypoints,
  so the drone **cuts the corners** instead of passing exactly over them
  (DJI Fly has no straight-line choice). Leave room around them.
- **The take-off point isn't in the file.** DJI Fly counts every height from
  **wherever the drone takes off**, so take off from the plan's **H**.
- **Five boxes to tick:** airspace checked, local laws checked, the route is
  clear of trees, towers, power lines and buildings, you'll take off from the
  plan's take-off point, and you'll keep the drone in sight and take over if
  needed.

**Sending it to the RC 2 through the dock (automatic):**

If your RC 2 plugs into the [RC 2 dock](https://github.com/mcintosh109/dji-rc2-dock)
(the Raspberry Pi that copies its flight logs to the NAS), the dock can put the
route on the RC 2 for you. (Research: *"bearer token"*, *"SHA-256 checksum"*.)

- **Once:** on the map, **Settings → RC 2 dock → Make a dock key**. On the Pi,
  update dji-rc2-dock (`git pull`, then `sudo ./redeploy.sh` in its folder) and
  run `sudo dji-map-link`: type the map's address, paste the key. The key works
  like a password for the dock; the map only keeps a scrambled copy of it.
- **Slots (up to 4 routes on the RC 2 at once):** in DJI Fly, make up to 4
  **placeholder** missions with **2, 3, 4 and 5 waypoints**: the number of
  waypoints tells them apart (2 = slot 1, 3 = slot 2, 4 = slot 3, 5 = slot 4).
  Plug the RC 2 into the dock and unlock it; within about 2 minutes
  **Settings → RC 2 dock → Placeholder slots** shows each one with DJI Fly's
  picture of it. Press **Use as slot 1** (and so on) once for each. From then
  on the map remembers which mission is which slot, whatever route it holds.
  **Only these 4 missions can ever be replaced**; your own missions are safe.
- **Each time:** in the DJI Fly window, under **Send it to the RC 2**, pick the
  **slot** (it shows what each slot holds now), tick the five boxes and press
  **Send to RC 2**. Plug the RC 2 into the dock and unlock it: the dock does it
  on plug-in, and checks every 2 minutes while it is plugged in. Don't have
  that mission open in DJI Fly while it is sent.
- **Safety nets:** the dock only replaces the placeholder if it is **exactly**
  the file you picked (a mission edited in DJI Fly since is never overwritten),
  backs the old file up first (on the Pi in `/var/lib/dji-dock/mission-backups`
  and on the NAS in `mission-backups`), reads the new file back to check it,
  and puts the old one back if writing fails. The window then says **"On the RC
  2"** or why not.
- **Then:** open DJI Fly, open the mission and **check the route on its map**
  before flying, as below.

**Putting it on the RC 2 by hand:**

1. In DJI Fly, make a **placeholder** waypoint mission (any 2-3 points) and
   save it. Note its date and number of waypoints in DJI Fly's list.
2. Plug the RC 2 into your PC. In File Explorer open **DJI RC 2 → Internal
   shared storage → Android → data → dji.go.v5 → files → waypoint**, then the
   placeholder's folder (a long name of letters and numbers).
3. **Copy the `.kmz` that is already there to your PC first**, as a backup.
4. Rename the downloaded file to **exactly** the same name as that `.kmz`, copy
   it into the folder and choose **Replace**.
5. Unplug, open DJI Fly, open the placeholder mission and **check the route on
   its map**: the points, the heights (H), the speed and the end and
   signal-lost actions. The small picture in DJI Fly's list may still show the
   old route.
6. The first time, fly it **low and short, in an open field**, ready to press
   **pause** or take over with the sticks.

---

## The settings page (⚙)

Everything here is saved on the server, so it applies on every device.

| Section | What you can change |
|---|---|
| **Flight logs on the NAS** | Checked every time the page opens: does the NAS answer, is its share connected to the map, can the logs be read, is the automatic reconnect running. **Reconnect now** if something is wrong. See [When the NAS restarts](#when-the-nas-restarts). |
| **Map** | **Map provider**: who draws the map. *Free* (OpenStreetMap + Esri, no key), **CARTO**, **Azure Maps** (Microsoft's replacement for Bing Maps), **Google Maps**, **Mapbox**, **MapTiler**, or a custom "XYZ" tile address. Only the chosen provider's key box is shown. **Default layer** (Road, Satellite, Dark, Terrain), **Details** on satellite, and a live preview. A layer a provider doesn't have (e.g. Terrain on Azure Maps) uses the free one. |
| **Display** | Default units, flight path colour, replay speed, whether a flight opens at the landing or take-off spot, which app **Navigate** opens (Google Maps, Apple Maps, Waze), lines for all flights, and whether an open flight is shown on its own (on by default). |
| **Flights** | Hide flights shorter than N seconds (quick tests), hide flights without GPS, **nicknames** for each drone. |
| **Flight planner** | Height limit (400 ft by default), distance warning, battery to keep for landing, wind limit. |
| **Server** | How often to check for new files, how many days you stay signed in. |

**Getting a map key** (optional; the free styles need none):

- **CARTO** (Dark Matter, Positron): free at carto.com/basemaps/apikey.
  CARTO started requiring a key in late 2026; without one their maps show
  "API KEY REQUIRED". The free "Dark" style here doesn't use CARTO: it is the
  OpenStreetMap street map with its colours flipped.

- **Azure Maps** (road, dark grey, satellite, satellite + roads):
  1. Sign in to the Azure portal (portal.azure.com).
  2. Search for **Azure Maps Accounts**, then **Create**. Pick your
     subscription, a resource group (or make one, e.g. `dji-flightmap`), a
     name, and the **Gen2** pricing tier.
  3. When it's created, open it and go to **Settings → Authentication**.
     Copy the **Primary Key**.
  4. Recommended: in **Cost Management → Budgets**, add a small monthly
     budget with an email alert, so you hear about any unexpected use.
     Azure Maps has a free monthly allowance that personal use normally
     stays inside.

- **Google Maps** (road, dark, satellite, satellite + roads, terrain).
  Google's road map shows businesses, petrol stations, doctors and so on,
  like the Google Maps app.
  1. Sign in to the Google Cloud console (console.cloud.google.com) and
     pick (or create) the project your key belongs to.
  2. Go to **APIs & Services → Library**, search for **Map Tiles API**, and
     press **Enable**. Do the same for **Places API (New)** (for the
     businesses, see *Places* above). (Research: *"Google Map Tiles API
     enable"*.)
  3. Go to **APIs & Services → Credentials** and copy your API key (it
     starts with `AIza`). Recommended: under **API restrictions**, limit the
     key to exactly these two: **Map Tiles API** and **Places API (New)**.
     A key that can only do what the map needs is safer if it ever leaks
     (research: *"principle of least privilege"*).
  4. **Strongly recommended:** in **Billing → Budgets & alerts**, add a small
     monthly budget with an email alert. Google gives a free monthly amount
     of map pictures (100,000 at the time of writing) and charges after
     that. A screen of map is about 20–40 pictures.
  5. Paste the key on the settings page, choose **Google Maps**, and press
     **Save**. (The preview uses the saved key, so it shows Google maps
     after saving.)

  Google's rules, which the map follows: the **Google logo** and Google's
  credit text are always shown (bottom right, above any open panel), and
  map pictures are **not stored** on your server.

- **Mapbox**: make a free account at mapbox.com, then go to
  *Account → Access tokens* and copy the **Default public token**
  (it starts with `pk.`).
- **MapTiler**: make a free account at maptiler.com, then go to
  *Account → API keys* and copy a key.

Paste it on the settings page, pick one of that company's styles, and check
that the preview says **Preview loaded ✓** before pressing **Save**.

The keys are saved in `/var/lib/dji-flightmap/settings.json` inside the
container, a file only the map service can read.

**The Azure Maps and Google Maps keys never leave the server.** The map asks
*your server* for their pictures and copyright credits, and the server asks
Azure or Google over HTTPS with the key. The settings page only shows *"A key is saved"*: you can
replace or remove it, but the page can't read it back.

```
 browser ──"map picture 15/9650/12318"──▶ your map server ──HTTPS + key──▶ Azure Maps
 browser ◀──────── picture ────────────── your map server ◀─── picture ───
```

(The one time the key crosses your network is when you paste it into the
settings page and press Save, until the map page itself uses HTTPS.)

To keep this fast, the server reuses its connections to Azure and Google.
Azure pictures are also remembered in memory for as long as Azure's own
response says they are valid (at most a day, about 64 MB; restarting the
service empties that memory). Google pictures are never remembered on the
server, because Google's rules don't allow it; your browser keeps them only
as long as Google says it may.

The CARTO, Mapbox and MapTiler keys still go to the browser, because their
terms don't allow passing their maps through another server. Use a *public*
key for them (Mapbox `pk.`), never a secret one.

For Azure Maps and Google Maps, keep the budget alert anyway. If a key ever
leaks, make a new one (Azure: **Regenerate**; Google: **Credentials → your
key → Regenerate key**) and paste it into the settings page.

---

## The login page

The login is optional. Run these **on the Proxmox host**, replacing `105`
with your container ID (shown in the Proxmox web UI, or run `pct list`).

Turn it on, or change the username/password:

```bash
pct exec 105 -- bash /opt/dji-flightmap/deploy/set-login.sh
```

Turn it off:

```bash
pct exec 105 -- bash /opt/dji-flightmap/deploy/set-login.sh --off
```

How it protects you:

- The password is never stored as plain text, only as a **PBKDF2 hash**
  (a one-way scramble).
- You stay signed in for 30 days. Changing the password signs everyone out.
- After 10 wrong passwords in 15 minutes, that device is blocked for a while.

It is plain `http://`, not `https://`. That is fine at home, but **don't open
a port on your router** for it. To use it away from home, use a VPN such as
Tailscale or WireGuard.

> Research keywords: *"password hashing pbkdf2"*, *"http cookie HttpOnly"*.

---

## HTTPS (the padlock)

HTTPS encrypts everything between your browser and the map, including your
password when you sign in. Without it, anyone on your network who listens
can read it. (Research: *"HTTPS"*, *"TLS certificate"*.)

**It is on from the start**, with a certificate the map makes itself. Change
it in **Settings → Secure connection (HTTPS)**:

| Choice | What it means |
|---|---|
| **Private certificate** (the default) | No domain needed. Each device imports the map's certificate **once**, then shows the padlock. Renews itself; devices don't need to import again. |
| **Let's Encrypt** | A free certificate every device trusts straight away, for a name under a domain you own (or a free duckdns.org name). Renews itself every 60–90 days. Needs your DNS company's API key. |
| **Off (plain http)** | Everything, including your password, travels unencrypted on your network. |

You can also give the map a **name** (like `flightmap.home`) and change the
HTTPS **port** (443, the normal one, means no number in the address). Press
**Save**: the map switches by itself and the settings page moves to the new
address.

The map is at `https://<container-ip>` (or `https://<name>`). The old
`http://<container-ip>:8080` still works: it sends you to the https address,
so bookmarks keep working.

### The first time on each device (private certificate)

Until a device trusts the map's certificate, the browser warns *"Your
connection isn't private"*. That's expected.

1. On the warning page, click **Advanced** → **Continue to … (unsafe)**. (Only
   this once, and only for your own map.)
2. Sign in, open **Settings** (⚙) → **Secure connection (HTTPS)** →
   **Download the map's certificate**. It saves `flightmap-ca.crt`.
   (Or open `http://<container-ip>:8080/flightmap-ca.crt`.)
3. **Windows:** double-click the file → **Install Certificate** →
   **Current User** → **Next** → **Place all certificates in the following
   store** → **Browse** → **Trusted Root Certification Authorities** → **OK**
   → **Next** → **Finish** → **Yes**. Then close the browser completely and
   open it again.
4. **Android:** Settings → Security → Encryption & credentials → Install a
   certificate → **CA certificate** → pick the file. (Menu names vary a little.)
5. **iPhone / iPad:** open the download link in **Safari** → Allow →
   Settings → **Profile Downloaded** → Install. Then Settings → General →
   About → **Certificate Trust Settings** → turn the map's certificate on.

The certificate only works for **this map's address and name** (research:
*"X.509 name constraints"*), so even in the wrong hands it can't be used to
fake other websites. Its secret key never leaves the container.

If the container's address or the name changes, the map makes a new
certificate by itself, and the settings page tells you to trust it again on
each device.

### Let's Encrypt

1. You need a name under a domain you own (e.g. `flightmap.example.com`), or
   a free name from **duckdns.org** (e.g. `yourname.duckdns.org`).
2. In **Settings → Secure connection**, choose **Let's Encrypt**, type the
   name, choose who runs its DNS, and paste that company's API key. It is
   kept on your server like the map keys, and only handed to acme.sh.
   - **Cloudflare:** dash.cloudflare.com → My Profile → API Tokens → Create
     Token → *Create Custom Token*, with **two** permissions:
     *Zone → Zone → Read* and *Zone → DNS → Edit*, and your domain under
     *Zone Resources*. (acme.sh first looks your domain up in your Cloudflare
     account. If it can't find it, it says "invalid domain": usually the
     name is spelled differently from the domain in Cloudflare, or the token
     can't read the domain.)
   - **DuckDNS:** the token at the top of duckdns.org after signing in.
   - **GoDaddy:** developer.godaddy.com/keys (a *Production* key). GoDaddy may
     only allow its DNS API for larger accounts; if it is refused, move the
     DNS to Cloudflare (free) or use DuckDNS.
   - **Another company:** over 150 are supported; type its acme.sh name
     (like `dns_namecheap`) and its settings, as listed in the acme.sh
     *dnsapi* wiki.
3. Press **Save**. Getting the certificate can take a few minutes; the
   settings page shows progress, and explains the problem if it is refused.
   The map stays reachable the whole time.
4. The name must lead to the container on your network (see below).

The map uses **acme.sh** (a free, widely used tool, research: *"acme.sh"*),
which updates install from its official GitHub page.

### Opening the map by name

A name like `flightmap.home` only works if your network knows it:

- **Pi-hole:** Local DNS → DNS Records → Domain `flightmap.home`, IP
  `<container-ip>` → Add.
- **Router:** look for *Local DNS*, *DNS host names* or *Static DNS*.
- **Let's Encrypt names** can instead get a public DNS record pointing to the
  container's local IP. Some routers block that ("DNS rebinding
  protection"); then use the Pi-hole or router way.

### If a setting locks you out

If a certificate ever can't be made or loaded, the map stays on plain http
and the settings page says why. If you still can't reach it, switch HTTPS off
from the Proxmox Shell:

```bash
pct exec $(pct list | awk '/dji-flightmap/{print $1; exit}') -- bash /opt/dji-flightmap/deploy/set-https.sh --off
```

Then open `http://<container-ip>:8080` again. (`--private` turns it back on.)

Updates and backups keep the certificate files, so after an update or a
restore your devices still trust the map.

---

## Updating later

The map tells you when there's a new **released** version: a green **Update
available** notice appears in the sidebar. Click it, or the version number
next to "Flight Map", to see what's new and the update command with a
**Copy** button. (The map asks GitHub each time it opens, and every 6 hours
while it stays open; it can be turned off in Settings → Updates.)

**Released and test versions.** New work is first a *test version*. Once it
has been tried on a real server, it is *released*: marked on GitHub with a
tag such as `v2.3.0` (research: *"git tag"*). Only released versions are
offered by the update notice and installed by a normal update.

On the Proxmox host, one command does everything:

```bash
cd /root/dji-flightmap && bash deploy/update-ct.sh
```

(If you have more than one container named `dji-flightmap`, put
`CTID=111` in front, with your container's number.)

What it does:

1. **Asks GitHub** which versions exist and picks the newest release.
2. **Saves** your settings, map keys and login to the Proxmox host, in
   `/root/dji-flightmap-backups/` (root only; the newest 10 are kept).
3. **Saves the current version**, so the update can be undone.
4. **Installs** the new version.
5. **Puts your settings back**, only replacing files that changed.
6. **Checks that the map answers.** If it doesn't, it **undoes the update by
   itself**: the old version and your settings come back, and it prints the
   error so you can ask for help.

Afterwards, press **Ctrl+Shift+R** in the browser to load the new version.

### Test versions and going back

Try the newest test version (not released yet). Only do this when you want
to help test a change:

```bash
cd /root/dji-flightmap && bash deploy/update-ct.sh --test
```

Go back to an earlier release, for example if a new one misbehaves (your
settings are kept):

```bash
cd /root/dji-flightmap && bash deploy/update-ct.sh --version 2.3.0
```

If you type a version that doesn't exist, it lists the released versions.
A normal update afterwards brings you back to the newest release.

### Backups on TrueNAS (recommended)

Every update saves your settings, login and flight plans on the Proxmox
host. To also keep copies **on TrueNAS** (so they survive if the Proxmox
server's disk fails), and to make a backup **every day**:

1. On TrueNAS, create a folder named **`flightmap-backups`** **next to**
   `DJI Flight logs`, *not inside it*. The Pi dock can write inside
   `DJI Flight logs`; keeping the backups outside it means a dock problem
   can never touch them. Your TrueNAS user must be able to **write** to it.
   The backups contain your map keys and login hash, so only people you trust
   should be able to open the folder.
2. On the Proxmox host:

   ```bash
   cd /root/dji-flightmap && bash deploy/setup-backup-share.sh
   ```

   It suggests the folder (next to `DJI Flight logs`), reuses your TrueNAS
   login, checks it can write there, offers the **daily backup** (about
   3:30 AM), and makes the first backup straight away.

Back up right now at any time:

```bash
cd /root/dji-flightmap && bash deploy/backup-ct.sh
```

If TrueNAS isn't connected when a backup runs, it says so and keeps the
backup on the Proxmox host only (it never writes into the empty local folder).
Up to 10 backups are kept on the host and 10 on TrueNAS; older ones are
deleted automatically.

### Restoring settings (for example after rebuilding the container)

Put the newest backup into the container (it looks on the Proxmox host and
on TrueNAS):

```bash
bash deploy/restore-ct.sh
```

Or choose a specific backup (list them with `ls /root/dji-flightmap-backups`):

```bash
bash deploy/restore-ct.sh /root/dji-flightmap-backups/ct111_2026-11-14_10-00-00
```

It shows what it found and asks before changing anything.

---

### When the NAS restarts

If TrueNAS restarts (an update, a power cut, or on purpose), the map
**reconnects by itself** when it is back, usually within a few minutes. You
don't need to do anything.

How: a small helper on the Proxmox server, `deploy/nas-watch.sh`, checks
every minute (research: *"systemd timer"*):

1. **Does the NAS answer on the network?** If not, it waits. The NAS is
   probably off or restarting.
2. **Is the share connected on the Proxmox server, and can it be read?** If
   not, it connects it again.
3. **Does the map's container see it?** A container that started while the
   NAS was off keeps seeing the empty folder underneath, even after the share
   is back (research: *"proxmox lxc bind mount"*). Then the helper restarts
   the container, which takes about 20 seconds. To avoid restarting over and
   over, it does this at most once every 15 minutes.

**Settings → Flight logs on the NAS** shows these checks every time you open
it, and what the helper did last. **Reconnect now** asks the helper to do
all of it straight away (within a minute), without waiting the 15 minutes.

The helper is set up by the install and by every update. It never deletes
anything, and it waits while an update is running. To watch what it does,
run this in the Proxmox Shell:

```bash
bash /root/dji-flightmap/deploy/nas-watch.sh --verbose
```

---

## Troubleshooting

**Google Maps shows grey squares or the free map**

- Check the line under the preview on the settings page, and that the key
  is saved (*"✓ A key is saved on the server"*).
- The **Map Tiles API** must be enabled in Google Cloud (see *Getting a map
  key*), and billing must be set up for the project.
- The server's log says what Google answered (run on the Proxmox host):

```bash
pct exec $(pct list | awk '/dji-flightmap/{print $1; exit}') -- journalctl -u dji-flightmap -n 40 --no-pager
```

  Look for lines starting with `Google Maps`. For example *"Map Tiles API
  has not been used in project … or it is disabled"* means step 2 above.
  To see exactly what Google says about each kind of map, run this on the
  Proxmox host (it asks Google once per kind of map and never prints the key):

```bash
pct exec $(pct list | awk '/dji-flightmap/{print $1; exit}') -- python3 /opt/dji-flightmap/app/server.py --check-google
```

  *"Requested entity was not found … NOT_FOUND"* usually means the key's
  project can't use the Map Tiles API yet: check that the API is enabled in
  the **same project** as the key, that billing is linked to that project,
  and that the key's **API restrictions** allow the Map Tiles API. After
  Google refuses, the server waits a minute before asking again.
  The key itself is never written to the log.

**The browser says "Your connection isn't private" (NET::ERR_CERT_AUTHORITY_INVALID)**

The device doesn't trust the map's private certificate yet: import it (see
*HTTPS → Private certificate*). If you imported it, close the browser
completely and open it again.

**The browser says the certificate is for a different name (ERR_CERT_COMMON_NAME_INVALID)**

You opened the map by an address the certificate doesn't cover (the
settings page lists them). Use one of those, or put the new name in
Settings → Secure connection and press Save.

**The address search says "not available right now"**

The map server couldn't reach the search service. The container needs
internet access to `atlas.microsoft.com` (Azure) or
`nominatim.openstreetmap.org` (OpenStreetMap). Try again in a minute; the
lines starting with `Address search:` in the map server's log (see *Places
don't show up* below for the command) say why.

**Places don't show up**

- Zoom in further: places only appear at about street level.
- Open the layers panel: the line under **Places** says what is going on
  (for example "OpenStreetMap is busy": it is a free, shared service; move
  the map again in a minute).
- "0 places here" means OpenStreetMap doesn't know any places there yet.
  Check on [openstreetmap.org](https://www.openstreetmap.org): anyone can
  add a missing shop.
- The container needs internet access to reach `overpass-api.de` (or the
  spare server, `overpass.private.coffee`). See what the map server says
  (run on the Proxmox host):

```bash
pct exec $(pct list | awk '/dji-flightmap/{print $1; exit}') -- journalctl -u dji-flightmap -n 40 --no-pager
```

  Lines starting with `Places:` say how many places came back, or why not.

**The page says "No flight logs found yet"**

Check that the Proxmox host can see the files:

```bash
ls /mnt/dji-archive
```

If that is empty, the TrueNAS connection dropped. Reconnect:

```bash
mount /mnt/dji-archive
```

Then restart the container so it sees the folder again:

```bash
pct reboot 105
```

Check that the container can see the files:

```bash
pct exec 105 -- ls /srv/dji-logs
```

**Black squares on the satellite map**

A square of the map picture didn't load (a busy moment at the map
service), so the dark background shows through, sometimes with road names
on top. The map asks again by itself: the server tries twice, then the page
tries again after 1, 3 and 9 seconds, so squares fill in after a moment. If
a square stays black, look at the map's log for lines starting
`Azure Maps answered`:

```bash
pct exec $(pct list | awk '/dji-flightmap/{print $1; exit}') -- journalctl -u dji-flightmap -n 100 --no-pager
```

**The map was empty after the Proxmox server (or the NAS) restarted**

The container probably started before TrueNAS was reachable. The map fixes
this by itself within a few minutes (see [When the NAS restarts](#when-the-nas-restarts)),
or press **Reconnect now** in Settings → Flight logs on the NAS. If the
settings page says *"Automatic reconnect isn't running"*, run the update
once (it sets it up), or run the two commands above (`mount`, then `pct reboot`).

**The page doesn't load at all**

From the Proxmox host, check whether the service is running:

```bash
pct exec 105 -- systemctl status dji-flightmap
```

Watch what it is doing (Ctrl+C to stop):

```bash
pct exec 105 -- journalctl -u dji-flightmap -f
```

**The status line says "1 unreadable"**

Hover over the status text to see which file failed and why. Usually it's a
file that was still being copied. It is read again automatically on the next
check.

**I forgot the login password**

Set a new one with the `set-login.sh` command above.

**The map is grey but the flight lines show**

Your browser can't reach the map-picture servers (CARTO / Esri). The browser
needs internet; the container itself does not.

---

## Settings

Inside the container, settings live in `/etc/default/dji-flightmap`:

```
DATA_DIR=/srv/dji-logs      # where the logs are (inside the container)
PORT=8080                   # web page port
SCAN_SECONDS=30             # starting value; change it on the settings page
CACHE_FILE=/var/lib/dji-flightmap/summaries.json
SESSION_DAYS=30             # starting value; change it on the settings page
OVERPASS_URL=...            # optional: OpenStreetMap Overpass servers for Places, comma-separated
NOMINATIM_URL=...           # optional: the OpenStreetMap address search server
AUTH_USER=...               # added by set-login.sh
AUTH_PASSWORD_HASH=...      # added by set-login.sh
```

After changing them, restart the service (from the Proxmox host):

```bash
pct exec 105 -- systemctl restart dji-flightmap
```

---

## How it works (for learning)

| File | What it is | Research keywords |
|---|---|---|
| `app/server.py` | The server's entry point, in Python with no add-ons: every web address it answers (the `Handler` class) and start-up | *"python http.server"* |
| `app/flightmap/config.py` | Settings from environment variables, and where files live | *"python os.environ"* |
| `app/flightmap/flightlogs.py` | Reads one flight log (CSV or GeoJSON) into a summary and a track | *"python csv DictReader"*, *"haversine formula"* |
| `app/flightmap/library.py` | The list of all flights: scanning the folder, remembering what was read, showing duplicates once | *"python threading Lock"* |
| `app/flightmap/settings.py` | The settings page's values: defaults, checks, loading and saving | *"input validation"* |
| `app/flightmap/plans.py` | Saved flight plans: checks, loading and saving | |
| `app/flightmap/auth.py` | The optional login: password hashing, signed cookies, lock-out | *"password hashing pbkdf2"*, *"HMAC signed cookie"* |
| `app/flightmap/azure.py` | Fetches Azure Maps pictures and credits for the browser, so the key stays on the server | *"reverse proxy"* |
| `app/flightmap/gplaces.py` | Google places for the Google map, with the daily limit | *"Places API (New) Nearby Search"* |
| `app/flightmap/google.py` | The same for Google Maps: makes a "session", fetches pictures and credits, stores nothing | *"Google Map Tiles API"* |
| `app/flightmap/upstream.py` | Keeps connections to Azure and Google open and reuses them | *"HTTP keep-alive"*, *"connection pool"* |
| `app/static/index.html` | The map page layout | *"HTML basics"* |
| `app/static/login.html` | The login page (self-contained) | *"HTML form POST"* |
| `app/static/style.css` | Colours and layout, including the phone layout | *"CSS flexbox"*, *"CSS media queries"* |
| `app/static/common.js` | Tiny helpers every page shares | |
| `app/static/app.js` | What the map scripts share: the page's state, number formatting, the map and its icons | *"leafletjs"* |
| `app/static/layers.js` | The layers button (Road / Satellite / Dark / Terrain) | |
| `app/static/address.js` | The address search: the magnifying glass, the answers, the pin | *"Leaflet fitBounds"*, *"AbortController"* |
| `app/flightmap/geocode.py` | Finds an address: Azure Maps with the Azure map (daily limit), otherwise OpenStreetMap; at most 1 OpenStreetMap search a second, answers remembered a day | *"Azure Maps Get Geocoding"*, *"Nominatim usage policy"*, *"geocoding"* |
| `app/static/places.js` | Shops, schools, parks… on the map, drawn only for the area on screen | *"Leaflet divIcon"*, *"map tiles"* |
| `app/flightmap/places.py` | Asks OpenStreetMap for places, sorts them into kinds and remembers them for a week | *"Overpass API"*, *"Overpass QL"* |
| `app/static/overview.js` | The sidebar lists and the overview of all flights | *"leaflet polyline"* |
| `app/static/flight.js` | One open flight: its path, the details panel, the replay | *"requestAnimationFrame"* |
| `app/static/update-notice.js` | The version number, update notice and Updates window | |
| `app/static/main.js` | Loads data from the server, applies settings, starts the page | *"javascript fetch"* |
| `app/version.json` | The version number and "what's new" list, compared with the copy on GitHub to spot updates | *"semantic versioning"* |
| `app/static/updates.js` | Checks GitHub for a newer version; the Copy button | *"fetch JSON"*, *"clipboard copy javascript"* |
| `app/static/planner.js` | The flight planner: waypoints, estimates, safety checks, weather | *"leaflet draggable marker"*, *"Open-Meteo API"* |
| `app/static/maps.js` | Every map style, which style each provider uses for each layer, and the layer-button pictures | *"leaflet tileLayer"*, *"XYZ tiles"* |
| `app/static/settings.html`, `settings.js` | The settings page | *"HTML forms"*, *"fetch PUT JSON"* |
| `app/static/vendor/leaflet/` | A copy of the Leaflet 1.9.4 map library (BSD-2 licence) | *"leafletjs"* |
| `deploy/setup-truenas-mount.sh` | Proxmox host: connects the TrueNAS share | *"mount cifs fstab"* |
| `deploy/create-ct.sh` | Proxmox host: creates the container | *"pct create"*, *"proxmox bind mount"* |
| `deploy/update-ct.sh` | Proxmox host: backs up settings, installs a newer version, puts settings back, undoes it if the map doesn't start | *"pct push"*, *"pct pull"* |
| `deploy/restore-ct.sh` | Proxmox host: puts saved settings back into a container | |
| `deploy/ct-backup.sh` | Shared save/restore steps used by the scripts above and below | *"bash source"* |
| `app/flightmap/azplaces.py` | Places from Azure Maps (with the Azure map): 100 nearest, daily limit, remembered 30 days | *"Azure Maps Get Search Nearby"* |
| `app/flightmap/rc2.py` | Send to RC 2: the dock key, the RC 2's missions (as the dock saw them) and the sends waiting for the dock | *"bearer token"*, *"SHA-256"* |
| `app/flightmap/djifly.py` | A saved plan as a DJI Fly waypoint mission (.kmz), written exactly like DJI Fly's own | *"DJI WPML"*, *"KMZ"* |
| `deploy/nas-watch.sh` | Proxmox host, every minute: reconnects the NAS share after the NAS restarts, restarts the container if it still sees the empty folder, tells the settings page what it found | *"systemd timer"*, *"cifs mount"* |
| `deploy/nas-view.sh` | Run inside the container by `nas-watch.sh`: what the container sees of the logs folder | *"/proc/self/mountinfo"* |
| `deploy/release-tags.sh` | Lists the released versions, newest first (tags like `v4.2.0`; `4.2.0` without the v counts too) | *"git tag"* |
| `deploy/easy-install.sh` | Proxmox host: the one-command install. Downloads the newest release, then runs the scripts below in order (or offers an update) | *"curl pipe bash"* |
| `deploy/setup-backup-share.sh` | Proxmox host: connects the writable TrueNAS backup folder, turns on the daily backup | *"systemd timer"* |
| `deploy/backup-ct.sh` | Proxmox host: makes a backup now (the daily timer runs it) | |
| `deploy/install.sh` | Inside the container: installs the app | *"bash script basics"* |
| `deploy/set-login.sh` | Inside the container: sets up the login | |
| `deploy/set-https.sh` | Inside the container: the way back to plain http if HTTPS locks you out | |
| `app/flightmap/https.py` | Makes the private certificate (or asks Let's Encrypt via acme.sh), serves HTTPS, sends the old http address there | *"openssl req"*, *"acme.sh"*, *"HTTP 301 redirect"* |
| `deploy/dji-flightmap.service` | Runs the server at boot and restarts it if it crashes | *"systemd service file"* |

### What the CSV columns mean

The server uses these columns from the `dji-log-parser` CSV format:

| Column | Used for |
|---|---|
| `CUSTOM.dateTime` | flight date and time (rows dated 1970 are ignored) |
| `OSD.flyTime` | seconds since the motors started |
| `OSD.latitude`, `OSD.longitude` | position (rows at `0,0` = no GPS lock yet, skipped) |
| `OSD.height` | height above the take-off point, in metres |
| `OSD.xSpeed`, `OSD.ySpeed` | horizontal speed (m/s), combined into one speed |
| `OSD.zSpeed` | vertical speed; **negative means climbing** (DJI counts "down" as positive) |
| `OSD.yaw` | heading in degrees, 0 = north; rotates the drone icon |
| `OSD.gpsNum`, `OSD.flycState` | satellites and flight mode |
| `BATTERY.chargeLevel` | battery % |
| `APP.tip`, `APP.warn` | app messages; warnings show as orange dots on the path |
| `DETAILS.*`, `RECOVER.*` | aircraft name, serial number, total flight time |

`HOME.latitude` / `HOME.longitude` are **not** used: in the sample logs they
contain garbage values, so the first GPS point is used as the take-off spot.

Two files count as the **same flight** when they have the same aircraft serial
number and start time. The CSV is preferred over the GeoJSON.

### Editing in Visual Studio

The project includes `dji-flightmap.sln`, so it opens in **Visual Studio**
(2022 or newer) like any other solution. It's for **editing**: the map
itself runs on the Proxmox server, not on Windows.

1. In the **Visual Studio Installer**, make sure the **Python development**
   workload is ticked (it lets Visual Studio open `.pyproj` projects).
2. Start Visual Studio → **Clone a repository** → paste
   `https://github.com/mcintosh109/dji-flightmap` → **Clone**.
3. In **Solution Explorer**, double-click **dji-flightmap.sln**.
4. After editing: **Git** → **Commit or Stash** → write what you changed →
   **Commit All** → **Push** (the ↑ arrow).

Files are stored with Linux line endings even when edited on Windows
(`.gitattributes` and `.editorconfig` take care of it): a script with
Windows line endings fails on Linux with *"$'\r': command not found"*.
That's also why it's better to push from Visual Studio than to upload
edited files on GitHub's website. (Research: *"Visual Studio Git changes
window"*, *"CRLF vs LF"*.)

### Tests

`bash tests/run-all.sh` checks everything: privacy (nothing personal in the
repository), syntax and linters, the server, the pages in a hidden browser,
the one-command install, and the update scripts.
See [tests/README.md](tests/README.md). The tests use made-up flights only.

`CLAUDE.md` and `.claude/skills/release/` are notes for Claude (the AI that
helps build this project): how to explain things, the privacy rules, and the
checklist for every change.

### Trying it on your own computer

You need Python 3.11 or newer. From the project folder:

```bash
DATA_DIR=/path/to/some/logs CACHE_FILE=./cache.json python3 app/server.py
```

Then open <http://localhost:8080>.

---

## Licence

Copyright 2026 mcintosh109. DJI Flight Map was created by mcintosh109.

Licensed under the [Apache License, Version 2.0](LICENSE). In short: you may
use, change and share this project, including in your own products, as long
as you keep the copyright notice and the [NOTICE](NOTICE) file, which credits
the original author, and say what you changed. It comes with no warranty.

It includes the [Leaflet](https://leafletjs.com) map library (BSD 2-Clause
licence). "DJI" is a trademark of SZ DJI Technology Co., Ltd.; this project
is not affiliated with or endorsed by DJI.
