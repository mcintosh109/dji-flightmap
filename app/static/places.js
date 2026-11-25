'use strict';
/*
  Places on the map: shops, schools, parks, restaurants and so on, to help
  you get your bearings. Turned on and off with "Places" in the layers panel
  (remembered in this browser).

  The places come from OpenStreetMap, through our server (api/places, see
  app/flightmap/places.py). The world is cut into squares (zoom-15 map
  tiles); we ask for the squares on screen that we don't have yet, keep the
  answers in memory, and only draw the places that are on screen.

  With Google Maps as the map provider, the places come from GOOGLE instead
  (api/google-places, see app/flightmap/gplaces.py): Google's map pictures
  leave out many businesses. Each Google search gives the 20 places closest
  to the middle of the screen and counts towards a daily limit (Settings),
  so we only search again after the map has moved a fair way.

  With Azure Maps, the places come from AZURE (api/azure-places, see
  app/flightmap/azplaces.py) the same way: the 100 nearest, from zoom 14,
  remembered on the server. If Azure refuses (its old search may be
  switched off one day) or today's searches are used up, OpenStreetMap's
  places are shown instead.

  Places are only shown when zoomed in (zoom 16 or closer; Azure 14);
  further out there would be thousands. Names appear under the icons at
  zoom 17+.

  SAFETY: this is not an airspace or no-fly map. It shows airports and
  schools when OpenStreetMap knows them, but never says where you may fly.
*/
const Places = (() => {
  const GRID = 15;          // the squares' zoom level (must match places.py)
  const MIN_ZOOM = 16;      // show places from this zoom (Azure: from 14, see minZoom())
  const NAMES_ZOOM = 17;    // show names under the icons from this zoom
  const FULL_ZOOM = 16;     // further out (Azure places from 14): smaller icons that never overlap
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
  const group = L.layerGroup();
  const known = new Map();     // place id -> place (everything loaded so far)
  const markers = new Map();   // place id -> marker (only those on screen)
  const loaded = new Set();    // squares already asked for ("x/y")
  let on = loadSetting('mapPlaces', '1') === '1';
  let busy = false, again = false, timer = null;
  let status = '';
  let source = '';             // 'osm', 'google' or 'azure': where the places come from
  let lastSearch = null;       // Google/Azure: { center, radius } of the last search
  // Azure refused: OpenStreetMap's places until this time (ms). Today's searches
  // used up = until the page is opened again; anything else = 5 minutes, then
  // Azure is asked again (one hiccup used to mean OpenStreetMap all day).
  let azureOffUntil = 0;
  let azureWhy = '';           // why Azure isn't used now, shown above the places status
  const AZURE_RETRY_MS = 5 * 60e3;
  let credit = false;          // OpenStreetMap credit shown?
  let limitHit = false;        // Google: today's searches used up
  let pinsWere = null;         // last answer of googlePinsShown()

  // Are Google's places shown as pins? Then the Google map pictures leave
  // their own place labels out (maps.js), so each place shows once.
  function googlePinsShown() {
    return on && currentSource() === 'google' && !limitHit;
  }
  // When that changes, the map pictures must be fetched again.
  function refreshPictures() {
    const now = googlePinsShown();
    if (pinsWere !== null && now !== pinsWere && typeof baseLayer !== 'undefined' && baseLayer?.redraw) baseLayer.redraw();
    pinsWere = now;
  }

  // Google's places with the Google map (Google's rules: only on a Google
  // map), Azure's with the Azure map, OpenStreetMap otherwise (and when
  // Azure refuses: its old search may be switched off one day).
  function currentSource() {
    const s = state.settings;
    if (s.mapProvider === 'google' && s.googleMapsKeySet && (s.googlePlacesDailyLimit ?? 150) > 0) return 'google';
    if (s.mapProvider === 'azure' && s.azureMapsKeySet && (s.azurePlacesDailyLimit ?? 150) > 0 && Date.now() >= azureOffUntil) return 'azure';
    return 'osm';
  }
  // Azure gives the nearest 100 businesses, so they are useful a little
  // further out than OpenStreetMap's (which come square by square).
  const minZoom = () => (source === 'azure' ? 14 : MIN_ZOOM);

  // Searches around the middle of the screen (Google, Azure).
  const NEARBY = {
    google: { url: 'api/google-places', name: 'Google', maxRadius: 2000 },
    azure: { url: 'api/azure-places', name: 'Azure Maps', maxRadius: 5000 },
  };

  // The OpenStreetMap credit, only while its places are on the map.
  function showCredit(show) {
    if (show === credit || !map.attributionControl) return;
    if (show) map.attributionControl.addAttribution(CREDIT); else map.attributionControl.removeAttribution(CREDIT);
    credit = show;
  }

  // Start again when the source changes (Settings changed the provider).
  function checkSource() {
    const now = currentSource();
    showSource(now);
    if (now === source) return;
    source = now;
    known.clear();
    loaded.clear();
    group.clearLayers();
    markers.clear();
    lastSearch = null;
  }

  // While OpenStreetMap stands in for Azure, the reason stays in view.
  function setStatus(text) {
    status = azureWhy && source === 'osm' && text ? `${azureWhy} ${text}` : text;
    const el = $('#places-status');
    if (el) el.textContent = status;
  }

  // The "Places come from ..." line in the layers panel.
  function showSource(now) {
    const el = $('#places-from');
    if (!el) return;
    const name = { google: 'Google', azure: 'Azure Maps', osm: 'OpenStreetMap' }[now];
    el.textContent = `Places come from ${name}.`;
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

  // The label shown while pointing at an icon: the name, and what kind of place it is.
  function hoverText(p) {
    const group = (KINDS[p.kind] || [])[2] || '';
    const what = [p.label, group && group !== p.label ? group : ''].filter(Boolean).join(' · ');
    return `<b>${esc(p.name)}</b>${what ? `<br><span class="muted">${esc(what)}</span>` : ''}`;
  }

  function popup(p) {
    const kind = KINDS[p.kind] || ['', '', ''];
    const osmType = p.id.startsWith('g:') ? '' : { n: 'node', w: 'way', r: 'relation' }[p.id[0]];
    const osmUrl = osmType ? `https://www.openstreetmap.org/${osmType}/${encodeURIComponent(p.id.slice(1))}` : '';
    const googleUrl = /^https:\/\//.test(p.link || '') ? p.link : '';
    return `<div class="place-pop">
      <b>${esc(p.name)}</b>
      <div class="muted">${esc(p.label)}${kind[2] && kind[2] !== p.label ? ` · ${esc(kind[2])}` : ''}</div>
      ${p.addr ? `<div>${esc(p.addr)}</div>` : ''}
      ${p.hours ? `<div class="muted">Hours: ${esc(p.hours)}</div>` : ''}
      ${p.kind === 'air' ? '<div class="place-warn">Airports and heliports usually have flight restrictions around them. This map does not check airspace: check your local rules before flying.</div>' : ''}
      <div class="links">
        <a href="${esc(navUrl(p.lat, p.lon))}" target="_blank" rel="noopener">Navigate</a>
        ${osmUrl ? ` · <a href="${esc(osmUrl)}" target="_blank" rel="noopener">More on OpenStreetMap</a>` : ''}
        ${googleUrl ? ` · <a href="${esc(googleUrl)}" target="_blank" rel="noopener">Open in Google Maps</a>` : ''}
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
      // Pointing at an icon says what it is (owner's wish); clicking it
      // opens the popup with the address, hours and links.
      const marker = L.marker([p.lat, p.lon], { icon: icon(p), pane: 'places', keyboard: false })
        .bindTooltip(() => hoverText(p), { direction: 'top', offset: [0, -10], className: 'place-tip' })
        .bindPopup(() => popup(p), { className: 'place-popup', maxWidth: 260 })
        // The label would cover the popup: hide it while the popup is open.
        .on('popupopen', () => marker.closeTooltip())
        .on('tooltipopen', () => { if (marker.isPopupOpen()) marker.closeTooltip(); });
      marker.place = p;
      markers.set(p.id, marker);
      group.addLayer(marker);
    }
    requestAnimationFrame(declutter);
    return count;
  }

  // Do two boxes on screen overlap? gap > 0: they need that much space
  // between them; gap < 0: they may touch by a pixel or two.
  const hit = (a, b, gap) => a.left - gap < b.right && b.left - gap < a.right
    && a.top - gap < b.bottom && b.top - gap < a.bottom;

  // Zoomed out (zoom 14-15, Azure places), a town has more places than fit:
  // icons are drawn smaller, and an icon that would cover another is hidden.
  // The kinds most useful to a pilot win (airports, hospitals, schools...);
  // zoom in and the hidden ones come back.
  const ICON_ORDER = ['air', 'health', 'school', 'public', 'park', 'worship', 'car', 'food', 'shop', 'stay',
    'sight', 'transport', 'fun', 'work'];
  function hideOverlappingIcons() {
    const small = map.getZoom() < FULL_ZOOM;
    map.getContainer().classList.toggle('places-small', small);
    const items = [...markers.values()].map((m) => ({ m, el: m.getElement() })).filter((it) => it.el);
    if (!small) {
      for (const it of items) it.el.classList.remove('pin-off');
      return;
    }
    const rank = (m) => { const i = ICON_ORDER.indexOf(m.place?.kind); return i < 0 ? 99 : i; };
    for (const it of items) it.box = it.el.querySelector('.pin')?.getBoundingClientRect();
    // Same order every time (kind, then id), so icons don't swap while panning.
    items.sort((a, b) => rank(a.m) - rank(b.m) || (a.m.place.id < b.m.place.id ? -1 : 1));
    const kept = [];
    for (const it of items) {
      it.hide = !it.box || kept.some((k) => hit(it.box, k, 2));
      if (!it.hide) kept.push(it.box);
    }
    for (const it of items) it.el.classList.toggle('pin-off', it.hide);
  }

  function declutter() {
    hideOverlappingIcons();
    hideOverlappingNames();
  }

  // Names that would cover another name or another place's icon are hidden
  // (zoom in and they come back). The most useful kinds keep their names
  // first, e.g. a clinic before an office. Measured on screen in one go, then
  // changed in one go, so the browser only lays the page out once.
  const NAME_ORDER = ['air', 'health', 'car', 'food', 'shop', 'school', 'public', 'park', 'stay', 'sight',
    'transport', 'worship', 'fun', 'work'];
  function hideOverlappingNames() {
    if (!map.getContainer().classList.contains('places-names')) return;
    const rank = (m) => { const i = NAME_ORDER.indexOf(m.place?.kind); return i < 0 ? 99 : i; };
    const items = [...markers.values()].map((m) => {
      const el = m.getElement();
      const pin = el?.querySelector('.pin');
      const name = el?.querySelector('.nm');
      return pin && name ? { m, name, pin: pin.getBoundingClientRect(), box: name.getBoundingClientRect() } : null;
    }).filter(Boolean).sort((a, b) => rank(a.m) - rank(b.m));
    // Names need 6 px between them (touching names read as one); a name may
    // touch an icon by a pixel or two.
    const kept = [];
    for (const it of items) {
      const covers = kept.some((k) => hit(it.box, k, 6)) || items.some((o) => o !== it && hit(it.box, o.pin, -2));
      it.hide = covers;
      if (!covers) kept.push(it.box);
    }
    for (const it of items) it.name.classList.toggle('nm-off', it.hide);
  }

  // ---------- Google or Azure: one search for the middle of the screen ----------
  async function loadNearby() {
    if (busy) { again = true; return; }
    const from = NEARBY[source];
    const center = map.getCenter();
    const radius = Math.min(from.maxRadius, Math.max(50, center.distanceTo(map.getBounds().getNorthEast())));
    // Still near the last search, and not zoomed far out: no new search
    // (each search counts towards the daily limit).
    if (lastSearch && center.distanceTo(lastSearch.center) < lastSearch.radius * 0.5
        && radius <= lastSearch.radius * 1.5) {
      setStatus(`${draw()} places here (from ${from.name})${lastSearch.usage}`);
      return;
    }
    busy = true;
    setStatus(`Asking ${from.name} for places…`);
    try {
      const res = await fetch(`${from.url}?lat=${center.lat.toFixed(6)}&lon=${center.lng.toFixed(6)}&radius=${Math.round(radius)}`);
      const data = await res.json().catch(() => ({}));
      const used = Number.isInteger(data.used) ? ` · ${data.used} of ${data.limit} ${from.name} searches used today` : '';
      if (!res.ok && source === 'azure') {
        // Azure refused, is busy, or today's searches are used up: show
        // OpenStreetMap's places instead, and say why (see azureOffUntil).
        const usedUp = res.status === 429;
        azureOffUntil = usedUp ? Infinity : Date.now() + AZURE_RETRY_MS;
        azureWhy = usedUp
          ? `Today's ${data.limit ?? ''} Azure Maps places searches are used up (more tomorrow, or raise the limit in Settings), so these are OpenStreetMap's places.`
          : `Azure Maps places didn't answer${data.error ? ` (${data.error})` : res.status ? ` (error ${res.status})` : ''}, so these are OpenStreetMap's places; Azure is asked again in 5 minutes.`;
        busy = false;
        update();
        return;
      }
      if (!res.ok) {
        setStatus(data.limit === true || res.status === 429
          ? `Today's limit of ${data.limit ?? ''} Google places searches is used up. Places come back tomorrow (or raise the limit in Settings).`
          : data.off ? 'Google places are turned off in Settings.'
            : `Could not get places from Google${used}. See Troubleshooting in the README.`);
        if (res.status === 429) {
          lastSearch = { center, radius: Infinity, usage: used };   // don't keep asking today
          limitHit = true;
          refreshPictures();   // Google's own place labels come back on the map
        }
        return;
      }
      for (const p of data.places || []) known.set(p.id, p);
      if (known.size > 3000) known.clear();
      lastSearch = { center, radius, usage: used };
      if (source === 'google' && known.size > 600) known.clear();
      const count = on && map.getZoom() >= minZoom() ? draw() : 0;
      if (source === 'azure') azureWhy = '';
      setStatus(`${count} places here (from ${from.name})${data.remembered ? ' · remembered, not a new search' : used}`);
    } catch {
      setStatus('Could not load places (is the map server running?)');
    } finally {
      busy = false;
      if (again) { again = false; update(); }
    }
  }

  async function load() {
    if (NEARBY[source]) return loadNearby();
    if (busy) { again = true; return; }
    const box = missingBox(squaresOnScreen());
    if (!box) { setStatus(`${draw()} places here`); return; }
    if ((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) > MAX_SQUARES) {
      setStatus('Zoom in a little more to see places');
      return;
    }
    busy = true;
    setStatus('Loading places…');
    // OpenStreetMap's free servers can be slow: say so, and give up after
    // 70 s (the container tries two servers, 25 s each).
    const slow = setTimeout(() => setStatus('Still waiting for OpenStreetMap (its free servers can be slow)…'), 8000);
    const stop = new AbortController();
    const giveUp = setTimeout(() => stop.abort(), 70000);
    try {
      const res = await fetch(`api/places?x0=${box.x0}&x1=${box.x1}&y0=${box.y0}&y1=${box.y1}`, { signal: stop.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.busy ? 'OpenStreetMap is busy right now. Places will load when you move the map again in a minute.'
          : 'Could not reach OpenStreetMap from the map server. See Troubleshooting in the README.');
        return;
      }
      for (const p of data.places || []) known.set(p.id, p);
      if (!data.truncated) {
        for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) loaded.add(`${x}/${y}`);
      }
      // Don't let memory grow forever when exploring far and wide.
      if (known.size > 20000) { known.clear(); loaded.clear(); }
      const count = on && map.getZoom() >= minZoom() ? draw() : 0;
      setStatus(data.truncated ? 'There are too many places here to show them all. Zoom in to see more.' : `${count} places here`);
    } catch {
      setStatus(stop.signal.aborted ? 'OpenStreetMap did not answer. Move the map again in a minute to retry.'
        : 'Could not load places (is the map server running?)');
    } finally {
      clearTimeout(slow);
      clearTimeout(giveUp);
      busy = false;
      if (again) { again = false; update(); }
    }
  }

  // Called whenever the map stops moving, and when Places is switched.
  function update() {
    clearTimeout(timer);
    checkSource();
    refreshPictures();
    const zoom = map.getZoom();
    map.getContainer().classList.toggle('places-names', zoom >= NAMES_ZOOM);
    if (!on || zoom < minZoom()) {
      if (map.hasLayer(group)) map.removeLayer(group);
      showCredit(false);
      setStatus(on ? 'Zoom in closer to see places' : '');
      return;
    }
    if (!map.hasLayer(group)) group.addTo(map);
    showCredit(source === 'osm');
    draw();
    // Wait until the map has stopped moving (longer for Google/Azure: searches count).
    timer = setTimeout(load, NEARBY[source] ? 900 : 400);
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
  map.on('zoomend', () => requestAnimationFrame(declutter));
  update();

  return { setOn, isOn: () => on, status: () => status, update, hideOverlappingNames, declutter, googlePinsShown, KINDS };
})();
