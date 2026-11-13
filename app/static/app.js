'use strict';
/*
  Flight Map - the part that runs in the browser.

  It asks the server (server.py) for data:
    GET api/flights        -> every flight, summaries only
    GET api/flights/<id>   -> one flight, with its full GPS track
  and draws it with Leaflet (https://leafletjs.com), an open-source map library.
*/

// ---------- tiny helpers ----------
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// localStorage can be blocked (private windows etc.), so never let it crash the page.
function loadSetting(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function saveSetting(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

const REFRESH_MS = 60 * 1000;   // look for new flights every minute

const state = {
  flights: [],
  version: null,
  detail: null,          // the flight that is open in the bottom panel
  idx: 0,                // which track point the drone marker is on
  playing: false,
  playT: 0,
  lastFrame: 0,
  units: loadSetting('units', 'imperial'),
  layer: loadSetting('layer', 'dark'),
  tab: 'aircraft',
  filter: '',
  firstLoad: true,
  lastData: { dataDir: '' },
};

// ---------- formatting numbers for people ----------
const M_TO_FT = 3.28084;
const MS_TO_MPH = 2.23694;
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = {
  height(m) {
    if (m == null) return '–';
    return state.units === 'imperial' ? `${Math.round(m * M_TO_FT)} ft` : `${m.toFixed(Math.abs(m) < 10 ? 1 : 0)} m`;
  },
  dist(m) {
    if (m == null) return '–';
    if (state.units === 'imperial') {
      const ft = m * M_TO_FT;
      return ft < 5280 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(2)} mi`;
    }
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  },
  speed(ms) {
    if (ms == null) return '–';
    return state.units === 'imperial' ? `${(ms * MS_TO_MPH).toFixed(1)} mph` : `${(ms * 3.6).toFixed(1)} km/h`;
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

const navUrl = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;

// ---------- the map ----------
const map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView([39, -98], 4);
L.control.zoom({ position: 'topright' }).addTo(map);

const baseLayers = {
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 22, maxNativeZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 22, maxNativeZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  }),
};

function setLayer(name) {
  state.layer = baseLayers[name] ? name : 'dark';
  for (const [key, layer] of Object.entries(baseLayers)) {
    if (key === state.layer) layer.addTo(map); else map.removeLayer(layer);
  }
  $('#btn-layer').textContent = state.layer === 'dark' ? 'Satellite' : 'Dark map';
  saveSetting('layer', state.layer);
}

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

function rotateMarker(marker, yaw) {
  const el = marker.getElement()?.querySelector('.rot');
  if (el) el.style.transform = `rotate(${yaw || 0}deg)`;
}

// Leave room for the panels when zooming to something.
function fitOptions() {
  const narrow = window.innerWidth <= 760;
  const panel = $('#panel').getBoundingClientRect();
  const detail = $('#detail');
  const detailH = detail.classList.contains('hidden') ? 0 : detail.getBoundingClientRect().height;
  if (narrow) {
    const bottom = Math.max(detailH, detail.classList.contains('hidden') ? panel.height : 0);
    return { paddingTopLeft: [24, 70], paddingBottomRight: [24, bottom + 24], maxZoom: 19 };
  }
  return { paddingTopLeft: [panel.right + 24, 70], paddingBottomRight: [40, detailH + 40], maxZoom: 19 };
}

// ---------- grouping flights by aircraft ----------
function aircraftList() {
  const groups = new Map();
  for (const f of state.flights) {   // server sends newest flight first
    const key = f.serial || f.aircraftName;
    if (!groups.has(key)) groups.set(key, { key, name: f.aircraftName, serial: f.serial, flights: [], totalTime: 0 });
    const g = groups.get(key);
    g.flights.push(f);
    g.totalTime += f.duration || 0;
  }
  for (const g of groups.values()) {
    g.lastFlight = g.flights.find((f) => f.hasGps) || null;
    g.last = g.lastFlight?.last || null;
    g.lastSeen = g.lastFlight ? (g.lastFlight.end || g.lastFlight.start) : null;
  }
  return [...groups.values()];
}

// ---------- drawing the left panel ----------
function renderStatus(data) {
  const el = $('#status');
  if (data.problem) { el.textContent = data.problem; el.title = data.problem; return; }
  if (data.scanning) { el.textContent = 'Reading flight logs…'; return; }
  const parts = [`${state.flights.length} flight${state.flights.length === 1 ? '' : 's'}`];
  if (data.errors?.length) parts.push(`${data.errors.length} unreadable`);
  parts.push(`checked ${fmt.clock(data.lastScan)}`);
  el.textContent = parts.join(' · ');
  el.title = data.errors?.length ? data.errors.map((e) => `${e.file}: ${e.error}`).join('\n') : `Folder: ${data.dataDir}`;
}

function emptyMessage(data) {
  return `<div class="empty">No flight logs found yet.<br>The server is looking in:<code>${esc(data.dataDir)}</code>
    Make sure your sync service saves its <b>.csv</b> (or <b>.geojson</b>) files there.</div>`;
}

function renderAircraft(data) {
  const box = $('#tab-aircraft');
  const list = aircraftList();
  if (!list.length) { box.innerHTML = emptyMessage(data); return; }
  box.innerHTML = list.map((a) => {
    const f = a.lastFlight;
    const sn = a.serial ? `SN ···${esc(a.serial.slice(-6))}` : 'No serial number';
    const seen = a.lastSeen
      ? `Last seen <b>${esc(fmt.ago(a.lastSeen))}</b> · ${esc(fmt.date(a.lastSeen))}`
      : 'No GPS position recorded yet';
    return `
      <article class="aircraft" data-key="${esc(a.key)}">
        <div class="top">
          <div class="avatar"><svg viewBox="0 0 48 48" width="28" height="28"><g fill="currentColor"><circle cx="12" cy="12" r="6"/><circle cx="36" cy="12" r="6"/><circle cx="12" cy="36" r="6"/><circle cx="36" cy="36" r="6"/><rect x="18" y="18" width="12" height="12" rx="3"/></g></svg></div>
          <div><h3>${esc(a.name)}</h3><div class="sn">${sn}</div></div>
        </div>
        <div class="seen">${seen}</div>
        <div class="grid">
          <div><span>Battery left</span>${esc(fmt.pct(f?.batteryEnd))}</div>
          <div><span>Flights</span>${a.flights.length}</div>
          <div><span>Air time</span>${esc(fmt.dur(a.totalTime))}</div>
        </div>
        ${a.last ? `<div class="coord">${esc(fmt.coord(a.last.lat, a.last.lon))}</div>
        <div class="actions">
          <button class="chip" data-act="show">Show last flight</button>
          <a class="chip accent" href="${navUrl(a.last.lat, a.last.lon)}" target="_blank" rel="noopener">Navigate</a>
        </div>` : ''}
      </article>`;
  }).join('');

  box.querySelectorAll('.aircraft').forEach((card) => {
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;  // let the Navigate link open normally
      const a = list.find((x) => x.key === card.dataset.key);
      if (a?.lastFlight) selectFlight(a.lastFlight.id);
      else if (a?.flights[0]) selectFlight(a.flights[0].id);
    });
  });
}

function renderFlights(data) {
  $('#flight-count').textContent = state.flights.length || '';
  const box = $('#flight-list');
  if (!state.flights.length) { box.innerHTML = emptyMessage(data); return; }
  const q = state.filter.trim().toLowerCase();
  const shown = state.flights.filter((f) => !q ||
    `${fmt.day(f.start)} ${fmt.date(f.start)} ${f.aircraftName} ${f.file}`.toLowerCase().includes(q));
  if (!shown.length) { box.innerHTML = '<div class="empty">No flights match that filter.</div>'; return; }

  let html = '', lastDay = null;
  for (const f of shown) {
    const day = fmt.day(f.start);
    if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    const active = state.detail?.summary.id === f.id ? ' active' : '';
    html += `
      <button class="flight${active}" data-id="${esc(f.id)}">
        <div class="row1"><span class="time">${esc(fmt.clock(f.start))}</span><span class="name">${esc(f.aircraftName)}</span></div>
        <div class="row2">
          <span>⏱ ${esc(fmt.dur(f.duration))}</span>
          <span>↔ ${esc(fmt.dist(f.distance))}</span>
          <span>↑ ${esc(fmt.height(f.maxHeight))}</span>
          ${f.warnings ? `<span class="badge">⚠ ${f.warnings}</span>` : ''}
          ${f.hasGps ? '' : '<span class="badge nogps">no GPS</span>'}
        </div>
      </button>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.flight').forEach((el) => el.addEventListener('click', () => selectFlight(el.dataset.id)));
}

function drawOverview() {
  overviewLines.clearLayers();
  overviewDrones.clearLayers();
  for (const f of state.flights) {
    if (!f.hasGps || f.preview.length < 1) continue;
    const line = f.preview.length > 1
      ? L.polyline(f.preview, { color: '#36c2ff', weight: 3, opacity: 0.35 })
      : L.circleMarker(f.preview[0], { radius: 4, color: '#36c2ff', opacity: 0.5 });
    line.bindTooltip(`${esc(f.aircraftName)} · ${esc(fmt.date(f.start))}`, { sticky: true });
    line.on('click', () => selectFlight(f.id));
    line.addTo(overviewLines);
  }
  for (const a of aircraftList()) {
    if (!a.last) continue;
    const marker = L.marker([a.last.lat, a.last.lon], { icon: droneIcon('idle'), zIndexOffset: 500 })
      .bindTooltip(`${esc(a.name)} · last seen ${esc(fmt.ago(a.lastSeen))}`, { direction: 'top', offset: [0, -18] })
      .on('click', () => selectFlight(a.lastFlight.id))
      .addTo(overviewDrones);
    rotateMarker(marker, a.last.yaw);
  }
}

function fitAll() {
  const pts = [];
  for (const f of state.flights) if (f.hasGps) pts.push(...f.preview);
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), fitOptions());
}

// ---------- loading data ----------
async function refresh({ force = false } = {}) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    const res = await fetch('api/flights', { cache: 'no-store' });
    if (res.status === 401) { location.href = 'login.html'; return; }   // signed out
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    const data = await res.json();
    const changed = force || data.version !== state.version;
    state.version = data.version;
    state.lastData = data;
    state.flights = data.flights;
    renderStatus(data);
    $('#btn-logout').classList.toggle('hidden', !data.auth);
    if (changed) {
      renderAircraft(data);
      renderFlights(data);
      drawOverview();
      if (state.detail) map.removeLayer(overviewDrones);
    }
    if (state.firstLoad && !data.scanning) {
      state.firstLoad = false;
      const wanted = new URLSearchParams(location.hash.slice(1)).get('flight');
      if (wanted && state.flights.some((f) => f.id === wanted)) selectFlight(wanted);
      else fitAll();
    }
    if (data.scanning) setTimeout(refresh, 2000);  // first scan still running
  } catch (err) {
    $('#status').textContent = `Can't reach the server (${err.message})`;
  } finally {
    btn.classList.remove('spin');
  }
}

// ---------- one flight ----------
async function selectFlight(id, { fit = true } = {}) {
  stopPlayback();
  let data;
  try {
    const res = await fetch(`api/flights/${encodeURIComponent(id)}`);
    if (res.status === 401) { location.href = 'login.html'; return; }
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    data = await res.json();
  } catch (err) {
    $('#status').textContent = `Could not open flight (${err.message})`;
    return;
  }
  state.detail = data;
  history.replaceState(null, '', `#flight=${id}`);
  map.removeLayer(overviewDrones);

  drawSelected();
  renderDetail();
  renderFlights(state.lastData);
  // Start with the drone at its LAST position - that is where you'd go to find it.
  setIndex(data.track.length - 1);

  if (fit && data.track.length) {
    map.fitBounds(L.latLngBounds(data.track.map((p) => [p.lat, p.lon])).pad(0.3), fitOptions());
  }
}

function closeFlight() {
  stopPlayback();
  state.detail = null;
  selectedLayer.clearLayers();
  overviewDrones.addTo(map);
  $('#detail').classList.add('hidden');
  history.replaceState(null, '', location.pathname + location.search);
  renderFlights(state.lastData);
}

function drawSelected() {
  selectedLayer.clearLayers();
  state.droneMarker = null;
  const { track, events } = state.detail;
  if (!track.length) return;
  const latlngs = track.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color: '#000', weight: 8, opacity: 0.45 }).addTo(selectedLayer);
  L.polyline(latlngs, { color: '#36c2ff', weight: 4 }).addTo(selectedLayer);
  L.marker(latlngs[0], { icon: homeIcon }).bindTooltip('Take-off point').addTo(selectedLayer);
  for (const e of events) {
    if (e.kind !== 'warn' || e.lat == null) continue;
    L.circleMarker([e.lat, e.lon], { radius: 6, color: '#ffb020', weight: 2, fillOpacity: 0.85 })
      .bindTooltip(esc(e.text)).on('click', () => seekTime(e.t)).addTo(selectedLayer);
  }
  state.droneMarker = L.marker(latlngs.at(-1), { icon: droneIcon('active'), zIndexOffset: 1000 }).addTo(selectedLayer);
}

function renderDetail() {
  const { summary: s, track, events } = state.detail;
  $('#detail').classList.remove('hidden');
  $('#d-title').textContent = `${s.aircraftName} · ${fmt.date(s.start)}`;
  const extra = [];
  if (s.source === 'geojson') extra.push('GeoJSON – fewer details');
  const copies = state.flights.find((f) => f.id === s.id)?.copies || 1;
  if (copies > 1) extra.push(`saved ${copies} times, showing one`);
  $('#d-sub').textContent = s.file + (extra.length ? ` (${extra.join('; ')})` : '');

  const nav = $('#d-nav');
  if (s.last) { nav.href = navUrl(s.last.lat, s.last.lon); nav.classList.remove('hidden'); }
  else nav.classList.add('hidden');

  const used = s.batteryStart != null && s.batteryEnd != null ? `${fmt.pct(s.batteryStart)} → ${fmt.pct(s.batteryEnd)}` : '–';
  const stats = [
    ['Flight time', fmt.dur(s.duration)],
    ['Distance', fmt.dist(s.distance)],
    ['Max height', fmt.height(s.maxHeight)],
    ['Max speed', fmt.speed(s.maxSpeed)],
    ['Battery', used],
    ['Photos / video', `${s.photoNum} / ${fmt.dur(s.videoTime)}`],
  ];
  if (s.last) stats.push(['Last position', fmt.coord(s.last.lat, s.last.lon)]);
  $('#d-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  const hasTrack = track.length > 0;
  $('#d-track').classList.toggle('hidden', !hasTrack);
  $('#d-nogps').classList.toggle('hidden', hasTrack);
  $('#p-scrub').max = Math.max(0, track.length - 1);
  drawProfile();

  $('#d-event-count').textContent = events.length || '';
  $('#d-events').classList.toggle('hidden', !events.length);
  $('#d-events ul').innerHTML = events.map((e, i) =>
    `<li class="${e.kind}" data-i="${i}"><time>${esc(fmt.dur(e.t))}</time><span>${e.kind === 'warn' ? '⚠ ' : ''}${esc(e.text)}</span></li>`).join('');
  $('#d-events ul').querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => seekTime(events[li.dataset.i].t)));
}

// Height-over-time chart, drawn as SVG.
function drawProfile() {
  const svg = $('#d-profile');
  const track = state.detail.track;
  state.profile = null;
  if (track.length < 2) { svg.innerHTML = ''; return; }
  const W = 1000, H = 100;
  const t0 = track[0].t, span = Math.max(track.at(-1).t - t0, 0.1);
  let hMin = 0, hMax = 0;
  for (const p of track) { hMin = Math.min(hMin, p.h); hMax = Math.max(hMax, p.h); }
  const realMax = hMax;
  hMax = Math.max(hMax, hMin + 1);   // keep at least 1 m of scale so flat flights don't divide by 0
  const x = (t) => ((t - t0) / span) * W;
  const y = (h) => H - 6 - ((h - hMin) / (hMax - hMin)) * (H - 22);
  const pts = track.map((p) => `${x(p.t).toFixed(1)},${y(p.h).toFixed(1)}`).join(' ');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<polygon class="area" points="0,${H} ${pts} ${W},${H}"/>
    <polyline class="line" points="${pts}"/>
    <line id="d-cursor" class="cursor" x1="0" x2="0" y1="0" y2="${H}"/>`;
  state.profile = { x, t0, span };
  $('#d-profile-label').textContent = `Height · max ${fmt.height(realMax)}`;
}

// Move the drone marker to track point i and update the numbers.
function setIndex(i) {
  const track = state.detail?.track;
  if (!track?.length) return;
  i = Math.max(0, Math.min(track.length - 1, i));
  state.idx = i;
  const p = track[i];
  if (state.droneMarker) {
    state.droneMarker.setLatLng([p.lat, p.lon]);
    rotateMarker(state.droneMarker, p.yaw);
  }
  $('#p-scrub').value = i;
  if (state.profile) {
    const cx = state.profile.x(p.t).toFixed(1);
    const cursor = $('#d-cursor');
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx);
  }
  renderLive(p);
}

function renderLive(p) {
  const s = state.detail.summary;
  const clock = s.start ? new Date(new Date(s.start).getTime() + p.t * 1000).toLocaleTimeString() : '–';
  const fromHome = haversine(state.detail.track[0], p);
  const items = [
    ['Flight clock', `${fmt.dur(p.t)} (${clock})`],
    ['Height', fmt.height(p.h)],
    ['Speed', fmt.speed(p.spd)],
    ['Climb', p.vs == null ? '–' : fmt.speed(-p.vs)],   // DJI zSpeed is negative when climbing
    ['From take-off', fmt.dist(fromHome)],
    ['Battery', fmt.pct(p.bat)],
    ['Satellites', p.sats ?? '–'],
    ['Mode', p.mode || '–'],
  ];
  $('#d-live').innerHTML = items.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

function seekTime(t) {
  const track = state.detail?.track;
  if (!track?.length) return;
  let i = 0;
  while (i < track.length - 1 && track[i + 1].t <= t) i++;
  setIndex(i);
  if (state.droneMarker) map.panTo(state.droneMarker.getLatLng());
}

// ---------- playback ----------
function startPlayback() {
  const track = state.detail?.track;
  if (!track || track.length < 2) return;
  if (state.idx >= track.length - 1) setIndex(0);
  state.playing = true;
  state.playT = track[state.idx].t;
  state.lastFrame = performance.now();
  $('#p-play').textContent = '❚❚';
  $('#p-play').setAttribute('aria-label', 'Pause');
  requestAnimationFrame(tick);
}

function stopPlayback() {
  state.playing = false;
  $('#p-play').textContent = '▶';
  $('#p-play').setAttribute('aria-label', 'Play');
}

function tick(now) {
  if (!state.playing || !state.detail) return;
  const track = state.detail.track;
  const speed = Number($('#p-speed').value) || 1;
  state.playT += ((now - state.lastFrame) / 1000) * speed;
  state.lastFrame = now;
  let i = state.idx;
  while (i < track.length - 1 && track[i + 1].t <= state.playT) i++;
  if (i !== state.idx) {
    setIndex(i);
    // Keep the drone on screen while it plays.
    const ll = state.droneMarker?.getLatLng();
    if (ll && !map.getBounds().pad(-0.15).contains(ll)) map.panTo(ll, { animate: true });
  }
  if (i >= track.length - 1) { stopPlayback(); return; }
  requestAnimationFrame(tick);
}

// ---------- buttons ----------
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  state.tab = btn.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $('#tab-aircraft').classList.toggle('hidden', state.tab !== 'aircraft');
  $('#tab-flights').classList.toggle('hidden', state.tab !== 'flights');
}));

$('#search').addEventListener('input', (e) => { state.filter = e.target.value; renderFlights(state.lastData); });
$('#btn-refresh').addEventListener('click', () => refresh({ force: true }));
$('#btn-fit').addEventListener('click', () => { if (state.detail) closeFlight(); fitAll(); });
$('#btn-layer').addEventListener('click', () => setLayer(state.layer === 'dark' ? 'satellite' : 'dark'));
$('#btn-units').addEventListener('click', () => {
  state.units = state.units === 'imperial' ? 'metric' : 'imperial';
  saveSetting('units', state.units);
  updateUnitsButton();
  refresh({ force: true });
  if (state.detail) { renderDetail(); setIndex(state.idx); }
});
function updateUnitsButton() { $('#btn-units').textContent = state.units === 'imperial' ? 'ft · mph' : 'm · km/h'; }

$('#d-close').addEventListener('click', closeFlight);
$('#p-play').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));
$('#p-scrub').addEventListener('input', (e) => { stopPlayback(); setIndex(Number(e.target.value)); });
$('#d-profile').addEventListener('click', (e) => {
  if (!state.profile) return;
  const box = e.currentTarget.getBoundingClientRect();
  stopPlayback();
  seekTime(state.profile.t0 + ((e.clientX - box.left) / box.width) * state.profile.span);
});
document.addEventListener('keydown', (e) => {
  if (!state.detail || e.target.matches('input, select, textarea')) return;
  if (e.key === ' ') { e.preventDefault(); state.playing ? stopPlayback() : startPlayback(); }
  if (e.key === 'Escape') closeFlight();
  if (e.key === 'ArrowRight') { stopPlayback(); setIndex(state.idx + 10); }
  if (e.key === 'ArrowLeft') { stopPlayback(); setIndex(state.idx - 10); }
});

// ---------- start ----------
setLayer(state.layer);
updateUnitsButton();
refresh();
setInterval(refresh, REFRESH_MS);
