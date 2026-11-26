'use strict';
/*
  The Stats tab (5.5.0): your flying in numbers (totals, a calendar of the
  days you flew, each drone), the health of each battery, and records.
  Everything is worked out here in the browser from the flight list the
  server already sends: nothing new is stored, nothing is sent anywhere.
*/

// DJI's specs for the Mini 3 / Mini 4 Pro batteries: what a NEW one holds.
const RATED_MAH = { standard: 2590, plus: 3850 };

const Stats = (() => {
  const box = () => $('#tab-stats');
  let period = loadSetting('statsPeriod', 'all');   // 'all' or a year, e.g. '2026'

  const local = (iso) => new Date(iso);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const sum = (list, key) => list.reduce((t, f) => t + (f[key] || 0), 0);
  const tile = (label, value) => `<div><span>${esc(label)}</span>${esc(value)}</div>`;
  const shortSerial = (sn) => `···${sn.slice(-6)}`;

  function years() {
    const set = new Set(state.flights.filter((f) => f.start).map((f) => local(f.start).getFullYear()));
    return [...set].sort((a, b) => b - a).map(String);
  }

  function inPeriod(f) {
    return period === 'all' || (f.start && String(local(f.start).getFullYear()) === period);
  }

  // ---------- 1. totals ----------
  function totalsHtml(list) {
    const days = new Set(list.filter((f) => f.start).map((f) => local(f.start).toDateString())).size;
    return `<div class="st-grid">
      ${tile('Flights', String(list.length))}
      ${tile('Air time', fmt.dur(sum(list, 'duration')))}
      ${tile('Distance', fmt.dist(sum(list, 'distance')))}
      ${tile('Days flown', String(days))}
      ${tile('Photos', String(sum(list, 'photoNum')))}
      ${tile('Video', fmt.dur(sum(list, 'videoTime')))}
    </div>`;
  }

  // ---------- 2. calendar: one row per month, one square per day ----------
  function calendarHtml(list) {
    const byDay = new Map();   // 'YYYY-M-D' -> { n, secs, iso }
    for (const f of list) {
      if (!f.start) continue;
      const d = local(f.start);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const e = byDay.get(key) || { n: 0, secs: 0, iso: f.start };
      e.n++; e.secs += f.duration || 0;
      byDay.set(key, e);
    }
    if (!byDay.size) return '';
    const dates = list.filter((f) => f.start).map((f) => local(f.start));
    const newest = new Date(Math.max(...dates)), oldest = new Date(Math.min(...dates));
    let y = newest.getFullYear(), m = newest.getMonth();
    const rows = [];
    // Newest month first; at most 24 months, so the list stays short.
    while (rows.length < 24 && (y > oldest.getFullYear() || (y === oldest.getFullYear() && m >= oldest.getMonth()))) {
      const daysIn = new Date(y, m + 1, 0).getDate();
      let cells = '';
      for (let d = 1; d <= 31; d++) {
        if (d > daysIn) { cells += '<i class="cal-day none"></i>'; continue; }
        const e = byDay.get(`${y}-${m}-${d}`);
        if (!e) { cells += '<i class="cal-day"></i>'; continue; }
        const mins = e.secs / 60;
        const level = mins < 10 ? 1 : mins < 20 ? 2 : mins < 40 ? 3 : 4;   // darker = more air time
        const when = new Date(y, m, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
        cells += `<button type="button" class="cal-day l${level}" data-day="${esc(e.iso)}"
          title="${esc(`${when}: ${plural(e.n, 'flight')}, ${fmt.dur(e.secs)}`)}" aria-label="${esc(`${when}: ${plural(e.n, 'flight')}`)}"></button>`;
      }
      const name = new Date(y, m, 1).toLocaleDateString([], { month: 'short', year: 'numeric' });
      rows.push(`<div class="cal-row"><span>${esc(name)}</span><div class="cal-days">${cells}</div></div>`);
      if (--m < 0) { m = 11; y--; }
    }
    return `<div class="cal">${rows.join('')}</div>
      <p class="st-hint">Each square is a day; darker = more air time. Click a day to see its flights.</p>`;
  }

  // ---------- 3. each drone ----------
  function dronesHtml(list) {
    const groups = new Map();
    for (const f of list) {
      const key = f.serial || f.aircraftName;
      const g = groups.get(key) || { name: displayName(f.serial, f.aircraftName), flights: [] };
      g.flights.push(f);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => `<div class="st-row">
      <b>${esc(g.name)}</b>
      <span>${esc(plural(g.flights.length, 'flight'))} · ${esc(fmt.dur(sum(g.flights, 'duration')))} · ${esc(fmt.dist(sum(g.flights, 'distance')))}</span>
    </div>`).join('');
  }

  // ---------- 4. battery health (always all time: a battery's whole life) ----------
  function batteryList() {
    const groups = new Map();
    for (const f of state.flights) {
      if (!f.batterySerial) continue;
      if (!groups.has(f.batterySerial)) groups.set(f.batterySerial, []);
      groups.get(f.batterySerial).push(f);
    }
    return [...groups.entries()].map(([serial, flights]) => {
      flights = flights.slice().sort((a, b) => (a.sortKey || 0) - (b.sortKey || 0));   // oldest first
      const newest = flights.at(-1);
      const caps = flights.filter((f) => f.batteryCapacity);
      const kind = newest.batteryKind || caps.at(-1)?.batteryKind || '';
      const now = caps.at(-1)?.batteryCapacity ?? null;
      // A new battery's capacity: DJI's spec for Mini batteries, otherwise the most this one ever held.
      const rated = RATED_MAH[kind] || (caps.length ? Math.max(...caps.map((f) => f.batteryCapacity)) : null);
      // Battery used per minute (only flights of at least a minute, like the planner).
      let used = 0, minutes = 0;
      for (const f of flights) {
        if (f.duration >= 60 && f.batteryStart != null && f.batteryEnd != null && f.batteryStart > f.batteryEnd) {
          used += f.batteryStart - f.batteryEnd; minutes += f.duration / 60;
        }
      }
      const temps = flights.filter((f) => f.batteryTempMax != null);
      const diffs = flights.filter((f) => f.cellDiffMax != null);
      return {
        serial, kind, flights, newest, caps, now, rated,
        health: now && rated ? Math.min(100, Math.round((now / rated) * 100)) : null,
        rate: minutes ? used / minutes : null,
        tempMax: temps.length ? Math.max(...temps.map((f) => f.batteryTempMax)) : null,
        tempMin: temps.length ? Math.min(...temps.map((f) => f.batteryTempMin ?? f.batteryTempMax)) : null,
        diffMax: diffs.length ? Math.max(...diffs.map((f) => f.cellDiffMax)) : null,
        diffLast: diffs.length ? diffs.at(-1).cellDiffMax : null,
      };
    }).sort((a, b) => (b.newest.sortKey || 0) - (a.newest.sortKey || 0));   // last used first
  }

  // A small line of the battery's full capacity, flight by flight.
  function capacityChart(b) {
    if (b.caps.length < 2) return '';
    const W = 300, H = 44;
    const vals = b.caps.map((f) => f.batteryCapacity);
    const hi = Math.max(...vals, b.rated || 0), lo = Math.min(...vals) - 50;
    const x = (i) => 4 + (i / (vals.length - 1)) * (W - 8);
    const y = (v) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
    const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const ratedLine = b.rated ? `<line class="rated" x1="0" x2="${W}" y1="${y(b.rated).toFixed(1)}" y2="${y(b.rated).toFixed(1)}"/>` : '';
    return `<svg class="cap-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Full capacity over ${vals.length} flights: from ${vals[0]} to ${vals.at(-1)} mAh">
      ${ratedLine}<polyline points="${line}"/></svg>
      <div class="st-hint">Full capacity, flight by flight${b.rated ? ' (dashed line: a new battery)' : ''}</div>`;
  }

  function batteriesHtml() {
    const list = batteryList();
    if (!list.length) return '<p class="st-hint">No battery serial numbers in your logs yet.</p>';
    return list.map((b) => {
      const name = { standard: 'Standard', plus: 'Plus' }[b.kind];
      const tiles = [
        tile('Flights', String(b.flights.length)),
        tile('Air time', fmt.dur(sum(b.flights, 'duration'))),
        tile('Last used', fmt.ago(b.newest.start)),
      ];
      if (b.rate != null) tiles.push(tile('Use per minute', `about ${b.rate.toFixed(1)}%`));
      if (b.tempMax != null) tiles.push(tile('Temperature', `${fmt.temp(b.tempMin)} – ${fmt.temp(b.tempMax)}`));
      // Biggest voltage difference between the cells: in the newest flight, and the most ever seen.
      if (b.diffMax != null) {
        const mv = (v) => `${Math.round(v * 1000)} mV`;   // millivolts: 0.030 V = 30 mV
        tiles.push(tile('Cell difference', b.diffMax > b.diffLast ? `${mv(b.diffLast)} · most ${mv(b.diffMax)}` : mv(b.diffLast)));
      }
      const health = b.health == null ? '<p class="st-hint">This battery\'s logs don\'t say how much it holds.</p>' : `
        <div class="health">
          <div class="health-text"><b>${b.health}%</b> of a new one · holds ${b.now} mAh${RATED_MAH[b.kind] ? ` (new: ${b.rated} mAh)` : ''}</div>
          <div class="health-bar" role="img" aria-label="${b.health}% of a new battery"><i style="width:${b.health}%"></i></div>
        </div>`;
      return `<article class="st-card battery" data-serial="${esc(b.serial)}">
        <div class="st-card-head"><h4>Battery ${esc(shortSerial(b.serial))}</h4>${name ? `<span class="tag">${esc(name)}</span>` : ''}</div>
        ${health}
        ${capacityChart(b)}
        <div class="st-grid">${tiles.join('')}</div>
      </article>`;
    }).join('') + `<p class="st-hint">A battery holds a little less as it ages. These numbers are read from your
      flight logs and are a rough guide only: DJI Fly's battery page is the official reading, and a battery that
      is swollen, damaged or warned about in DJI Fly should not be flown.</p>`;
  }

  // ---------- 5. records ----------
  function recordsHtml(list) {
    const best = (key) => list.reduce((top, f) => ((f[key] || 0) > (top?.[key] || 0) ? f : top), null);
    const rows = [
      ['Longest flight', 'duration', fmt.dur],
      ['Longest distance', 'distance', fmt.dist],
      ['Highest', 'maxHeight', fmt.height],
      ['Furthest from take-off', 'maxFromHome', fmt.dist],
    ].map(([label, key, show]) => {
      const f = best(key);
      if (!f) return '';
      return `<button type="button" class="st-row record" data-id="${esc(f.id)}">
        <b>${esc(label)}</b><span>${esc(show(f[key]))} · ${esc(fmt.date(f.start))}</span></button>`;
    }).join('');
    return rows ? `${rows}<p class="st-hint">Just for interest: not a goal to beat. Always fly within your local rules.</p>` : '';
  }

  function render() {
    const el = box();
    if (!el) return;
    if (!state.flights.length) { el.innerHTML = emptyMessage(state.lastData || {}); return; }
    const ys = years();
    if (period !== 'all' && !ys.includes(period)) period = 'all';
    const list = state.flights.filter(inPeriod);
    const choice = `<label class="st-period">Show
      <select id="st-period">
        <option value="all"${period === 'all' ? ' selected' : ''}>All time</option>
        ${ys.map((y) => `<option value="${y}"${period === y ? ' selected' : ''}>${y}</option>`).join('')}
      </select></label>`;
    el.innerHTML = `
      ${choice}
      <section class="st-section"><h3>Your flying</h3>${totalsHtml(list)}</section>
      <section class="st-section"><h3>Days you flew</h3>${calendarHtml(list) || '<p class="st-hint">No dated flights.</p>'}</section>
      <section class="st-section"><h3>Each drone</h3>${dronesHtml(list)}</section>
      <section class="st-section"><h3>Battery health <small>(all time)</small></h3>${batteriesHtml()}</section>
      <section class="st-section"><h3>Records</h3>${recordsHtml(list)}</section>`;
  }

  // ---------- buttons (one listener for the whole tab: its insides are redrawn) ----------
  function wire() {
    const el = box();
    el.addEventListener('change', (e) => {
      if (e.target.id !== 'st-period') return;
      period = e.target.value;
      saveSetting('statsPeriod', period);
      render();
    });
    el.addEventListener('click', (e) => {
      const day = e.target.closest('[data-day]');
      if (day) {
        // Show that day's flights in the Flights tab (the same filter as typing the date).
        state.filter = fmt.day(day.dataset.day);
        $('#search').value = state.filter;
        document.querySelector('.tabs button[data-tab=flights]').click();
        renderFlights(state.lastData);
        return;
      }
      const rec = e.target.closest('.record[data-id]');
      if (rec) selectFlight(rec.dataset.id);
    });
  }
  wire();

  return { render, batteryList };
})();
