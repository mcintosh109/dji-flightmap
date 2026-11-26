'use strict';
/*
  One open flight: its path on the map, the details panel, the charts
  (height, speed, climb, battery, satellites), and the replay (play/pause, the drone gliding along, Follow).
*/

// ---------- one flight ----------
async function selectFlight(id, { fit = true } = {}) {
  if (state.planning && !Planner.close()) return;   // asks first if the plan isn't saved
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
  updateOverviewVisibility();

  drawSelected();
  renderDetail();
  renderFlights(state.lastData);
  // Start with the drone at its LAST position - that is where you'd go to find it.
  setIndex(state.settings.openAt === 'start' ? 0 : data.track.length - 1);

  if (fit && data.track.length) {
    map.fitBounds(L.latLngBounds(data.track.map((p) => [p.lat, p.lon])).pad(0.3), fitOptions());
  }
}

// While a flight is open, hide the other aircraft markers and (if the
// settings page says so) the other flights' paths, so only it is on the map.
function updateOverviewVisibility() {
  const open = !!state.detail || !!state.planning;
  if (open) map.removeLayer(overviewDrones); else overviewDrones.addTo(map);
  if (open && state.settings.focusSelected) map.removeLayer(overviewLines); else overviewLines.addTo(map);
}

function closeFlight() {
  stopPlayback();
  state.detail = null;
  selectedLayer.clearLayers();
  updateOverviewVisibility();
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
  state.latlngs = latlngs;
  L.polyline(latlngs, { color: '#000', weight: 8, opacity: 0.45 }).addTo(selectedLayer);
  // The whole path, faint: the part still to come.
  L.polyline(latlngs, { color: pathColor(), weight: 4, opacity: 0.45 }).addTo(selectedLayer);
  // The part already flown, bright. It grows as the drone moves.
  state.trail = L.polyline(latlngs, { color: pathColor(), weight: 4 }).addTo(selectedLayer);
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
  $('#d-title').textContent = `${displayName(s.serial, s.aircraftName)} · ${fmt.date(s.start)}`;
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
  // Which battery: told apart by its size (Standard 2590 mAh, Plus 3850 mAh, a bit less as they age).
  if (s.batteryCapacity) {
    const kind = { standard: 'Standard', plus: 'Plus' }[s.batteryKind];
    stats.push(['Battery pack', kind ? `${kind} · ${s.batteryCapacity} mAh` : `${s.batteryCapacity} mAh`]);
  }
  if (s.last) stats.push(['Last position', fmt.coord(s.last.lat, s.last.lon)]);
  $('#d-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  const hasTrack = track.length > 0;
  $('#d-track').classList.toggle('hidden', !hasTrack);
  $('#d-nogps').classList.toggle('hidden', hasTrack);
  $('#p-scrub').max = Math.max(0, track.length - 1);
  renderChartButtons();
  drawProfile();

  $('#d-event-count').textContent = events.length || '';
  $('#d-events').classList.toggle('hidden', !events.length);
  $('#d-events ul').innerHTML = events.map((e, i) =>
    `<li class="${e.kind}" data-i="${i}"><time>${esc(fmt.dur(e.t))}</time><span>${e.kind === 'warn' ? '⚠ ' : ''}${esc(e.text)}</span></li>`).join('');
  $('#d-events ul').querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => seekTime(events[li.dataset.i].t)));
}

// ---------- the charts under the flight's numbers ----------
// One chart at a time, picked with the buttons above it (Height, Speed,
// Climb, Battery, Satellites). Every chart uses the same time line, so the
// replay cursor and "click to jump there" work the same on each.
// value(p) = the number for one track point (null = not in this log).
// lo/hi = fixed ends of the scale (otherwise from the numbers themselves).
// minSpan = smallest scale, so a nearly flat line doesn't fill the chart.
const CHARTS = {
  height: { name: 'Height', value: (p) => p.h, minSpan: 1,
    label: (v) => `max ${fmt.height(v.max)}` },
  speed: { name: 'Speed', value: (p) => p.spd, minSpan: 1,
    label: (v) => `max ${fmt.speed(v.max)}` },
  // DJI's zSpeed is negative when climbing, so turn it round: up = positive.
  climb: { name: 'Climb', value: (p) => (p.vs == null ? null : -p.vs), minSpan: 1, zeroLine: true,
    label: (v) => `fastest up ${fmt.speed(Math.max(v.max, 0))} · down ${fmt.speed(Math.max(-v.min, 0))}` },
  battery: { name: 'Battery', value: (p) => p.bat, lo: 0, hi: 100,
    label: (v) => `${fmt.pct(v.first)} → ${fmt.pct(v.last)}` },
  sats: { name: 'Satellites', value: (p) => p.sats, minSpan: 5,
    label: (v) => `fewest ${v.min} · most ${v.max}` },
};

// Which charts this flight has numbers for (at least 2 points each).
function chartsWithData(track) {
  return Object.keys(CHARTS).filter((k) => track.filter((p) => CHARTS[k].value(p) != null).length >= 2);
}

function chosenChart(track) {
  const have = chartsWithData(track);
  const want = loadSetting('chart', 'height');
  return have.includes(want) ? want : (have[0] || 'height');
}

// The row of buttons: only charts this flight has numbers for.
function renderChartButtons() {
  const track = state.detail.track;
  const have = chartsWithData(track);
  const current = chosenChart(track);
  const box = $('#d-charts');
  box.classList.toggle('hidden', have.length < 2);
  box.innerHTML = have.map((k) =>
    `<button type="button" class="chart-btn" data-chart="${k}" aria-pressed="${k === current}">${esc(CHARTS[k].name)}</button>`).join('');
}

function drawProfile() {
  const svg = $('#d-profile');
  const track = state.detail.track;
  state.profile = null;
  const kind = chosenChart(track);
  const chart = CHARTS[kind];
  const pts = track.filter((p) => chart.value(p) != null);
  if (track.length < 2 || pts.length < 2) {
    svg.innerHTML = '';
    $('#d-profile-label').textContent = chart.name;
    return;
  }
  const W = 1000, H = 100;
  const t0 = track[0].t, span = Math.max(track.at(-1).t - t0, 0.1);
  const values = pts.map(chart.value);
  const v = { min: Math.min(...values), max: Math.max(...values), first: values[0], last: values.at(-1) };
  // The scale always includes 0, so heights below take-off and descents show.
  const lo = chart.lo ?? Math.min(0, v.min);
  const hi = chart.hi ?? Math.max(v.max, lo + chart.minSpan);   // never divide by 0
  const x = (t) => ((t - t0) / span) * W;
  const y = (n) => H - 6 - ((n - lo) / (hi - lo)) * (H - 32);   // the top is left free for the label
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(chart.value(p)).toFixed(1)}`).join(' ');
  const base = y(0).toFixed(1);   // the area is filled down (or up) to 0
  const first = x(pts[0].t).toFixed(1), last = x(pts.at(-1).t).toFixed(1);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<polygon class="area" points="${first},${base} ${line} ${last},${base}"/>
    ${chart.zeroLine ? `<line class="zero" x1="0" x2="${W}" y1="${base}" y2="${base}"/>` : ''}
    <polyline class="line" points="${line}"/>
    <line id="d-cursor" class="cursor" x1="0" x2="0" y1="0" y2="${H}"/>`;
  svg.dataset.chart = kind;
  state.profile = { x, t0, span };
  $('#d-profile-label').textContent = `${chart.name} · ${chart.label(v)}`;
}

function pickChart(kind) {
  saveSetting('chart', kind);
  renderChartButtons();
  drawProfile();
  if (state.detail?.track.length) placeDrone(state.idx, 0);   // put the cursor back
}

// Put the drone between track point i and i+1. frac 0 = exactly at
// point i, 0.5 = halfway to the next one. This is what makes it glide
// smoothly instead of hopping from point to point.
function placeDrone(i, frac = 0) {
  const track = state.detail.track;
  const a = track[i];
  const b = track[Math.min(i + 1, track.length - 1)];
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lon = a.lon + (b.lon - a.lon) * frac;
  const turn = ((((b.yaw || 0) - (a.yaw || 0)) % 360) + 540) % 360 - 180;
  if (state.droneMarker) {
    state.droneMarker.setLatLng([lat, lon]);
    rotateMarker(state.droneMarker, (a.yaw || 0) + turn * frac);
  }
  // Trail: everything flown so far, ending exactly at the drone.
  if (state.trail) state.trail.setLatLngs([...state.latlngs.slice(0, i + 1), [lat, lon]]);
  if (state.profile) {
    const cx = state.profile.x(a.t + (b.t - a.t) * frac).toFixed(1);
    const cursor = $('#d-cursor');
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx);
  }
}

// Move the drone marker to track point i and update the numbers.
function setIndex(i) {
  const track = state.detail?.track;
  if (!track?.length) return;
  i = Math.max(0, Math.min(track.length - 1, i));
  state.idx = i;
  placeDrone(i, 0);
  $('#p-scrub').value = i;
  renderLive(track[i]);
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

// "Follow": keep the drone in the middle of the part of the map you can
// see (not hidden behind the panels).
function centreOnDrone() {
  const ll = state.droneMarker?.getLatLng();
  if (!ll) return;
  const o = fitOptions();
  const size = map.getSize();
  const target = L.point(
    (o.paddingTopLeft[0] + size.x - o.paddingBottomRight[0]) / 2,
    (o.paddingTopLeft[1] + size.y - o.paddingBottomRight[1]) / 2);
  const offset = map.latLngToContainerPoint(ll).subtract(target);
  if (Math.abs(offset.x) > 0.5 || Math.abs(offset.y) > 0.5) map.panBy(offset, { animate: false });
}

function setFollow(on) {
  state.follow = on;
  saveSetting('follow', on ? '1' : '0');
  const btn = $('#p-follow');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Following the drone (drag the map to stop)' : 'Keep the map centred on the drone';
  if (on) centreOnDrone();
}

// Move the map so the drone can be seen: centre it when following,
// otherwise only pan if it is hidden behind a panel or off screen.
function showDrone() {
  if (state.follow) centreOnDrone(); else keepDroneVisible();
}

// Pan only if the drone is hidden behind a panel or off screen.
function keepDroneVisible() {
  const ll = state.droneMarker?.getLatLng();
  if (!ll) return;
  const o = fitOptions();
  map.panInside(ll, { paddingTopLeft: o.paddingTopLeft, paddingBottomRight: o.paddingBottomRight });
}

function seekTime(t) {
  const track = state.detail?.track;
  if (!track?.length) return;
  let i = 0;
  while (i < track.length - 1 && track[i + 1].t <= t) i++;
  setIndex(i);
  showDrone();
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
  if (i >= track.length - 1) { setIndex(track.length - 1); stopPlayback(); return; }
  if (i !== state.idx) {
    // New track point reached: update the slider and the numbers.
    state.idx = i;
    $('#p-scrub').value = i;
    renderLive(track[i]);
  }
  // Every frame: glide the drone between this point and the next.
  const gap = track[i + 1].t - track[i].t;
  const frac = gap > 0 ? Math.min(1, Math.max(0, (state.playT - track[i].t) / gap)) : 0;
  placeDrone(i, frac);
  if (state.follow) centreOnDrone();
  else if (frac < 0.05) keepDroneVisible();
  requestAnimationFrame(tick);
}

// ---------- buttons ----------
$('#d-close').addEventListener('click', closeFlight);
$('#p-play').addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));
$('#p-scrub').addEventListener('input', (e) => { stopPlayback(); setIndex(Number(e.target.value)); if (state.follow) centreOnDrone(); });
$('#p-follow').addEventListener('click', () => setFollow(!state.follow));
// Dragging the map yourself turns "Follow" off, so the map doesn't fight you.
map.on('dragstart', () => { if (state.follow) setFollow(false); });
$('#d-charts').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-chart]');
  if (btn) pickChart(btn.dataset.chart);
});
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
  if (e.key === 'ArrowRight') { stopPlayback(); setIndex(state.idx + 10); showDrone(); }
  if (e.key === 'ArrowLeft') { stopPlayback(); setIndex(state.idx - 10); showDrone(); }
  if (e.key === 'f' || e.key === 'F') setFollow(!state.follow);
});
