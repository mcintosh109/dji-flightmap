'use strict';
/*
  Settings page. Reads the current values from GET api/settings,
  and saves them with PUT api/settings. ($, $$ and esc come from common.js.)
*/

// These are kept when you press "Reset to defaults", because they are
// things you typed in yourself and would be annoying to lose.
const KEEP_ON_RESET = ['cartoKey', 'mapboxToken', 'maptilerKey', 'azureMapsKey', 'googleMapsKey', 'customTileUrl', 'customTileName', 'customAttribution', 'aircraftNames'];

// Keys that stay on the server. The page only learns whether one is saved
// ("<key>Set"); "remove<Key>" deletes it when you press Save.
const SERVER_KEYS = [
  { key: 'azureMapsKey', box: 'azure', placeholder: 'Primary key from your Azure Maps account' },
  { key: 'googleMapsKey', box: 'google', placeholder: 'API key from Google Cloud (starts with AIza)' },
];
const removeFlag = (key) => `remove${key[0].toUpperCase()}${key.slice(1)}`;

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
  fillProviderList(values);
  showProviderFields(values.mapProvider);
  // HTTPS: the DNS company list, and the secret boxes start empty.
  const known = [...$('#https-dns').options].some((o) => o.value === values.httpsDnsApi);
  $('#https-dns').value = known ? values.httpsDnsApi : 'other';
  for (const el of $$('[data-cred]')) el.value = '';
  $('#cred-other').value = '';
  showHttpsFields();
  showKeyStatus();
}

// Show only the HTTPS boxes for the chosen kind and DNS company.
function showHttpsFields() {
  const mode = $('[name=httpsMode]:checked')?.value || 'private';
  const dns = $('#https-dns').value;
  for (const el of $$('.https-for')) el.classList.toggle('hidden', el.dataset.for !== mode);
  $('.https-on').classList.toggle('hidden', mode === 'off');
  for (const el of $$('.dns-for')) el.classList.toggle('hidden', el.dataset.dns !== dns);
  $('#https-save-note').classList.toggle('hidden', !saved || mode === saved.httpsMode);
}

// "A key is saved (hidden)" / "will be removed" under the Azure and Google key boxes.
function showKeyStatus() {
  for (const { key, box, placeholder } of SERVER_KEYS) {
    const remove = document.getElementById(removeFlag(key)).checked;
    const isSaved = !!saved?.[`${key}Set`];
    document.getElementById(key).placeholder = isSaved && !remove ? 'A key is saved (hidden). Type a new one to replace it.' : placeholder;
    $(`#${box}-remove`).classList.toggle('hidden', !isSaved || remove);
    $(`#${box}-key-status`).textContent = remove ? 'The saved key will be removed when you press Save.'
      : isSaved ? '✓ A key is saved on the server.' : 'No key saved yet.';
  }
  // The DNS details for Let's Encrypt: only their names come back.
  const dropping = $('#removeHttpsDnsCredentials').checked;
  const names = dropping ? [] : (saved?.httpsDnsCredentialsSet || []);
  $('#dns-key-status').textContent = dropping
    ? 'The saved DNS details will be removed when you press Save.'
    : names.length ? `✓ Saved on the server (hidden): ${names.join(', ')}. Leave the boxes empty to keep them.` : 'No DNS details saved yet.';
  $('#dns-remove').classList.toggle('hidden', !names.length);
  for (const el of $$('[data-cred]')) {
    el.placeholder = names.includes(el.dataset.cred) ? 'Saved (hidden). Type a new one to replace it.' : '';
  }
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
  // Server-only keys are never sent to this page; only whether one is saved.
  for (const { key } of SERVER_KEYS) out[`${key}Set`] = !!saved?.[`${key}Set`] && !out[removeFlag(key)];
  // HTTPS: the DNS company, and only the DNS details typed in just now.
  const dns = $('#https-dns').value;
  if (dns !== 'other') out.httpsDnsApi = dns;
  const creds = {};
  if (dns === 'other') {
    for (const line of $('#cred-other').value.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0 && line.slice(at + 1).trim()) creds[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  } else {
    for (const el of $$(`.dns-for[data-dns="${dns}"] [data-cred]`)) if (el.value.trim()) creds[el.dataset.cred] = el.value.trim();
  }
  if (Object.keys(creds).length) out.httpsDnsCredentials = creds;
  out.aircraftNames = {};
  for (const input of $$('[data-serial]')) {
    if (input.value.trim()) out.aircraftNames[input.dataset.serial] = input.value.trim();
  }
  return out;
}

// The provider list, noting which still need a key.
function fillProviderList(values) {
  const select = $('#mapProvider');
  select.innerHTML = Object.entries(MapStyles.PROVIDERS).map(([id, p]) => {
    const missing = p.needs && !String(values[p.needs] || '').trim() && values[`${p.needs}Set`] !== true;
    return `<option value="${id}"${id === values.mapProvider ? ' selected' : ''}>${esc(p.name)}${missing ? ' (add key below)' : ''}</option>`;
  }).join('');
}

// Show only the key box for the chosen provider (the others stay saved).
function showProviderFields(provider) {
  for (const box of $$('.provider-key')) box.classList.toggle('hidden', box.dataset.provider !== provider);
}

// "= 400 ft" next to the planner boxes, which are in metres.
function updateConversions() {
  for (const el of $$('.conv')) {
    const v = Number(document.getElementById(el.dataset.for).value) || 0;
    if (el.dataset.conv === 'height') el.textContent = `= ${Math.round(v * 3.28084)} ft`;
    if (el.dataset.conv === 'distance') el.textContent = v * 3.28084 < 5280 ? `= ${Math.round(v * 3.28084)} ft` : `= ${(v / 1609.344).toFixed(2)} mi`;
    if (el.dataset.conv === 'speed') el.textContent = `= ${Math.round(v * 2.23694)} mph`;
  }
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

// ---------- HTTPS ----------
function renderHttps(h) {
  const status = $('#https-status');
  const kind = h.mode === 'letsencrypt' ? "Let's Encrypt (renews itself)" : 'a private certificate';
  for (const el of $$('.http-port')) el.textContent = h.httpPort || 8080;
  if (h.state === 'on') {
    status.textContent = `🔒 On, with ${kind}, for ${(h.names || []).join(', ') || 'this map'}.`
      + (h.expires ? ` Valid until ${h.expires}.` : '');
    status.className = 'help ok';
    if (h.newCa && h.mode === 'private') status.textContent += ' This is a new certificate: each device must trust it once (below).';
    if (Number.isInteger(h.daysLeft) && h.daysLeft < 30 && h.mode === 'private') {
      status.textContent += ` It runs out in ${h.daysLeft} days: press "Make a new certificate now".`;
      status.className = 'help warn';
    }
  } else if (h.state === 'working') {
    status.textContent = `⏳ ${h.message || 'Working…'}`;
    status.className = 'help';
  } else if (h.state === 'error') {
    status.textContent = `⚠️ ${h.message} The map is still reachable.`;
    status.className = 'help warn';
  } else {
    status.textContent = 'Off: the map uses plain http, so your password travels unencrypted on your network.';
    status.className = 'help warn';
  }
  $('#https-private').classList.toggle('hidden', !(h.state === 'on' && h.caCert));
}

// The address of this page after the map switches.
function httpsTarget(s, h) {
  if (s.httpsMode === 'off') return `http://${location.hostname}:${h.httpPort || 8080}/settings.html#https`;
  const host = s.httpsMode === 'letsencrypt' && s.httpsName ? s.httpsName : location.hostname;
  return `https://${host}${s.httpsPort === 443 ? '' : `:${s.httpsPort}`}/settings.html#https`;
}

// After saving a new choice (or "Make a new certificate now"): wait until
// the map has switched, then move this page to the new address.
async function followHttps(target) {
  const status = $('#https-status');
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 2000));
  while (Date.now() - started < 5 * 60 * 1000) {
    let h = null;
    try {
      const res = await fetch('api/settings', { cache: 'no-store' });
      h = res.ok ? (await res.json()).info.https : null;
    } catch { h = null; }
    if (!h) {   // this address stopped answering: the map moved
      status.textContent = `Moving to ${target} …`;
      location.href = target;
      return;
    }
    renderHttps(h);
    if (h.state === 'error') return;
    if (h.state !== 'working') {
      if (target.split('/settings')[0] !== `${location.protocol}//${location.host}`) location.href = target;
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- preview map ----------
function updatePreview() {
  const values = readForm();
  const provider = MapStyles.PROVIDERS[values.mapProvider] || MapStyles.PROVIDERS.free;
  const layerName = MapStyles.LAYERS.find((l) => l.id === values.mapLayer)?.name || 'Road';
  const r = MapStyles.resolve(values, values.mapLayer, values.satelliteLabels);
  const status = $('#preview-status');
  if (previewLayer) previewMap.removeLayer(previewLayer);
  previewLayer = MapStyles.build(r.id, values, { details: values.satelliteLabels });
  // A note shown with the preview result, when free maps stand in.
  const note = r.noKey ? ` ${provider.name} needs a key (above), so this preview shows the free map.`
    : r.fallback ? ` ${provider.name} has no ${layerName} layer, so the free one is used.`
      // Google pictures come through the server, with the SAVED key.
      : values.mapProvider === 'google' && values.googleMapsKey ? ' Press Save to preview Google Maps with the new key.' : '';
  let loaded = 0, failed = 0;
  const report = () => {
    if (failed && !loaded) {
      status.textContent = 'The map pictures did not load. Check the key or address, and that this browser has internet.' + note;
      status.className = 'help warn';
    } else if (loaded) {
      status.textContent = (failed ? `Preview loaded (${failed} pictures failed).` : 'Preview loaded ✓') + note;
      status.className = note && r.noKey ? 'help warn' : 'help ok';
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
    const httpsBefore = JSON.stringify([saved.httpsMode, saved.httpsName, saved.httpsPort, saved.httpsDnsApi]);
    const credsTyped = !!readForm().httpsDnsCredentials;
    saved = data.settings;
    renderHttps(data.info.https);
    if (httpsBefore !== JSON.stringify([saved.httpsMode, saved.httpsName, saved.httpsPort, saved.httpsDnsApi]) || credsTyped) {
      followHttps(httpsTarget(saved, data.info.https));
    }
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
  const u = await Updates.check(info.version, info.repo, { force });
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
  } else if (u.testing) {
    status.innerHTML = u.latest
      ? `You have ${installed}, a test version that isn't released yet. The newest release is ${esc(u.latest)}.`
      : `You have ${installed}. No version has been released yet.`;
    status.className = 'upd-status';
  } else {
    status.innerHTML = `You're up to date: ${installed} is the newest release.`;
    status.className = 'upd-status ok';
  }
  $('#upd-notes').innerHTML = notes.length
    ? `<h3>${esc(title)}</h3><ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
}

// ---------- the NAS connection ----------
// The checks run on the server (api/nas): does the NAS answer, is its share
// connected, can the logs be read, is the Proxmox server's helper running.
const NAS_POLL_MS = 5000;
const NAS_WAIT_MS = 4 * 60 * 1000;

function renderNas(n) {
  $('#nas-summary').textContent = n.summary;
  $('#nas-summary').className = `help ${n.ok ? 'ok' : n.pending ? '' : 'warn'}`;
  $('#nas-checks').innerHTML = n.checks.map((c) => {
    const [mark, cls] = c.ok === true ? ['✓', 'ok'] : c.ok === false ? ['✗', 'warn'] : ['–', 'muted'];
    return `<li class="${cls}"><span aria-hidden="true">${mark}</span> ${esc(c.text)}</li>`;
  }).join('');
  $('#nas-message').textContent = n.message ? `The Proxmox server says: ${n.message}` : '';
  $('#nas-message').classList.toggle('hidden', !n.message);
  const share = n.kind === 'share';
  $('#nas-reconnect').classList.toggle('hidden', !share);
  for (const el of $$('.nas-share-only')) el.classList.toggle('hidden', !share);
}

async function checkNas() {
  try {
    const res = await fetch('api/nas', { cache: 'no-store' });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    const n = await res.json();
    renderNas(n);
    return n;
  } catch {
    $('#nas-summary').textContent = "The map isn't answering right now (it may be restarting to reconnect)…";
    $('#nas-summary').className = 'help';
    return null;
  }
}

// "Reconnect now": leave a note for the Proxmox server, then keep checking
// until it has been handled (it checks every minute; the map may restart).
async function reconnectNas() {
  const btn = $('#nas-reconnect');
  btn.disabled = true;
  try {
    const res = await fetch('api/nas/reconnect', { method: 'POST', headers: { 'X-Requested-With': 'flightmap' } });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    $('#nas-summary').textContent = '⏳ Asked the Proxmox server to reconnect…';
    $('#nas-summary').className = 'help';
    const started = Date.now();
    while (Date.now() - started < NAS_WAIT_MS) {
      await new Promise((r) => setTimeout(r, NAS_POLL_MS));
      const n = await checkNas();
      if (n && !n.pending) return;
    }
    $('#nas-summary').textContent = "⚠️ The Proxmox server hasn't answered yet. Is the automatic reconnect set up? (See the list above.)";
    $('#nas-summary').className = 'help warn';
  } catch (err) {
    $('#nas-summary').textContent = `Couldn't ask for a reconnect (${err.message}).`;
    $('#nas-summary').className = 'help warn';
  } finally {
    btn.disabled = false;
  }
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
  renderHttps(info.https || { on: false });
  renderAircraft();
  fillForm(saved);
  baseline = JSON.stringify(readForm());
  $('#form').classList.remove('hidden');
  $('#savebar').classList.remove('hidden');
  $('#upd-cmd').textContent = Updates.COMMAND;
  Updates.wireCopyButton($('#upd-copy'));
  Updates.wireCopyButton($('#https-copy'), $('#https-cmd').textContent);
  $('#https-dns').addEventListener('change', () => { showHttpsFields(); updateSaveBar(); });
  $('#dns-remove').addEventListener('click', () => {
    $('#removeHttpsDnsCredentials').checked = true;
    showKeyStatus();
    updateSaveBar();
  });
  $('#https-renew').addEventListener('click', async () => {
    if (!confirm('Make a new certificate now? Devices that trust the map keep trusting it (unless the address changed).')) return;
    const res = await fetch('api/https/renew', { method: 'POST', headers: { 'X-Requested-With': 'flightmap' } });
    if (res.ok) followHttps(httpsTarget(saved, (await res.json()).info.https));
  });
  if (location.hash === '#https') $('#https').scrollIntoView();
  $('#nas-check').addEventListener('click', checkNas);
  $('#nas-reconnect').addEventListener('click', reconnectNas);
  checkNas();   // check the NAS every time the settings page opens
  $('#upd-check').addEventListener('click', () => showUpdates(true));
  showUpdates(true);   // always ask GitHub when the settings page opens
  if (location.hash === '#updates') $('#updates').scrollIntoView();
  await centrePreview();
  updatePreview();
  updateSaveBar();

  updateConversions();
  $('#form').addEventListener('input', updateConversions);
  $('#form').addEventListener('input', (e) => {
    // Typing a key can make a style usable, so refresh the list's notes.
    if (['cartoKey', 'mapboxToken', 'maptilerKey', 'azureMapsKey', 'googleMapsKey', 'customTileUrl'].includes(e.target.dataset.key)) {
      fillProviderList(readForm());
    }
    if (e.target.dataset.key === 'mapProvider') showProviderFields(e.target.value);
    if (e.target.dataset.key === 'httpsMode') showHttpsFields();
    if (e.target.closest('.card') === $('#mapProvider').closest('.card')) updatePreview();
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
  for (const { key, box } of SERVER_KEYS) {
    $(`#${box}-remove`).addEventListener('click', () => {
      document.getElementById(removeFlag(key)).checked = true;
      document.getElementById(key).value = '';
      showKeyStatus();
      fillProviderList(readForm());
      updatePreview();
      updateSaveBar();
    });
  }
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
