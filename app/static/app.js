'use strict';
/*
  Flight Map - the map page. This file holds what the other map scripts
  share: the page's state, number formatting, the map itself and its icons.

  The map page's scripts, in the order index.html loads them:
    common.js         tiny helpers ($, esc, remembered choices)
    updates.js        asks GitHub whether a newer version exists
    maps.js           map providers and layers
    app.js            (this file) state, formatting, the map, icons
    layers.js         the layers button (Road / Satellite / Dark / Terrain)
    places.js         shops, schools, parks... on the map (OpenStreetMap)
    overview.js       the sidebar lists and the overview of all flights
    flight.js         one open flight: path, details panel, replay
    update-notice.js  the version number, update notice and Updates window
    main.js           loading data from the server, and start-up
    planner.js        the flight planner

  The server (server.py) provides the data:
    GET api/flights        -> every flight, summaries only
    GET api/flights/<id>   -> one flight, with its full GPS track
  and it is drawn with Leaflet (https://leafletjs.com), an open-source map library.
*/

const REFRESH_MS = 60 * 1000;   // look for new flights every minute

const state = {
  flights: [],
  version: null,
  detail: null,          // the flight that is open in the bottom panel
  idx: 0,                // which track point the drone marker is on
  playing: false,
  playT: 0,
  lastFrame: 0,
  units: loadSetting('units', null),   // this browser's choice; null = use the settings page default
  layer: loadSetting('mapLayer', null),      // this browser's layer choice; null = settings default
  details: loadSetting('mapDetails', null),  // '1' / '0' / null = settings default
  // Settings page values (the server sends the real ones with every refresh).
  settings: {
    mapProvider: 'free', mapLayer: 'dark', satelliteLabels: true, units: 'imperial', pathColor: '#36c2ff',
    playbackSpeed: 5, openAt: 'last', navApp: 'google', showAllPaths: true,
    minFlightSeconds: 0, hideNoGps: false, aircraftNames: {}, focusSelected: true,
  },
  settingsKey: '',
  layerKey: '',
  follow: loadSetting('follow', '0') === '1',   // "Follow" button on/off
  tab: 'aircraft',
  filter: '',
  firstLoad: true,
  lastData: { dataDir: '' },
};

// ---------- settings helpers ----------
const units = () => state.units || state.settings.units;
const pathColor = () => state.settings.pathColor || '#36c2ff';
// A nickname from the settings page, or the model name from the log.
const displayName = (serial, model) => (serial && state.settings.aircraftNames?.[serial]) || model;
// Hide flights the settings page says to hide.
function isVisible(f) {
  const s = state.settings;
  if (s.hideNoGps && !f.hasGps) return false;
  if (s.minFlightSeconds && (f.duration || 0) < s.minFlightSeconds) return false;
  return true;
}

// ---------- formatting numbers for people ----------
const M_TO_FT = 3.28084;
const MS_TO_MPH = 2.23694;
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = {
  height(m) {
    if (m == null) return '–';
    return units() === 'imperial' ? `${Math.round(m * M_TO_FT)} ft` : `${m.toFixed(Math.abs(m) < 10 ? 1 : 0)} m`;
  },
  dist(m) {
    if (m == null) return '–';
    if (units() === 'imperial') {
      const ft = m * M_TO_FT;
      return ft < 5280 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(2)} mi`;
    }
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  },
  speed(ms) {
    if (ms == null) return '–';
    return units() === 'imperial' ? `${(ms * MS_TO_MPH).toFixed(1)} mph` : `${(ms * 3.6).toFixed(1)} km/h`;
  },
  dur(s) {
    if (s == null) return '–';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
  },
  date(iso) {
    if (!iso) return 'Unknown date';
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  },
  day(iso) {
    if (!iso) return 'Unknown date';
    return new Date(iso).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  },
  clock(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–';
  },
  ago(iso) {
    if (!iso) return 'unknown';
    const diff = (new Date(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
    const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, secs] of steps) if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
    return 'just now';
  },
  coord(lat, lon) { return `${lat.toFixed(6)}, ${lon.toFixed(6)}`; },
  pct(v) { return v == null ? '–' : `${Math.round(v)}%`; },
};

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "Navigate" link, in the app chosen on the settings page.
function navUrl(lat, lon) {
  switch (state.settings.navApp) {
    case 'apple': return `https://maps.apple.com/?daddr=${lat},${lon}`;
    case 'waze': return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
    default: return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  }
}

// ---------- the map ----------
const map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView([39, -98], 4);
L.control.zoom({ position: 'topright' }).addTo(map);

const overviewLines = L.layerGroup().addTo(map);   // faint line for every flight
const overviewDrones = L.layerGroup().addTo(map);  // last-known position of each aircraft
const selectedLayer = L.layerGroup().addTo(map);   // the flight that is open

// Top-down drone drawing. It points "up" (north); we rotate it by the heading.
const DRONE_SVG = `
<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
  <g stroke="#0b1a22" stroke-width="1.5">
    <path d="M12 12 L36 36 M36 12 L12 36" stroke="#d9e6ee" stroke-width="4" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="7" fill="rgba(54,194,255,0.35)" stroke="#36c2ff"/>
    <circle cx="36" cy="12" r="7" fill="rgba(54,194,255,0.35)" stroke="#36c2ff"/>
    <circle cx="12" cy="36" r="7" fill="rgba(54,194,255,0.35)" stroke="#36c2ff"/>
    <circle cx="36" cy="36" r="7" fill="rgba(54,194,255,0.35)" stroke="#36c2ff"/>
    <rect x="17" y="16" width="14" height="17" rx="5" fill="#f2f6f9"/>
    <path d="M24 9 L28.5 16 L19.5 16 Z" fill="#36c2ff"/>
  </g>
</svg>`;

function droneIcon(kind) {
  return L.divIcon({
    className: `drone-icon ${kind}`,
    html: `<div class="pulse"></div><div class="rot">${DRONE_SVG}</div>`,
    iconSize: [48, 48], iconAnchor: [24, 24],
  });
}
const homeIcon = L.divIcon({ className: 'home-icon', html: 'H', iconSize: [24, 24], iconAnchor: [12, 12] });

// Turn the drone icon to face its heading. It always turns the short way
// (179° to -179° is a 2° turn, not a 358° spin).
function rotateMarker(marker, yaw) {
  const el = marker.getElement()?.querySelector('.rot');
  if (!el) return;
  const prev = marker._angle ?? (yaw || 0);
  const turn = ((((yaw || 0) - prev) % 360) + 540) % 360 - 180;
  marker._angle = prev + turn;
  el.style.transform = `rotate(${marker._angle}deg)`;
}

// Leave room for the panels when zooming to something.
function fitOptions() {
  const narrow = window.innerWidth <= 760;
  const panel = $('#panel').getBoundingClientRect();
  // The bottom panel: flight details or the planner, whichever is open.
  const detail = [$('#detail'), $('#planner')].find((el) => el && !el.classList.contains('hidden')) || $('#detail');
  const detailH = detail.classList.contains('hidden') ? 0 : detail.getBoundingClientRect().height;
  if (narrow) {
    const bottom = Math.max(detailH, detail.classList.contains('hidden') ? panel.height : 0);
    return { paddingTopLeft: [24, 70], paddingBottomRight: [24, bottom + 24], maxZoom: 19 };
  }
  return { paddingTopLeft: [panel.right + 24, 70], paddingBottomRight: [40, detailH + 40], maxZoom: 19 };
}
