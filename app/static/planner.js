'use strict';
/*
  Flight planner. Loaded after app.js and uses its helpers ($, esc, fmt,
  units, state, map, haversine, fitOptions, ...).

  A plan is: a take-off point ("home"), a list of waypoints (position,
  height above take-off, speed, pause), and some extras (name, notes, the
  planned date/time, battery at take-off, return to take-off at the end).
  Plans are saved on the server (GET/PUT/DELETE api/plans).

  Everything is stored in metres and metres per second; the page shows feet
  and mph (or metres and km/h) depending on the units setting.
*/
const Planner = (() => {
  // ---------- units for the input boxes ----------
  const imperial = () => units() === 'imperial';
  const H = {   // heights
    toUser: (m) => Math.round(imperial() ? m * 3.28084 : m),
    fromUser: (v) => (imperial() ? v / 3.28084 : v),
    unit: () => (imperial() ? 'ft' : 'm'),
  };
  const SPD = { // speeds
    toUser: (ms) => Math.round((imperial() ? ms * 2.23694 : ms * 3.6) * 10) / 10,
    fromUser: (v) => (imperial() ? v / 2.23694 : v / 3.6),
    unit: () => (imperial() ? 'mph' : 'km/h'),
  };
  const CLIMB = 3;      // m/s going up (conservative for a Mini 4 Pro)
  const DESCEND = 2.5;  // m/s coming down
  const OVERHEAD = 35;  // s for take-off, settling and landing

  let plan = null;          // the plan being edited
  let dirty = false;        // unsaved changes?
  let selected = -1;        // selected waypoint (index)
  let plans = [];           // saved plans (for the list)
  const layer = L.layerGroup();
  let weather = { key: '', data: null, error: '' };
  let weatherTimer = null;

  // New plans start with round numbers in your units: 200 ft at 18 mph, or 60 m at 30 km/h.
  const emptyPlan = () => ({
    id: null, name: '', notes: '', home: null, waypoints: [],
    defaults: imperial() ? { alt: H.fromUser(200), speed: SPD.fromUser(18) } : { alt: 60, speed: SPD.fromUser(30) },
    plannedFor: '', compareFlight: '', batteryStart: 100, returnHome: true,
  });

  // Centre a point in the part of the map you can see (not behind a panel).
  function showPoint(lat, lon, zoom) {
    map.setView([lat, lon], zoom, { animate: false });
    const o = fitOptions();
    const size = map.getSize();
    const target = L.point((o.paddingTopLeft[0] + size.x - o.paddingBottomRight[0]) / 2,
      (o.paddingTopLeft[1] + size.y - o.paddingBottomRight[1]) / 2);
    map.panBy(map.latLngToContainerPoint([lat, lon]).subtract(target), { animate: false });
  }

  // ---------- the numbers ----------
  // Battery use per minute, learned from your past flights (or a typical value).
  function batteryRate() {
    let used = 0, minutes = 0, n = 0;
    for (const f of state.lastData?.flights || []) {
      if (f.duration >= 60 && f.batteryStart != null && f.batteryEnd != null && f.batteryStart > f.batteryEnd) {
        used += f.batteryStart - f.batteryEnd;
        minutes += f.duration / 60;
        n++;
      }
    }
    return n ? { rate: used / minutes, from: n } : { rate: 3.0, from: 0 };   // ~33 min per battery
  }

  // Distance, time, battery and the farthest/highest point of a plan.
  function measure(p) {
    const out = { distance: 0, seconds: 0, maxAlt: 0, farthest: 0, farthestIdx: -1, legs: [] };
    if (!p.home) return out;
    const stops = [{ ...p.home, alt: 0 }, ...p.waypoints];
    if (p.returnHome && p.waypoints.length) stops.push({ ...p.home, alt: 0, speed: p.defaults.speed, hold: 0, isReturn: true });
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i];
      const flat = haversine(a, b);
      const speed = b.speed || p.defaults.speed;
      const up = Math.max(0, b.alt - a.alt) / CLIMB;
      const down = Math.max(0, a.alt - b.alt) / DESCEND;
      out.distance += flat;
      out.seconds += Math.max(flat / speed, up + down) + (b.hold || 0);
    }
    p.waypoints.forEach((w, i) => {
      out.maxAlt = Math.max(out.maxAlt, w.alt);
      const d = haversine(p.home, w);
      if (d > out.farthest) { out.farthest = d; out.farthestIdx = i; }
    });
    if (p.waypoints.length) out.seconds += OVERHEAD;
    const b = batteryRate();
    out.batteryUsed = (out.seconds / 60) * b.rate;
    out.batteryLeft = p.batteryStart - out.batteryUsed;
    out.batteryFrom = b.from;
    return out;
  }

  // Safety checks. Each warning: { level: 'warn' | 'danger', text }.
  function warnings(p, m) {
    const s = state.settings;
    const list = [];
    const maxH = s.plannerMaxHeight ?? 120, maxD = s.plannerMaxDistance ?? 500;
    const reserve = s.plannerReserve ?? 25, windLimit = s.plannerWindLimit ?? 10;
    p.waypoints.forEach((w, i) => {
      if (w.alt > maxH) list.push({ level: 'danger', text: `Waypoint ${i + 1} is at ${fmt.height(w.alt)}, above your ${fmt.height(maxH)} height limit.` });
    });
    if (m.farthest > maxD) {
      list.push({ level: 'warn', text: `Waypoint ${m.farthestIdx + 1} is ${fmt.dist(m.farthest)} from take-off (your limit: ${fmt.dist(maxD)}). Make sure you can still see the drone.` });
    }
    if (p.waypoints.length) {
      if (m.batteryLeft < 0) list.push({ level: 'danger', text: 'Not enough battery for this route.' });
      else if (m.batteryLeft < reserve) list.push({ level: 'danger', text: `Battery would be about ${Math.round(m.batteryLeft)}% when landing (your reserve: ${reserve}%).` });
      if (!p.returnHome) list.push({ level: 'warn', text: '"Return to take-off" is off, so the battery estimate doesn\'t include the flight back.' });
    }
    const w = weather.data?.at;
    if (w && p.waypoints.length) {
      const high = Math.max(w.wind120 ?? 0, w.wind80 ?? 0);
      if (high > windLimit) list.push({ level: 'danger', text: `Wind up high is about ${fmt.speed(high)}, more than your ${fmt.speed(windLimit)} limit.` });
      if (w.gusts > windLimit) list.push({ level: 'warn', text: `Gusts up to ${fmt.speed(w.gusts)} near the ground.` });
      if (w.rain >= 40) list.push({ level: 'warn', text: `${w.rain}% chance of rain. The Mini 4 Pro isn't waterproof.` });
      if (w.temp <= -10 || w.temp >= 40) list.push({ level: 'danger', text: `${temp(w.temp)} is outside the drone's working range (-10 to 40 °C / 14 to 104 °F).` });
      else if (w.temp < 5) list.push({ level: 'warn', text: `Cold (${temp(w.temp)}): batteries drain faster. Keep them warm until take-off.` });
      if (w.night) list.push({ level: 'warn', text: 'This is after sunset or before sunrise. Night flying needs anti-collision lighting and extra care.' });
    }
    return list;
  }

  const temp = (c) => (imperial() ? `${Math.round(c * 9 / 5 + 32)} °F` : `${Math.round(c)} °C`);

  // ---------- weather (Open-Meteo, free, no key) ----------
  const WEATHER_CODES = [[0, 'Clear'], [3, 'Partly cloudy'], [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'],
    [82, 'Rain showers'], [86, 'Snow showers'], [99, 'Thunderstorm']];
  const sky = (code) => (WEATHER_CODES.find(([max]) => code <= max) || [0, ''])[1];
  const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  function scheduleWeather() {
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(loadWeather, 600);
  }

  async function loadWeather() {
    if (!plan?.home || !plan.plannedFor) { weather = { key: '', data: null, error: '' }; renderWeather(); return; }
    const lat = plan.home.lat.toFixed(3), lon = plan.home.lon.toFixed(3);
    const key = `${lat},${lon},${plan.plannedFor.slice(0, 13)}`;
    if (key === weather.key && (weather.data || weather.error)) { renderWeather(); return; }
    weather = { key, data: null, error: '', loading: true };
    renderWeather();
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: lat, longitude: lon, wind_speed_unit: 'ms', timezone: 'auto', forecast_days: '16',
        hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_80m,wind_speed_120m',
        daily: 'sunrise,sunset',
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`weather service answered ${res.status}`);
      const d = await res.json();
      // Times come back in the place's local time, e.g. "2026-11-20T15:00".
      const hour = plan.plannedFor.slice(0, 13);
      const i = (d.hourly?.time || []).findIndex((t) => t.startsWith(hour));
      if (i < 0) throw new Error('only the next 16 days can be forecast. Pick a time in that range');
      const h = d.hourly;
      const day = (d.daily?.time || []).indexOf(plan.plannedFor.slice(0, 10));
      const sunrise = day >= 0 ? d.daily.sunrise[day] : null;
      const sunset = day >= 0 ? d.daily.sunset[day] : null;
      const when = plan.plannedFor;
      weather.data = {
        at: {
          temp: h.temperature_2m[i], rain: h.precipitation_probability[i] ?? 0, sky: sky(h.weather_code[i]),
          wind10: h.wind_speed_10m[i], dir: h.wind_direction_10m[i], gusts: h.wind_gusts_10m[i],
          wind80: h.wind_speed_80m?.[i], wind120: h.wind_speed_120m?.[i],
          night: !!(sunrise && sunset && (when < sunrise || when > sunset)),
        },
        sunrise, sunset,
      };
    } catch (err) {
      weather.error = err.message;
    }
    weather.loading = false;
    if (key === weather.key) { renderWeather(); renderStats(); }
  }

  function renderWeather() {
    const box = $('#pl-weather');
    if (!plan?.home) { box.innerHTML = '<p class="help">Set a take-off point to see the weather there.</p>'; return; }
    if (!plan.plannedFor) { box.innerHTML = '<p class="help">Pick a date and time above to see the forecast.</p>'; return; }
    if (weather.loading) { box.innerHTML = '<p class="help">Getting the forecast…</p>'; return; }
    if (weather.error) { box.innerHTML = `<p class="help warn">No forecast: ${esc(weather.error)}.</p>`; return; }
    const w = weather.data?.at;
    if (!w) { box.innerHTML = ''; return; }
    const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–');
    const items = [
      ['Sky', w.sky], ['Temperature', temp(w.temp)], ['Rain chance', `${w.rain}%`],
      ['Wind at ground', `${fmt.speed(w.wind10)} from ${compass(w.dir)}`], ['Gusts', fmt.speed(w.gusts)],
      [`Wind at ${fmt.height(80)}`, w.wind80 == null ? '–' : fmt.speed(w.wind80)],
      [`Wind at ${fmt.height(120)}`, w.wind120 == null ? '–' : fmt.speed(w.wind120)],
      ['Sunrise / sunset', `${clock(weather.data.sunrise)} / ${clock(weather.data.sunset)}`],
    ];
    box.innerHTML = `<div class="live">${items.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <p class="help">Forecast from <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a> for the take-off point.</p>`;
  }

  // ---------- drawing on the map ----------
  const wpIcon = (n, active) => L.divIcon({ className: `wp-icon${active ? ' active' : ''}`, html: String(n), iconSize: [26, 26], iconAnchor: [13, 13] });
  const homeIconPlan = L.divIcon({ className: 'home-icon plan-home', html: 'H', iconSize: [26, 26], iconAnchor: [13, 13] });

  function draw() {
    layer.clearLayers();
    if (!plan) return;
    // A past flight to compare with, in grey.
    const past = state.flights.find((f) => f.id === plan.compareFlight);
    if (past?.preview?.length > 1) {
      L.polyline(past.preview, { color: '#9aa0a6', weight: 3, opacity: 0.8, dashArray: '2 6', interactive: false }).addTo(layer);
    }
    if (!plan.home) return;
    const route = [plan.home, ...plan.waypoints].map((p) => [p.lat, p.lon]);
    if (route.length > 1) {
      L.polyline(route, { color: '#000', weight: 7, opacity: 0.45, interactive: false }).addTo(layer);
      L.polyline(route, { color: pathColor(), weight: 4, interactive: false }).addTo(layer);
    }
    if (plan.returnHome && plan.waypoints.length) {
      L.polyline([route.at(-1), route[0]], { color: pathColor(), weight: 3, opacity: 0.8, dashArray: '6 8', interactive: false }).addTo(layer);
    }
    const home = L.marker([plan.home.lat, plan.home.lon], { icon: homeIconPlan, draggable: true, zIndexOffset: 900 })
      .bindTooltip('Take-off (drag to move)').addTo(layer);
    home.on('drag', (e) => { plan.home = { lat: e.latlng.lat, lon: e.latlng.lng }; redrawLines(); });
    home.on('dragend', () => changed({ weather: true }));
    plan.waypoints.forEach((w, i) => {
      const m = L.marker([w.lat, w.lon], { icon: wpIcon(i + 1, i === selected), draggable: true, zIndexOffset: 1000 })
        .bindTooltip(`Waypoint ${i + 1}: ${fmt.height(w.alt)}, ${fmt.speed(w.speed)}`).addTo(layer);
      m.on('click', () => select(i));
      m.on('drag', (e) => { w.lat = e.latlng.lat; w.lon = e.latlng.lng; redrawLines(); });
      m.on('dragend', () => { select(i); changed(); });
    });
  }

  // Cheap redraw while dragging: only the lines.
  let dragFrame = 0;
  function redrawLines() {
    cancelAnimationFrame(dragFrame);
    dragFrame = requestAnimationFrame(() => {
      layer.eachLayer((l) => { if (l instanceof L.Polyline && l.options.interactive === false && l.options.color !== '#9aa0a6') layer.removeLayer(l); });
      const route = [plan.home, ...plan.waypoints].map((p) => [p.lat, p.lon]);
      if (route.length > 1) {
        L.polyline(route, { color: '#000', weight: 7, opacity: 0.45, interactive: false }).addTo(layer);
        L.polyline(route, { color: pathColor(), weight: 4, interactive: false }).addTo(layer);
      }
      if (plan.returnHome && plan.waypoints.length) {
        L.polyline([route.at(-1), route[0]], { color: pathColor(), weight: 3, opacity: 0.8, dashArray: '6 8', interactive: false }).addTo(layer);
      }
      renderStats();
    });
  }

  // ---------- the panel ----------
  function renderWaypoints() {
    const rows = plan.waypoints.map((w, i) => `
      <tr class="${i === selected ? 'selected' : ''}" data-i="${i}">
        <td><button type="button" class="wp-num" data-act="select" title="Show on map">${i + 1}</button></td>
        <td><input type="number" data-f="alt" min="0" step="${imperial() ? 10 : 5}" value="${H.toUser(w.alt)}" aria-label="Height of waypoint ${i + 1}"></td>
        <td><input type="number" data-f="speed" min="1" step="1" value="${SPD.toUser(w.speed)}" aria-label="Speed to waypoint ${i + 1}"></td>
        <td><input type="number" data-f="hold" min="0" max="300" step="5" value="${w.hold || 0}" aria-label="Pause at waypoint ${i + 1}"></td>
        <td><button type="button" class="icon-btn small" data-act="delete" aria-label="Delete waypoint ${i + 1}">✕</button></td>
      </tr>`).join('');
    $('#pl-wps').innerHTML = plan.waypoints.length
      ? `<table class="wp-table"><thead><tr><th>#</th><th>Height (${H.unit()})</th><th>Speed (${SPD.unit()})</th><th>Pause (s)</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="help">No waypoints yet.</p>';
  }

  function renderStats() {
    if (!plan) return;
    const m = measure(plan);
    const left = plan.waypoints.length ? `${Math.max(0, Math.round(m.batteryLeft))}%` : '–';
    const stats = [
      ['Distance', plan.waypoints.length ? fmt.dist(m.distance) : '–'],
      ['Flight time', plan.waypoints.length ? `~${fmt.dur(m.seconds)}` : '–'],
      ['Battery used', plan.waypoints.length ? `~${Math.round(m.batteryUsed)}%` : '–'],
      ['Battery at landing', left],
      ['Highest', plan.waypoints.length ? fmt.height(m.maxAlt) : '–'],
      ['Farthest from take-off', plan.waypoints.length ? fmt.dist(m.farthest) : '–'],
    ];
    $('#pl-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    $('#pl-battery-note').textContent = m.batteryFrom
      ? `Battery estimate based on your last ${m.batteryFrom} flight${m.batteryFrom === 1 ? '' : 's'} (about ${batteryRate().rate.toFixed(1)}% per minute). Wind changes it a lot.`
      : 'Battery estimate uses a typical Mini 4 Pro value (about 3% per minute) until you have more flights.';
    const list = warnings(plan, m);
    $('#pl-warnings').innerHTML = !plan.waypoints.length ? ''
      : list.length ? list.map((w) => `<li class="${w.level}">${w.level === 'danger' ? '⛔' : '⚠'} ${esc(w.text)}</li>`).join('')
        // Say exactly what was checked, so "OK" is never read as "safe to fly".
        : '<li class="ok">✓ Height, distance, battery and weather look OK. '
          + '<b>Airspace, obstacles and local rules are not checked.</b></li>';
    $('#pl-hint').textContent = !plan.home ? 'Click the map to set the take-off point (H).'
      : 'Click the map to add waypoints. Drag the numbers to move them.';
  }

  function renderPanel() {
    $('#pl-name').value = plan.name;
    $('#pl-when').value = plan.plannedFor;
    $('#pl-notes').value = plan.notes;
    $('#pl-return').checked = plan.returnHome;
    $('#pl-battery').value = plan.batteryStart;
    $('#pl-def-alt').value = H.toUser(plan.defaults.alt);
    $('#pl-def-speed').value = SPD.toUser(plan.defaults.speed);
    $('#pl-def-alt-unit').textContent = H.unit();
    $('#pl-def-speed-unit').textContent = SPD.unit();
    $('#pl-delete').classList.toggle('hidden', !plan.id);
    $('#pl-last-home').classList.toggle('hidden', !!plan.home || !lastTakeoff());
    const flights = state.flights.filter((f) => f.hasGps);
    $('#pl-compare').innerHTML = '<option value="">(none)</option>' + flights.map((f) =>
      `<option value="${esc(f.id)}"${f.id === plan.compareFlight ? ' selected' : ''}>${esc(fmt.date(f.start))} · ${esc(displayName(f.serial, f.aircraftName))}</option>`).join('');
    renderWaypoints();
    renderStats();
    renderWeather();
    setSaveMsg(dirty ? 'Unsaved changes' : (plan.id ? 'Saved' : 'Not saved yet'), dirty ? 'warn' : '');
  }

  function setSaveMsg(text, cls = '') {
    const el = $('#pl-save-msg');
    el.textContent = text;
    el.className = `pl-save-msg ${cls}`;
  }

  function changed({ weather: w = false, waypoints = true } = {}) {
    dirty = true;
    draw();
    if (waypoints) renderWaypoints();
    renderStats();
    if (w) scheduleWeather();
    setSaveMsg('Unsaved changes', 'warn');
    $('#pl-last-home').classList.toggle('hidden', !!plan.home || !lastTakeoff());
  }

  function select(i) {
    selected = i;
    draw();
    renderWaypoints();
    const row = $(`#pl-wps tr[data-i="${i}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function lastTakeoff() {
    const f = state.flights.find((x) => x.home);
    return f ? f.home : null;
  }

  // ---------- opening, saving, closing ----------
  function open(p = emptyPlan()) {
    if (state.detail) closeFlight();
    plan = JSON.parse(JSON.stringify(p));
    dirty = false;
    selected = -1;
    weather = { key: '', data: null, error: '' };
    state.planning = true;
    layer.addTo(map);
    map.getContainer().classList.add('planning');
    $('#planner').classList.remove('hidden');
    updateOverviewVisibility();
    renderPanel();
    draw();
    scheduleWeather();
    const pts = [plan.home, ...plan.waypoints].filter(Boolean).map((x) => [x.lat, x.lon]);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3), fitOptions());
    else if (pts.length === 1) showPoint(pts[0][0], pts[0][1], Math.max(map.getZoom(), 16));
  }

  function close({ ask = true } = {}) {
    if (!plan) return true;
    if (ask && dirty && !confirm('Close this plan without saving the changes?')) return false;
    plan = null;
    dirty = false;
    state.planning = false;
    layer.clearLayers();
    map.removeLayer(layer);
    map.getContainer().classList.remove('planning');
    $('#planner').classList.add('hidden');
    updateOverviewVisibility();
    return true;
  }

  async function save() {
    setSaveMsg('Saving…');
    try {
      const res = await fetch(`api/plans/${plan.id || 'new'}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'flightmap' },
        body: JSON.stringify(plan),
      });
      if (res.status === 401) { location.href = 'login.html'; return; }
      const data = await res.json();
      if (!res.ok) { setSaveMsg(data.error || `Could not save (${res.status})`, 'error'); return; }
      plan.id = data.id;
      plan.name = data.name;
      dirty = false;
      setSaveMsg('Saved ✓', 'ok');
      $('#pl-name').value = plan.name;
      $('#pl-delete').classList.remove('hidden');
      await loadList();
    } catch (err) {
      setSaveMsg(`Could not reach the server (${err.message})`, 'error');
    }
  }

  async function remove() {
    if (!plan?.id || !confirm(`Delete the plan "${plan.name}"? This can't be undone.`)) return;
    const res = await fetch(`api/plans/${plan.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'flightmap' } });
    if (res.ok || res.status === 404) {
      close({ ask: false });
      await loadList();
    }
  }

  // ---------- the list in the sidebar ----------
  async function loadList() {
    try {
      const res = await fetch('api/plans', { cache: 'no-store' });
      if (!res.ok) return;
      plans = (await res.json()).plans;
    } catch { return; }
    renderList();
  }

  function renderList() {
    $('#plan-count').textContent = plans.length || '';
    const box = $('#plan-list');
    if (!plans.length) {
      box.innerHTML = '<div class="empty">No saved plans yet.<br>Press <b>New plan</b>, then click the map.</div>';
      return;
    }
    box.innerHTML = plans.map((p) => {
      const m = measure(p);
      const when = p.plannedFor ? fmt.date(p.plannedFor) : 'No date set';
      return `<button class="flight plan-card" data-id="${esc(p.id)}">
        <div class="row1"><span class="time">${esc(p.name)}</span><span class="name">${esc(when)}</span></div>
        <div class="row2"><span>📍 ${p.waypoints.length} waypoint${p.waypoints.length === 1 ? '' : 's'}</span>
          <span>↔ ${esc(fmt.dist(m.distance))}</span><span>⏱ ~${esc(fmt.dur(m.seconds))}</span></div>
      </button>`;
    }).join('');
    box.querySelectorAll('.plan-card').forEach((el) => el.addEventListener('click', () => {
      if (plan && !close()) return;
      open(plans.find((p) => p.id === el.dataset.id));
    }));
  }

  // ---------- events ----------
  function wire() {
    $('#btn-new-plan').addEventListener('click', () => { if (!plan || close()) open(); });
    $('#pl-close').addEventListener('click', () => close());
    $('#pl-save').addEventListener('click', save);
    $('#pl-delete').addEventListener('click', remove);
    $('#pl-last-home').addEventListener('click', () => {
      const h = lastTakeoff();
      if (!h) return;
      plan.home = { lat: h.lat, lon: h.lon };
      showPoint(h.lat, h.lon, Math.max(map.getZoom(), 17));
      changed({ weather: true });
    });

    // Clicking the map: first the take-off point, then waypoints.
    map.on('click', (e) => {
      if (!plan) return;
      const pos = { lat: e.latlng.lat, lon: e.latlng.lng };
      if (!plan.home) {
        plan.home = pos;
        changed({ weather: true });
        return;
      }
      plan.waypoints.push({ ...pos, alt: plan.defaults.alt, speed: plan.defaults.speed, hold: 0 });
      selected = plan.waypoints.length - 1;
      changed();
    });

    $('#pl-name').addEventListener('input', (e) => { plan.name = e.target.value; dirty = true; setSaveMsg('Unsaved changes', 'warn'); });
    $('#pl-notes').addEventListener('input', (e) => { plan.notes = e.target.value; dirty = true; setSaveMsg('Unsaved changes', 'warn'); });
    $('#pl-when').addEventListener('change', (e) => { plan.plannedFor = e.target.value; changed({ weather: true, waypoints: false }); });
    $('#pl-return').addEventListener('change', (e) => { plan.returnHome = e.target.checked; changed({ waypoints: false }); });
    $('#pl-battery').addEventListener('change', (e) => {
      plan.batteryStart = Math.max(10, Math.min(100, Math.round(Number(e.target.value) || 100)));
      e.target.value = plan.batteryStart;
      changed({ waypoints: false });
    });
    $('#pl-def-alt').addEventListener('change', (e) => { plan.defaults.alt = Math.max(0, Math.min(500, H.fromUser(Number(e.target.value) || 0))); changed({ waypoints: false }); });
    $('#pl-def-speed').addEventListener('change', (e) => { plan.defaults.speed = Math.max(0.5, Math.min(15, SPD.fromUser(Number(e.target.value) || 1))); changed({ waypoints: false }); });
    $('#pl-apply-all').addEventListener('click', () => {
      plan.waypoints.forEach((w) => { w.alt = plan.defaults.alt; w.speed = plan.defaults.speed; });
      changed();
    });
    $('#pl-compare').addEventListener('change', (e) => { plan.compareFlight = e.target.value; changed({ waypoints: false }); });

    // The waypoint table: edit height/speed/pause, select, delete.
    $('#pl-wps').addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      if (!row || !e.target.dataset.f) return;
      const w = plan.waypoints[Number(row.dataset.i)];
      const v = Number(e.target.value) || 0;
      if (e.target.dataset.f === 'alt') w.alt = Math.max(0, Math.min(500, H.fromUser(v)));
      if (e.target.dataset.f === 'speed') w.speed = Math.max(0.5, Math.min(15, SPD.fromUser(v)));
      if (e.target.dataset.f === 'hold') w.hold = Math.max(0, Math.min(300, Math.round(v)));
      changed();
    });
    $('#pl-wps').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      const row = e.target.closest('tr');
      if (!btn || !row) return;
      const i = Number(row.dataset.i);
      if (btn.dataset.act === 'delete') {
        plan.waypoints.splice(i, 1);
        selected = -1;
        changed();
      } else if (btn.dataset.act === 'select') {
        select(i);
        const w = plan.waypoints[i];
        map.panTo([w.lat, w.lon]);
      }
    });

    // Delete key removes the selected waypoint (when not typing in a box).
    document.addEventListener('keydown', (e) => {
      if (!plan || e.target.matches('input, select, textarea')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) {
        e.preventDefault();
        plan.waypoints.splice(selected, 1);
        selected = -1;
        changed();
      }
    });
    window.addEventListener('beforeunload', (e) => { if (plan && dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  wire();
  loadList();
  return {
    open, close, loadList, renderList,
    isOpen: () => !!plan,
    // When units or settings change, show everything again in the new units.
    refresh: () => { renderList(); if (plan) { renderPanel(); draw(); } },
    _measure: measure, _plan: () => plan,   // used by the tests
  };
})();
