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
2. Creates an **unprivileged** container named `dji-flightmap`
   (1 CPU, 512 MB RAM, 4 GB disk, network via DHCP on `vmbr0`).
3. Shares `/mnt/dji-archive` into the container at `/srv/dji-logs`,
   **read-only**, so the map can never change or delete your logs.
4. Copies the app in and installs it.
5. Asks whether you want a **login page**. Press Enter for yes, then choose a
   username and a password (at least 8 characters).
6. Prints the web address.

Optional settings go in front of the command:

| Setting | Default | Meaning |
|---|---|---|
| `CTID` | next free number | container ID |
| `STORAGE` | `local-lvm` | where the container's disk is stored |
| `BRIDGE` | `vmbr0` | network bridge |
| `IP` / `GATEWAY` | `dhcp` | a fixed address |

Example with a fixed address:

```bash
IP=192.168.1.50/24 GATEWAY=192.168.1.1 bash deploy/create-ct.sh
```

(Change those numbers to a free address on your own network.)

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
- Top-right buttons: dark map ↔ satellite, ft/mph ↔ m/km/h, and show everything.
- The arrow-out-of-a-door icon next to the refresh button signs you out.

When the dock adds new flights, they show up within about a minute.

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

## Updating later

On the Proxmox host:

```bash
cd /root/dji-flightmap && git pull
```

```bash
CTID=105 bash deploy/update-ct.sh
```

Your settings and login are kept.

---

## Troubleshooting

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

**The map was empty after the Proxmox server rebooted**

The container probably started before TrueNAS was reachable. The fstab line
tells Proxmox to connect first, but if TrueNAS was still booting, run the
two commands above (`mount`, then `pct reboot`).

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
SCAN_SECONDS=30             # how often to look for new files
CACHE_FILE=/var/lib/dji-flightmap/summaries.json
SESSION_DAYS=30             # how long you stay signed in
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
| `app/server.py` | The server, in Python with no add-ons. Scans the folder, reads each CSV, handles the login, and answers `/api/flights` with JSON | *"python http.server"*, *"python csv DictReader"*, *"haversine formula"* |
| `app/static/index.html` | The map page layout | *"HTML basics"* |
| `app/static/login.html` | The login page (self-contained) | *"HTML form POST"* |
| `app/static/style.css` | Colours and layout, including the phone layout | *"CSS flexbox"*, *"CSS media queries"* |
| `app/static/app.js` | Fetches the data and draws the map with Leaflet | *"javascript fetch"*, *"leaflet polyline"* |
| `app/static/vendor/leaflet/` | A copy of the Leaflet 1.9.4 map library (BSD-2 licence) | *"leafletjs"* |
| `deploy/setup-truenas-mount.sh` | Proxmox host: connects the TrueNAS share | *"mount cifs fstab"* |
| `deploy/create-ct.sh` | Proxmox host: creates the container | *"pct create"*, *"proxmox bind mount"* |
| `deploy/update-ct.sh` | Proxmox host: installs a newer version | *"pct push"* |
| `deploy/install.sh` | Inside the container: installs the app | *"bash script basics"* |
| `deploy/set-login.sh` | Inside the container: sets up the login | |
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

### Trying it on your own computer

You need Python 3.11 or newer. From the project folder:

```bash
DATA_DIR=/path/to/some/logs CACHE_FILE=./cache.json python3 app/server.py
```

Then open <http://localhost:8080>.
