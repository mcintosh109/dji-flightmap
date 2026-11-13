# DJI Flight Map

A self-hosted web page that shows your DJI flight logs on a map: where each
aircraft was **last seen**, every flight's path, and a replay of the flight
with height, speed, battery and GPS details.

It runs in a small **Proxmox LXC container** and reads the decrypted `.csv`
(or `.geojson`) files that your DJI sync service produces.

```
 DJI sync service  ──writes .csv files──▶  folder on Proxmox host
                                                   │  (shared read-only)
                                                   ▼
                                   LXC container "dji-flightmap"
                                   server.py  →  http://<ip>:8080
                                                   │
                                                   ▼
                                        your browser / phone
```

---

## What you need

- A Proxmox VE server (version 8 or 9) and root access to its shell.
- A folder **on the Proxmox host** where the decrypted flight logs end up
  (see Step 1).
- The container needs internet access once, during install (to download
  Debian packages). The browser needs internet to load the map pictures.

---

## Step 1: Find where your logs are saved

The map needs a folder on the Proxmox **host** that contains the `.csv` files.
Sub-folders are fine; it looks through all of them.

Pick the case that matches your setup:

| Your sync service runs… | What to use as the folder |
|---|---|
| directly on the Proxmox host | the folder it writes to, e.g. `/mnt/dji-logs` |
| inside another LXC container | the **host** side of that container's mount point. Run `pct config <its-ID>` and look for a line like `mp0: /mnt/dji-logs,mp=/data`; the part before the comma is the host folder |
| on a NAS / another machine | first mount the share on the Proxmox host (Datacenter → Storage → Add → SMB/CIFS or NFS). It appears under `/mnt/pve/<name>/` |

> Research keywords: *"proxmox lxc bind mount"*, *"proxmox mount point mp0"*.

---

## Step 2: Get this project onto the Proxmox host

Open the Proxmox shell (in the web UI: click your node → **>_ Shell**).

Install git (only needed once):

```bash
apt-get update && apt-get install -y git
```

Download the project:

```bash
git clone https://github.com/mcintosh109/dji-flightmap.git /root/dji-flightmap
```

> If the repository is **private**, git will ask for a username and a
> *personal access token* (not your password). Research: *"github personal
> access token git clone"*. Or download the ZIP from GitHub and copy it over
> with `scp` / WinSCP.

---

## Step 3: Create the container

Go into the project folder:

```bash
cd /root/dji-flightmap
```

Run the setup script. **Replace `/mnt/dji-logs` with your folder from Step 1:**

```bash
DATA_HOST_PATH=/mnt/dji-logs bash deploy/create-ct.sh
```

What the script does, in order:

1. Finds and downloads the newest Debian container template.
2. Creates an **unprivileged** container named `dji-flightmap`
   (1 CPU, 512 MB RAM, 4 GB disk, network via DHCP on `vmbr0`).
3. Shares your log folder into the container at `/srv/dji-logs`,
   **read-only**, so the map can never change or delete your logs.
4. Copies the app in and runs `deploy/install.sh` inside it.
5. Prints the web address when it is done.

Optional settings go in front of the command, the same way as `DATA_HOST_PATH`:

| Setting | Default | Meaning |
|---|---|---|
| `CTID` | next free number | container ID |
| `STORAGE` | `local-lvm` | where the container's disk is stored |
| `BRIDGE` | `vmbr0` | network bridge |
| `IP` / `GATEWAY` | `dhcp` | a fixed address, e.g. `IP=192.168.1.50/24 GATEWAY=192.168.1.1` |

Example with a fixed address:

```bash
DATA_HOST_PATH=/mnt/dji-logs IP=192.168.1.50/24 GATEWAY=192.168.1.1 bash deploy/create-ct.sh
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
  replay it (keyboard: **Space** = play/pause, **← →** = skip, **Esc** = close).
- Top-right buttons: switch between the dark map and satellite, switch
  ft/mph ↔ m/km/h, and zoom out to show everything.

New log files are picked up automatically within about 30 seconds, and the
page checks for them every minute.

---

## Updating later

On the Proxmox host:

```bash
cd /root/dji-flightmap && git pull
```

Then copy the new version into the container (replace `105` with your
container's ID, shown in the Proxmox web UI or by running `pct list`):

```bash
CTID=105 bash deploy/update-ct.sh
```

Your settings in `/etc/default/dji-flightmap` are kept.

---

## Troubleshooting

**The page says "No flight logs found yet"**

1. Check that the files are visible inside the container:
   ```bash
   pct exec 105 -- ls -la /srv/dji-logs
   ```
2. If you get *Permission denied*, or the folder looks empty: unprivileged
   containers can only read files that everyone may read. On the **host**, run:
   ```bash
   chmod -R a+rX /mnt/dji-logs
   ```
   Research: *"proxmox unprivileged container bind mount permissions"*.

**The page doesn't load at all**

Check whether the service is running (inside the container: `pct enter 105`):

```bash
systemctl status dji-flightmap
```

Watch what the server is doing (Ctrl+C to stop watching):

```bash
journalctl -u dji-flightmap -f
```

**The status line says "1 unreadable"**

Hover over the status text to see which file failed and why. It is usually a
`.csv` that isn't a DJI flight log, or a file that was still being written.

**The map is grey but the flight lines show**

Your browser can't reach the map-picture servers (CARTO / Esri). It needs
internet access; the container itself does not.

---

## Settings

Inside the container, the settings live in `/etc/default/dji-flightmap`:

```
DATA_DIR=/srv/dji-logs      # where the logs are (inside the container)
PORT=8080                   # web page port
SCAN_SECONDS=30             # how often to look for new files
CACHE_FILE=/var/lib/dji-flightmap/summaries.json
```

After changing them, restart the service:

```bash
systemctl restart dji-flightmap
```

---

## Security note

There is **no login**. Anyone who can reach the address can see where your
drone has flown. Keep it on your home network. To view it from outside, use a
VPN such as Tailscale or WireGuard rather than opening a port on your router.

---

## How it works (for learning)

| File | What it is | Research keywords |
|---|---|---|
| `app/server.py` | The server, in Python with no add-ons. Scans the folder, reads each CSV, and answers `/api/flights` with JSON | *"python http.server"*, *"python csv DictReader"*, *"haversine formula"* |
| `app/static/index.html` | The page layout | *"HTML basics"* |
| `app/static/style.css` | Colours and layout, including the phone layout | *"CSS flexbox"*, *"CSS media queries"* |
| `app/static/app.js` | Fetches the data and draws the map with Leaflet | *"javascript fetch"*, *"leaflet polyline"*, *"leaflet divIcon"* |
| `app/static/vendor/leaflet/` | A copy of the Leaflet 1.9.4 map library (BSD-2 licence), so the page doesn't depend on a CDN | *"leafletjs"* |
| `deploy/create-ct.sh` | Runs on the Proxmox host; creates the container | *"pct create"*, *"pveam"* |
| `deploy/install.sh` | Runs inside the container; installs the app | *"bash script basics"* |
| `deploy/dji-flightmap.service` | Tells Linux to run the server at boot and restart it if it crashes | *"systemd service file"* |

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

### Trying it on your own computer

You need Python 3.11 or newer. From the project folder:

```bash
DATA_DIR=/path/to/some/logs CACHE_FILE=./cache.json python3 app/server.py
```

Then open <http://localhost:8080>.
