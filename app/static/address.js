'use strict';
/*
  The address search: the magnifying-glass button in the top-right corner.
  Click it, type an address (or a town, a landmark) and press Enter: the map
  goes there and puts a pin on it, ready for planning a flight.

  The server answers (GET api/geocode?q=&lat=&lon=, see flightmap/geocode.py)
  from Azure Maps (when Azure is the map provider) and OpenStreetMap.
  Coordinates (e.g. copied from Google Maps) are read here in the page and
  go straight there, without asking anyone. The middle of the map is sent along, so places near what
  you're looking at come first. It searches only when Enter is pressed (not
  while typing): OpenStreetMap's free search asks for that.
*/
const AddressSearch = (() => {
  let pin = null;          // the pin of the last place picked
  let results = [];
  let busy = null;         // AbortController of the search running now

  const panel = () => $('#addr-panel');

  function toggle(open) {
    const show = open ?? panel().classList.contains('hidden');
    panel().classList.toggle('hidden', !show);
    $('#btn-addr').setAttribute('aria-expanded', String(show));
    if (show) {
      if (typeof toggleLayersPanel === 'function') toggleLayersPanel(false);
      const box = $('#addr-q');
      box.focus();
      box.select();
    }
  }

  function say(text) {
    $('#addr-results').innerHTML = text ? `<p class="addr-msg">${esc(text)}</p>` : '';
  }

  // Coordinates typed or pasted, in the usual ways of writing them:
  //   40.7812, -73.9665        (Google Maps: right-click a spot, click the numbers)
  //   40.7812 N, 73.9665 W
  //   40°46'52.3"N 73°57'59.4"W
  // Returns { lat, lon }, or null if it isn't coordinates (then it's an address).
  function readCoordinates(text) {
    const t = text.trim().toUpperCase().replace(/[′’‘]/g, "'").replace(/[″“”]|''/g, '"').replace(/º/g, '°');
    // One number: degrees, maybe minutes ('), maybe seconds (").
    const num = String.raw`([-+]?\d{1,3}(?:\.\d+)?)\s*°?\s*(?:(\d{1,2}(?:\.\d+)?)\s*'\s*(?:(\d{1,2}(?:\.\d+)?)\s*")?)?`;
    // N/S/E/W after each number ("40.7 N, 73.9 W"), or before each one ("N 40.7 W 73.9").
    const after = t.match(new RegExp(String.raw`^${num}\s*([NSEW])?\s*(,|;|\s)\s*${num}\s*([NSEW])?$`));
    const before = after ? null : t.match(new RegExp(String.raw`^([NSEW])\s*${num}\s*(,|;|\s)\s*([NSEW])\s*${num}$`));
    let d1, m1, s1, h1, sep, d2, m2, s2, h2;   // degrees, minutes, seconds, N/S/E/W of each number
    if (after) [, d1, m1, s1, h1, sep, d2, m2, s2, h2] = after;
    else if (before) [, h1, d1, m1, s1, sep, h2, d2, m2, s2] = before;
    else return null;
    const hemis = [h1, h2];
    // Without a comma, N/S/E/W, minutes or a decimal point, "12 34" is more
    // likely part of an address than coordinates.
    if (sep !== ',' && sep !== ';' && !hemis[0] && !hemis[1] && !m1 && !(d1.includes('.') && d2.includes('.'))) return null;
    const value = (d, mi, se, h) => {
      if (Number(mi || 0) >= 60 || Number(se || 0) >= 60) return NaN;
      if (h && /^[-+]/.test(d)) return NaN;   // "-40 N" makes no sense
      const v = Math.abs(Number(d)) + Number(mi || 0) / 60 + Number(se || 0) / 3600;
      return (d.startsWith('-') || h === 'S' || h === 'W') ? -v : v;
    };
    let lat = value(d1, m1, s1, hemis[0]), lon = value(d2, m2, s2, hemis[1]);
    if (/[EW]/.test(hemis[0] || '') || /[NS]/.test(hemis[1] || '')) {
      if (/[NS]/.test(hemis[0] || '') || /[EW]/.test(hemis[1] || '')) return null;   // "N ... N"
      [lat, lon] = [lon, lat];   // written longitude first: "73.9 W, 40.7 N"
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  async function find(e) {
    e.preventDefault();
    const q = $('#addr-q').value.trim();
    const spot = readCoordinates(q);
    if (spot) {
      if (busy) busy.abort();
      results = [];
      const name = `${spot.lat.toFixed(5)}, ${spot.lon.toFixed(5)}`;
      go({ name, label: name, lat: spot.lat, lon: spot.lon });
      say('');
      $('#addr-foot').textContent = '';
      return;
    }
    if (q.length < 3) { say('Type at least 3 letters of an address or a place.'); return; }
    if (busy) busy.abort();
    busy = new AbortController();
    const stop = busy;
    say('Searching…');
    const c = map.getCenter().wrap();
    try {
      const res = await fetch(`api/geocode?q=${encodeURIComponent(q)}&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`,
        { signal: stop.signal });
      const answer = await res.json().catch(() => ({}));
      if (stop !== busy) return;   // a newer search started
      if (!res.ok) { say(answer.error ? `Could not search: ${answer.error}.` : `Could not search (error ${res.status}).`); return; }
      results = answer.results || [];
      show(answer);
    } catch (err) {
      if (err.name !== 'AbortError') say('Could not reach the map server. Check the connection and try again.');
    } finally {
      if (stop === busy) busy = null;
    }
  }

  function show(answer) {
    const list = $('#addr-results');
    if (!results.length) {
      say('Nothing found. Try adding the town or the state, e.g. "12 Main St, Springfield, IL". '
        + 'Or paste the spot\'s coordinates from Google Maps (right-click the spot, then click the numbers at the top).');
    } else {
      const both = answer.source === 'azure+osm';
      const company = { azure: 'Azure Maps', osm: 'OpenStreetMap' };
      list.innerHTML = results.map((r, i) => {
        const detail = [r.detail, both ? company[r.from] : ''].filter(Boolean).join(' · ');
        return `<button type="button" class="addr-result" data-i="${i}">
          <span class="addr-name">${esc(r.name)}</span>${detail ? `<small>${esc(detail)}</small>` : ''}
        </button>`;
      }).join('');
      list.querySelectorAll('.addr-result').forEach((b) => b.addEventListener('click', () => go(results[Number(b.dataset.i)])));
    }
    const source = { azure: 'Addresses from Azure Maps.', osm: 'Addresses © OpenStreetMap contributors.',
      'azure+osm': 'Addresses from Azure Maps and © OpenStreetMap contributors.' }[answer.source] || '';
    $('#addr-foot').textContent = answer.note ? `${source} (Azure Maps was not used: ${answer.note}.)` : source;
  }

  // Go to a place and pin it. A town or a county is shown whole; an
  // address is shown close up (about 500 m across). The pin shows r.label,
  // or the name up to its first comma ("1 Park Loop" of "1 Park Loop, New York").
  function go(r) {
    if (!r) return;
    const at = L.latLng(r.lat, r.lon);
    let area = at.toBounds(500);
    if (r.box) {
      const box = L.latLngBounds([r.box[0], r.box[1]], [r.box[2], r.box[3]]);
      if (box.isValid() && box.contains(at) && box.getNorthEast().distanceTo(box.getSouthWest()) > 500) area = box;
    }
    map.fitBounds(area, { ...fitOptions(), maxZoom: 18 });
    clearPin();
    // interactive: false = clicks go through the pin to the map, so a
    // waypoint can be put right on it while planning.
    pin = L.marker(at, { icon: L.divIcon({ className: 'addr-pin', html: '<span></span>', iconSize: [26, 34], iconAnchor: [13, 34] }),
      interactive: false, keyboard: false, zIndexOffset: 500 })
      .bindTooltip(esc(r.label || r.name.split(',')[0]), { permanent: true, direction: 'top', offset: [0, -34], className: 'addr-label', interactive: false })
      .addTo(map);
    $('#addr-clear').classList.remove('hidden');
    toggle(false);
  }

  function clearPin() {
    if (pin) map.removeLayer(pin);
    pin = null;
    $('#addr-clear').classList.add('hidden');
  }

  // ---------- buttons ----------
  $('#btn-addr').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  $('#addr-form').addEventListener('submit', find);
  $('#btn-layers').addEventListener('click', () => toggle(false));   // one panel at a time
  $('#addr-clear').addEventListener('click', () => { clearPin(); $('#addr-q').focus(); });
  panel().addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => { if (!e.target.closest('#addr-panel, #btn-addr')) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel().classList.contains('hidden')) toggle(false); });

  return { toggle, go, clearPin };
})();
