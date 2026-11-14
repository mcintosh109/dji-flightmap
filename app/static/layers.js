'use strict';
/*
  The layers button on the map: Road / Satellite / Dark / Terrain, and the
  "Details" checkbox. Which company draws them is chosen on the settings page.
*/

// The map pictures. The settings page picks WHO draws the map (the
// provider); the layers button picks WHAT kind of map (Road, Satellite,
// Dark, Terrain). maps.js turns the two into a map style.
let baseLayer = null;
const LAYER_IDS = MapStyles.LAYERS.map((l) => l.id);

function currentLayer() {
  if (LAYER_IDS.includes(state.layer)) return state.layer;
  return LAYER_IDS.includes(state.settings.mapLayer) ? state.settings.mapLayer : 'dark';
}
function currentDetails() {
  return state.details === null ? !!state.settings.satelliteLabels : state.details === '1';
}

function applyMapStyle() {
  const s = state.settings;
  const layer = currentLayer();
  const details = currentDetails();
  const r = MapStyles.resolve(s, layer, details);
  const key = [r.id, details, s.mapProvider, s.cartoKey, s.mapboxToken, s.maptilerKey, s.azureMapsKeySet,
    s.customTileUrl, s.customAttribution].join('|');
  if (key !== state.layerKey) {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = MapStyles.build(r.id, s, { details }) || MapStyles.build('osm-dark', s);
    baseLayer.addTo(map);
    state.layerKey = key;
  }
  $('#layers-label').textContent = MapStyles.LAYERS.find((l) => l.id === layer).name;
  if (!$('#layers-panel').classList.contains('hidden')) renderLayersPanel();
}

// The layers panel: one button per layer, each with a small real picture
// of the area you're looking at, plus the "Details" checkbox.
function renderLayersPanel() {
  const s = state.settings;
  const layer = currentLayer();
  const c = map.getCenter();
  const zoom = Math.max(3, Math.min(15, Math.round(map.getZoom()) - 1));
  const grid = $('#layer-grid');
  grid.innerHTML = MapStyles.LAYERS.map((l) => {
    const r = MapStyles.resolve(s, l.id, false);
    const style = MapStyles.find(r.id);
    const thumb = MapStyles.thumbUrl(r.id, s, c.lat, c.lng, zoom);
    const note = r.noKey || r.fallback ? 'free map' : '';
    return `<button type="button" class="layer-opt${l.id === layer ? ' active' : ''}" data-layer="${l.id}"
        aria-pressed="${l.id === layer}" title="${esc(MapStyles.label(style, s))}">
      <span class="thumb thumb-${l.id} ${esc(style.opts.className || '')}">${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}</span>
      <span class="name">${esc(l.name)}</span>${note ? `<small>${note}</small>` : ''}
    </button>`;
  }).join('');
  grid.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.remove()));
  grid.querySelectorAll('.layer-opt').forEach((btn) => btn.addEventListener('click', () => {
    state.layer = btn.dataset.layer;
    saveSetting('mapLayer', state.layer);   // remembered in this browser
    applyMapStyle();
  }));

  const details = $('#layer-details');
  details.checked = currentDetails();
  details.disabled = layer !== 'satellite';
  details.closest('label').classList.toggle('disabled', details.disabled);

  const provider = MapStyles.PROVIDERS[s.mapProvider] || MapStyles.PROVIDERS.free;
  const r = MapStyles.resolve(s, layer, false);
  $('#layers-foot').innerHTML = r.noKey
    ? `${esc(provider.name)} needs a key, so free maps are shown. <a href="settings.html">Add it in Settings</a>`
    : `Maps by ${esc(provider.name)} · <a href="settings.html">change in Settings</a>`;
}

function toggleLayersPanel(open) {
  const panel = $('#layers-panel');
  const show = open ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  $('#btn-layers').setAttribute('aria-expanded', String(show));
  if (show) renderLayersPanel();
}

// ---------- buttons ----------
$('#btn-layers').addEventListener('click', (e) => { e.stopPropagation(); toggleLayersPanel(); });
$('#layer-details').addEventListener('change', (e) => {
  state.details = e.target.checked ? '1' : '0';
  saveSetting('mapDetails', state.details);
  applyMapStyle();
});
// Close the layers panel when clicking elsewhere or pressing Esc.
// Clicks inside the panel stop here: picking a layer redraws the panel, and
// the clicked button would otherwise look like it was "outside".
$('#layers-panel').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
  if (!e.target.closest('#layers-panel, #btn-layers')) toggleLayersPanel(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleLayersPanel(false); });
