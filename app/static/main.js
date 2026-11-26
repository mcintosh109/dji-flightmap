'use strict';
/*
  Loading data from the server, applying settings, and start-up.
  Loaded after the other map scripts, so everything it calls exists.
*/

// Apply new settings-page values to everything on screen.
function applySettings() {
  applyMapStyle();
  updateUnitsButton();
  $('#p-speed').value = String(state.settings.playbackSpeed);
  if (state.detail) { drawSelected(); renderDetail(); setIndex(state.idx); }
  updateOverviewVisibility();
  if (typeof Planner !== 'undefined') Planner.refresh();
}

async function refresh({ force = false, rescan = false } = {}) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    // The refresh button asks the server to look for new files right now.
    const res = rescan
      ? await fetch('api/rescan', { method: 'POST', headers: { 'X-Requested-With': 'flightmap' } })
      : await fetch('api/flights', { cache: 'no-store' });
    if (res.status === 401) { location.href = 'login.html'; return; }   // signed out
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    const data = await res.json();
    const settingsKey = JSON.stringify(data.settings || {});
    const settingsChanged = settingsKey !== state.settingsKey;
    if (settingsChanged && data.settings) {
      state.settings = data.settings;
      state.settingsKey = settingsKey;
    }
    const changed = force || settingsChanged || data.version !== state.version;
    state.version = data.version;
    state.lastData = data;
    state.flights = data.flights.filter(isVisible);
    state.hiddenCount = data.flights.length - state.flights.length;
    if (settingsChanged) applySettings();
    renderStatus(data);
    $('#btn-logout').classList.toggle('hidden', !data.auth);
    if (changed) {
      renderAircraft(data);
      renderFlights(data);
      Stats.render();
      drawOverview();
      updateOverviewVisibility();
    }
    if (state.firstLoad && !data.scanning) {
      state.firstLoad = false;
      const wanted = new URLSearchParams(location.hash.slice(1)).get('flight');
      if (wanted && state.flights.some((f) => f.id === wanted)) selectFlight(wanted);
      else fitAll();
    }
    if (data.scanning) setTimeout(refresh, 2000);  // first scan still running
    // Every time the page opens: ask GitHub. After that, while the page stays
    // open, the answer is remembered for 6 hours (this runs every minute).
    checkForUpdates({ fresh: !state.checkedOnLoad });
    state.checkedOnLoad = true;
  } catch (err) {
    $('#status').textContent = `Can't reach the server (${err.message})`;
  } finally {
    btn.classList.remove('spin');
  }
}

// ---------- buttons ----------
$('#btn-refresh').addEventListener('click', () => refresh({ force: true, rescan: true }));
$('#btn-units').addEventListener('click', () => {
  state.units = units() === 'imperial' ? 'metric' : 'imperial';
  saveSetting('units', state.units);
  updateUnitsButton();
  refresh({ force: true });
  if (state.detail) { renderDetail(); setIndex(state.idx); }
});
function updateUnitsButton() { $('#btn-units').textContent = units() === 'imperial' ? 'ft · mph' : 'm · km/h'; }

// ---------- start ----------
// The map pictures are drawn once the saved settings (provider, layer) have
// arrived; if the server doesn't answer within 3 seconds, use the free map.
setTimeout(() => { if (!baseLayer) applyMapStyle(); }, 3000);
setFollow(state.follow);
updateUnitsButton();
refresh();
setInterval(refresh, REFRESH_MS);
