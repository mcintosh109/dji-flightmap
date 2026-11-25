'use strict';
/*
  The address search: the magnifying-glass button in the top-right corner.
  Click it, type an address (or a town, a landmark) and press Enter: the map
  goes there and puts a pin on it, ready for planning a flight.

  The server answers (GET api/geocode?q=&lat=&lon=, see flightmap/geocode.py)
  from Azure Maps when Azure is the map provider, otherwise from
  OpenStreetMap. The middle of the map is sent along, so places near what
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

  async function find(e) {
    e.preventDefault();
    const q = $('#addr-q').value.trim();
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
      say('Nothing found. Try adding the town or the state, e.g. "12 Main St, Springfield, IL".');
    } else {
      list.innerHTML = results.map((r, i) => `<button type="button" class="addr-result" data-i="${i}">
          <span class="addr-name">${esc(r.name)}</span>${r.detail ? `<small>${esc(r.detail)}</small>` : ''}
        </button>`).join('');
      list.querySelectorAll('.addr-result').forEach((b) => b.addEventListener('click', () => go(results[Number(b.dataset.i)])));
    }
    const source = answer.source === 'azure' ? 'Addresses from Azure Maps.' : 'Addresses © OpenStreetMap contributors.';
    $('#addr-foot').textContent = answer.note ? `${source} (Azure Maps was not used: ${answer.note}.)` : source;
  }

  // Go to a place and pin it. A town or a county is shown whole; an
  // address is shown close up (about 500 m across).
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
      .bindTooltip(esc(r.name.split(',')[0]), { permanent: true, direction: 'top', offset: [0, -34], className: 'addr-label', interactive: false })
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
