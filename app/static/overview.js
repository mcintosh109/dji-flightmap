'use strict';
/*
  The sidebar (aircraft cards, flight list, status line) and the overview
  map: a line for every flight and each aircraft's last-known position.
*/

// ---------- grouping flights by aircraft ----------
function aircraftList() {
  const groups = new Map();
  for (const f of state.flights) {   // server sends newest flight first
    const key = f.serial || f.aircraftName;
    if (!groups.has(key)) groups.set(key, { key, name: displayName(f.serial, f.aircraftName), serial: f.serial, flights: [], totalTime: 0 });
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
  if (state.hiddenCount) parts.push(`${state.hiddenCount} hidden`);
  if (data.errors?.length) parts.push(`${data.errors.length} unreadable`);
  parts.push(`checked ${fmt.clock(data.lastScan)}`);
  el.textContent = parts.join(' · ');
  el.title = data.errors?.length ? data.errors.map((e) => `${e.file}: ${e.error}`).join('\n') : `Folder: ${data.dataDir}`;
}

function emptyMessage(data) {
  return `<div class="empty">No flight logs found yet.<br>The server is looking in:<code>${esc(data.dataDir)}</code>
    Make sure your sync service saves its <b>.csv</b> (or <b>.geojson</b>) files there.</div>`;
}

// "🔧 1 maintenance job due" on a drone's card (5.6.0). Click: the Maintenance tab.
function maintDue(key) {
  const n = typeof Maintenance === 'undefined' ? 0 : Maintenance.dueFor(key);
  if (!n) return '';
  return `<button type="button" class="maint-due" data-act="maint">🔧 ${n} maintenance job${n === 1 ? '' : 's'} due</button>`;
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
        ${maintDue(a.key)}
        <div class="grid">
          <div><span>Battery left</span>${esc(fmt.pct(f?.batteryEnd))}</div>
          <div><span>Flights</span>${a.flights.length}</div>
          <div><span>Air time</span>${esc(fmt.dur(a.totalTime))}</div>
        </div>
        ${a.last ? `<div class="coord">${esc(fmt.coord(a.last.lat, a.last.lon))}</div>` : ''}
        <div class="actions">
          ${a.last ? '<button class="chip" data-act="show">Show last flight</button>' : ''}
          <button class="chip" data-act="stats" type="button">Stats</button>
          ${a.last ? `<a class="chip accent" href="${navUrl(a.last.lat, a.last.lon)}" target="_blank" rel="noopener">Navigate</a>` : ''}
        </div>
      </article>`;
  }).join('');

  box.querySelectorAll('.aircraft').forEach((card) => {
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;  // let the Navigate link open normally
      const a = list.find((x) => x.key === card.dataset.key);
      // "Stats": the Stats tab, showing only this drone (5.5.0).
      if (ev.target.closest('[data-act=stats]')) { if (a) Stats.showDrone(a.key); return; }
      if (ev.target.closest('[data-act=maint]')) { Maintenance.show(); return; }
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
    `${fmt.day(f.start)} ${fmt.date(f.start)} ${displayName(f.serial, f.aircraftName)} ${f.aircraftName} ${f.file}`.toLowerCase().includes(q));
  if (!shown.length) { box.innerHTML = '<div class="empty">No flights match that filter.</div>'; return; }

  let html = '', lastDay = null;
  for (const f of shown) {
    const day = fmt.day(f.start);
    if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    const active = state.detail?.summary.id === f.id ? ' active' : '';
    html += `
      <button class="flight${active}" data-id="${esc(f.id)}">
        <div class="row1"><span class="time">${esc(fmt.clock(f.start))}</span><span class="name">${esc(displayName(f.serial, f.aircraftName))}</span></div>
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
    if (!state.settings.showAllPaths) break;   // settings page: don't draw every flight
    if (!f.hasGps || f.preview.length < 1) continue;
    // A dark outline under each line keeps it visible on busy satellite pictures.
    if (f.preview.length > 1) {
      L.polyline(f.preview, { color: '#000', weight: 6, opacity: 0.45, interactive: false }).addTo(overviewLines);
    }
    const line = f.preview.length > 1
      ? L.polyline(f.preview, { color: pathColor(), weight: 3, opacity: 0.85 })
      : L.circleMarker(f.preview[0], { radius: 5, color: '#000', weight: 2, fillColor: pathColor(), fillOpacity: 0.9 });
    line.bindTooltip(`${esc(displayName(f.serial, f.aircraftName))} · ${esc(fmt.date(f.start))}`, { sticky: true });
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

// ---------- buttons ----------
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  state.tab = btn.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('#panel .tab-body').forEach((el) => el.classList.toggle('hidden', el.id !== `tab-${state.tab}`));
  if (typeof Planner !== 'undefined') Planner.showBlips({ fit: true });   // the plans' markers: only on the Plans tab
}));

$('#search').addEventListener('input', (e) => { state.filter = e.target.value; renderFlights(state.lastData); });
$('#btn-fit').addEventListener('click', () => { if (state.detail) closeFlight(); fitAll(); });
