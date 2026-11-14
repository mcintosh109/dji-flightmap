'use strict';
/*
  Settings page. Reads the current values from GET api/settings,
  and saves them with PUT api/settings.
*/
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// These are kept when you press "Reset to defaults", because they are
// things you typed in yourself and would be annoying to lose.
const KEEP_ON_RESET = ['cartoKey', 'mapboxToken', 'maptilerKey', 'azureMapsKey', 'customTileUrl', 'customTileName', 'customAttribution', 'aircraftNames'];

let saved = null;      // the values as saved on the server
let baseline = '';     // the form's contents right after loading/saving
let defaults = null;
let info = null;
let previewMap = null;
let previewLayer = null;

// ---------- reading and filling the form ----------
function fillForm(values) {
  for (const el of $$('[data-key]')) {
    const value = values[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.type === 'radio') el.checked = el.value === value;
    else el.value = value ?? '';
  }
  for (const input of $$('[data-serial]')) {
    input.value = values.aircraftNames?.[input.dataset.serial] || '';
  }
  fillStyleList(values);
}

function readForm() {
  const out = {};
  for (const el of $$('[data-key]')) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') out[key] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[key] = el.value; }
    else if ('number' in el.dataset) out[key] = el.value === '' ? NaN : Math.round(Number(el.value));
    else out[key] = el.value.trim();
  }
  out.aircraftNames = {};
  for (const input of $$('[data-serial]')) {
    if (input.value.trim()) out.aircraftNames[input.dataset.serial] = input.value.trim();
  }
  return out;
}

// The style list, with a note on styles that still need a key.
function fillStyleList(values) {
  const select = $('#mapStyle');
  const chosen = values.mapStyle;
  const groups = {};
  for (const st of MapStyles.STYLES) (groups[st.group] ||= []).push(st);
  select.innerHTML = Object.entries(groups).map(([group, styles]) =>
    `<optgroup label="${esc(group)}">${styles.map((st) => {
      const missing = st.needs && !String(values[st.needs] || '').trim();
      const name = MapStyles.label(st, values) + (missing ? ' (needs key)' : '');
      return `<option value="${st.id}"${st.id === chosen ? ' selected' : ''}>${esc(name)}</option>`;
    }).join('')}</optgroup>`).join('');
}

function renderAircraft() {
  const box = $('#aircraft-names');
  if (!info.aircraft.length) {
    box.innerHTML = '<p class="help">No aircraft found in the logs yet.</p>';
    return;
  }
  box.innerHTML = info.aircraft.map((a) => `
    <div class="field inline">
      <label for="name-${esc(a.serial)}">${esc(a.model)} <span class="muted">SN ···${esc(a.serial.slice(-6))}</span></label>
      <input id="name-${esc(a.serial)}" data-serial="${esc(a.serial)}" maxlength="40" placeholder="${esc(a.model)}">
    </div>`).join('');
}

// ---------- preview map ----------
function updatePreview() {
  const values = readForm();
  const style = MapStyles.find(values.mapStyle);
  const status = $('#preview-status');
  if (previewLayer) previewMap.removeLayer(previewLayer);
  previewLayer = MapStyles.build(values.mapStyle, values);
  if (!previewLayer) {
    status.textContent = `"${MapStyles.label(style, values)}" needs a key: fill in the ${style.group} key below.`;
    status.className = 'help warn';
    return;
  }
  let loaded = 0, failed = 0;
  const report = () => {
    if (failed && !loaded) {
      status.textContent = 'The map pictures did not load. Check the key or address, and that this browser has internet.';
      status.className = 'help warn';
    } else if (loaded) {
      status.textContent = failed ? `Preview loaded (${failed} pictures failed).` : 'Preview loaded ✓';
      status.className = 'help ok';
    }
  };
  // A style can be several layers (satellite + names): listen to each one.
  const parts = [];
  if (previewLayer.eachLayer) previewLayer.eachLayer((l) => parts.push(l)); else parts.push(previewLayer);
  for (const part of parts) {
    part.on('tileload', () => { loaded++; report(); });
    part.on('tileerror', () => { failed++; report(); });
  }
  status.textContent = 'Loading preview…';
  status.className = 'help';
  previewLayer.addTo(previewMap);
}

async function centrePreview() {
  previewMap = L.map('preview', { zoomControl: true, attributionControl: true }).setView([39, -98], 3);
  try {
    // Centre on your most recent flight, so you see a familiar place.
    const res = await fetch('api/flights', { cache: 'no-store' });
    const data = await res.json();
    const f = data.flights.find((x) => x.last);
    if (f) previewMap.setView([f.last.lat, f.last.lon], 17);
  } catch { /* keep the default view */ }
}

// ---------- unsaved changes ----------
function isDirty() {
  return JSON.stringify(readForm()) !== baseline;
}
function updateSaveBar(message) {
  const dirty = isDirty();
  $('#btn-save').disabled = !dirty;
  $('#save-msg').textContent = message || (dirty ? 'Unsaved changes' : 'All changes saved');
  $('#save-msg').className = dirty ? 'warn' : '';
}

// ---------- saving ----------
async function save() {
  const btn = $('#btn-save');
  btn.disabled = true;
  $('#save-msg').textContent = 'Saving…';
  try {
    const res = await fetch('api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'flightmap' },
      body: JSON.stringify(readForm()),
    });
    if (res.status === 401) { location.href = 'login.html'; return; }
    const data = await res.json();
    if (!res.ok) {
      $('#save-msg').textContent = data.error || `Could not save (server answered ${res.status}).`;
      $('#save-msg').className = 'error';
      btn.disabled = false;
      return;
    }
    saved = data.settings;
    // Let the new defaults show: forget this browser's own map/unit choice.
    try { localStorage.removeItem('units'); localStorage.removeItem('layer'); } catch { /* ignore */ }
    fillForm(saved);
    baseline = JSON.stringify(readForm());
    updateSaveBar('Saved ✓');
  } catch (err) {
    $('#save-msg').textContent = `Could not reach the server (${err.message}).`;
    $('#save-msg').className = 'error';
    btn.disabled = false;
  }
}

// ---------- updates ----------
async function showUpdates(force = false) {
  const status = $('#upd-status');
  status.textContent = 'Checking…';
  status.className = 'upd-status';
  const u = await Updates.check(info.version, info.updateUrl, { force });
  const installed = `version ${esc(info.version)}${info.released ? ` (released ${esc(info.released)})` : ''}`;
  let notes = info.notes || [], title = 'In your version';
  if (u.error) {
    status.innerHTML = `You have ${installed}. Couldn't reach GitHub to check for a newer one (${esc(u.error)}).`;
    status.className = 'upd-status warn';
  } else if (u.available) {
    status.innerHTML = `<b>Version ${esc(u.latest)}</b> is available. You have ${installed}.`;
    status.className = 'upd-status available';
    notes = u.notes || [];
    title = `What's new in ${u.latest}`;
  } else {
    status.innerHTML = `You're up to date: ${installed}.`;
    status.className = 'upd-status ok';
  }
  $('#upd-notes').innerHTML = notes.length
    ? `<h3>${esc(title)}</h3><ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
}

// ---------- start ----------
async function start() {
  try {
    const res = await fetch('api/settings', { cache: 'no-store' });
    if (res.status === 401) { location.href = 'login.html'; return; }
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    ({ settings: saved, defaults, info } = await res.json());
  } catch (err) {
    $('#load-error').textContent = `Could not load the settings (${err.message}).`;
    $('#load-error').classList.remove('hidden');
    $('#version').textContent = '';
    return;
  }
  $('#version').textContent = `Flight Map ${info.version}`;
  $('#info-login').textContent = info.auth ? `On (username: ${info.user})` : 'Off: anyone on your network can open the map';
  $('#info-data').textContent = info.dataDir;
  renderAircraft();
  fillForm(saved);
  baseline = JSON.stringify(readForm());
  $('#form').classList.remove('hidden');
  $('#savebar').classList.remove('hidden');
  $('#upd-cmd').textContent = Updates.COMMAND;
  Updates.wireCopyButton($('#upd-copy'));
  $('#upd-check').addEventListener('click', () => showUpdates(true));
  showUpdates();
  if (location.hash === '#updates') $('#updates').scrollIntoView();
  await centrePreview();
  updatePreview();
  updateSaveBar();

  $('#form').addEventListener('input', (e) => {
    // Typing a key can make a style usable, so refresh the list's notes.
    if (['cartoKey', 'mapboxToken', 'maptilerKey', 'azureMapsKey', 'customTileUrl', 'customTileName'].includes(e.target.dataset.key)) {
      fillStyleList(readForm());
    }
    if (e.target.closest('.card') === $('#mapStyle').closest('.card')) updatePreview();
    updateSaveBar();
  });
  $('#form').addEventListener('change', () => { updatePreview(); updateSaveBar(); });
  $('#form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  $('#btn-save').addEventListener('click', save);
  $('#btn-defaults').addEventListener('click', () => {
    if (!confirm('Put every setting back to its default? Your map keys, custom map and nicknames are kept. Nothing is saved until you press Save.')) return;
    const current = readForm();
    const next = { ...defaults };
    for (const key of KEEP_ON_RESET) next[key] = current[key];
    fillForm(next);
    updatePreview();
    updateSaveBar();
  });
  for (const btn of $$('.show-btn')) {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.for);
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
    });
  }
  // Warn before leaving the page with unsaved changes.
  window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
}

start();
