'use strict';
/*
  Places on the map: shops, schools, parks, restaurants and so on, to help
  you get your bearings. Turned on and off with "Places" in the layers panel
  (remembered in this browser).

  The places come from OpenStreetMap, through our server (api/places, see
  app/flightmap/places.py). The world is cut into squares (zoom-15 map
  tiles); we ask for the squares on screen that we don't have yet, keep the
  answers in memory, and only draw the places that are on screen.

  Places are only shown when zoomed in (zoom 16 or closer); further out
  there would be thousands. Names appear under the icons at zoom 17+.

  SAFETY: this is not an airspace or no-fly map. It shows airports and
  schools when OpenStreetMap knows them, but never says where you may fly.
*/
const Places = (() => {
  const GRID = 15;          // the squares' zoom level (must match places.py)
  const MIN_ZOOM = 16;      // show places from this zoom
  const NAMES_ZOOM = 17;    // show names under the icons from this zoom
  const MAX_SQUARES = 30;   // the server refuses more in one request
  // Same text as the free map's credit, so it is only shown once.
  const CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  // kind -> icon, colour, name in the legend (kinds are set in places.py)
  const KINDS = {
    food: ['🍴', '#e8833a', 'Food & drink'],
    shop: ['🛍', '#3f7fdc', 'Shops'],
    school: ['🎓', '#8a6a52', 'Schools'],
    health: ['✚', '#d94848', 'Health'],
    park: ['🌳', '#349a52', 'Parks & sport'],
    stay: ['🛏', '#c9508f', 'Hotels & camping'],
    sight: ['📷', '#21a39a', 'Sights'],
    car: ['⛽', '#64748b', 'Fuel & cars'],
    worship: ['⛪', '#7b7b7b', 'Places of worship'],
    public: ['🏛', '#5363b8', 'Public services'],
    fun: ['🎭', '#9b4fd0', 'Entertainment'],
    work: ['🏢', '#5f7d8c', 'Businesses'],
    transport: ['🚉', '#3a86c8', 'Stations'],
    air: ['✈', '#1f2937', 'Airports & heliports'],
  };

  // A pane just above the map pictures but under the flight paths, so a
  // path is never hidden behind a shop icon.
  map.createPane('places').style.zIndex = 390;
  const group = L.layerGroup([], { attribution: CREDIT });
  const known = new Map();     // place id -> place (everything loaded so far)
  const markers = new Map();   // place id -> marker (only those on screen)
  const loaded = new Set();    // squares already asked for ("x/y")
  let on = loadSetting('mapPlaces', '1') === '1';
  let busy = false, again = false, timer = null;
  let status = '';

  function setStatus(text) {
    status = text;
    const el = $('#places-status');
    if (el) el.textContent = text;
  }

  // The squares (tile numbers at zoom 15) covering the map on screen.
  function squaresOnScreen() {
    const b = map.getBounds().pad(0.15);
    const n = 2 ** GRID;
    const clamp = (v) => Math.max(0, Math.min(n - 1, v));
    const nw = map.project(b.getNorthWest(), GRID).divideBy(256).floor();
    const se = map.project(b.getSouthEast(), GRID).divideBy(256).floor();
    return { x0: clamp(nw.x), x1: clamp(se.x), y0: clamp(nw.y), y1: clamp(se.y) };
  }

  // The smallest box of squares holding every square we don't have yet.
  function missingBox(r) {
    let box = null;
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        if (loaded.has(`${x}/${y}`)) continue;
        box = box ? { x0: Math.min(box.x0, x), x1: Math.max(box.x1, x), y0: Math.min(box.y0, y), y1: Math.max(box.y1, y) }
          : { x0: x, x1: x, y0: y, y1: y };
      }
    }
    return box;
  }

  function icon(p) {
    const [glyph, colour] = KINDS[p.kind] || ['•', '#64748b'];
    return L.divIcon({
      className: `place-icon place-${p.kind}`,
      html: `<span class="pin" style="background:${colour}">${glyph}</span><span class="nm">${esc(p.name)}</span>`,
      iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -10],
    });
  }

  function popup(p) {
    const kind = KINDS[p.kind] || ['', '', ''];
    const osmType = { n: 'node', w: 'way', r: 'relation' }[p.id[0]];
    const osmUrl = osmType ? `https://www.openstreetmap.org/${osmType}/${encodeURIComponent(p.id.slice(1))}` : '';
    return `<div class="place-pop">
      <b>${esc(p.name)}</b>
      <div class="muted">${esc(p.label)}${kind[2] && kind[2] !== p.label ? ` · ${esc(kind[2])}` : ''}</div>
      ${p.addr ? `<div>${esc(p.addr)}</div>` : ''}
      ${p.hours ? `<div class="muted">Hours: ${esc(p.hours)}</div>` : ''}
      ${p.kind === 'air' ? '<div class="place-warn">Airports and heliports usually have flight restrictions around them. This map does not check airspace: check your local rules before flying.</div>' : ''}
      <div class="links">
        <a href="${esc(navUrl(p.lat, p.lon))}" target="_blank" rel="noopener">Navigate</a>
        ${osmUrl ? ` · <a href="${esc(osmUrl)}" target="_blank" rel="noopener">More on OpenStreetMap</a>` : ''}
      </div>
    </div>`;
  }

  // Draw the places on screen; remove those that scrolled away.
  function draw() {
    const view = map.getBounds().pad(0.2);
    for (const [id, marker] of markers) {
      if (!view.contains(marker.getLatLng())) { group.removeLayer(marker); markers.delete(id); }
    }
    let count = 0;
    for (const p of known.values()) {
      if (!view.contains([p.lat, p.lon])) continue;
      count++;
      if (markers.has(p.id)) continue;
      const marker = L.marker([p.lat, p.lon], { icon: icon(p), pane: 'places', title: p.name, keyboard: false })
        .bindPopup(() => popup(p), { className: 'place-popup', maxWidth: 260 });
      markers.set(p.id, marker);
      group.addLayer(marker);
    }
    return count;
  }

  async function load() {
    if (busy) { again = true; return; }
    const box = missingBox(squaresOnScreen());
    if (!box) { setStatus(`${draw()} places here`); return; }
    if ((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) > MAX_SQUARES) {
      setStatus('Zoom in a little more to see places');
      return;
    }
    busy = true;
    setStatus('Loading places…');
    try {
      const res = await fetch(`api/places?x0=${box.x0}&x1=${box.x1}&y0=${box.y0}&y1=${box.y1}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.busy ? 'OpenStreetMap is busy. Places will load when you move the map again.'
          : 'Could not load places from OpenStreetMap.');
        return;
      }
      for (const p of data.places || []) known.set(p.id, p);
      if (!data.truncated) {
        for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) loaded.add(`${x}/${y}`);
      }
      // Don't let memory grow forever when exploring far and wide.
      if (known.size > 20000) { known.clear(); loaded.clear(); }
      const count = on && map.getZoom() >= MIN_ZOOM ? draw() : 0;
      setStatus(data.truncated ? 'There are too many places here to show them all. Zoom in to see more.' : `${count} places here`);
    } catch {
      setStatus('Could not load places (is the map server running?)');
    } finally {
      busy = false;
      if (again) { again = false; update(); }
    }
  }

  // Called whenever the map stops moving, and when Places is switched.
  function update() {
    clearTimeout(timer);
    const zoom = map.getZoom();
    map.getContainer().classList.toggle('places-names', zoom >= NAMES_ZOOM);
    if (!on || zoom < MIN_ZOOM) {
      if (map.hasLayer(group)) map.removeLayer(group);
      setStatus(on ? 'Zoom in closer to see places' : '');
      return;
    }
    if (!map.hasLayer(group)) group.addTo(map);
    draw();
    timer = setTimeout(load, 400);   // wait until the map has stopped moving
  }

  function setOn(value) {
    on = !!value;
    saveSetting('mapPlaces', on ? '1' : '0');
    update();
  }

  // ---------- the "Places" checkbox in the layers panel ----------
  const box = $('#layer-places');
  box.checked = on;
  box.addEventListener('change', () => setOn(box.checked));
  map.on('moveend', update);
  update();

  return { setOn, isOn: () => on, status: () => status, update, KINDS };
})();
