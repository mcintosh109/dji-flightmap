'use strict';
/*
  The Maintenance tab (5.6.0): reminders for jobs you do now and then
  (replace the propellers, clean the motors...). Each reminder has up to
  three limits: flying hours, flights and days since it was last done, and
  is DUE when any of them is reached. The server stores the reminders
  (/api/maintenance); the hours and flights are counted here from the
  flight list. A drone's card on the Aircraft tab says when a job is due.

  Only reminders: DJI's checks before every flight still apply.
*/

const Maintenance = (() => {
  let items = [];
  let loaded = false;
  let editing = null;   // the reminder being edited ('new' for a new one), or null

  const box = () => $('#tab-maint');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const todayText = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const dayName = (text) => new Date(`${text}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

  // Starting points only: DJI doesn't publish fixed intervals. Change them to suit you.
  const EXAMPLES = [
    { name: 'Propellers: replace', everyHours: 10 },
    { name: 'Clean the motors and air vents', everyFlights: 20 },
    { name: 'Check for firmware and DJI Fly updates', everyDays: 30 },
    { name: 'Inspect the gimbal and camera', everyDays: 30 },
  ];

  const send = (method, url, body) => fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'flightmap' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  async function load() {
    try {
      const res = await fetch('api/maintenance');
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      items = (await res.json()).items || [];
      loaded = true;
    } catch (err) {
      items = [];
      loaded = false;
      if (box()) box().innerHTML = `<p class="note">Could not load the maintenance reminders (${esc(err.message)}).</p>`;
      return;
    }
    render();
    if (state.lastData) renderAircraft(state.lastData);   // the drone cards show what is due (once the flights are here)
  }

  // ---------- counting ----------
  // The flights since the job was last done, for that drone (or all drones).
  function flightsSince(item) {
    const doneAt = item.doneAt ? new Date(item.doneAt).getTime() : null;
    return state.flights.filter((f) => {
      if (!f.start) return false;
      if (item.drone !== 'all' && Stats.droneKey(f) !== item.drone) return false;
      // Marked done today: only flights after that moment. Otherwise from the start of that day.
      if (doneAt && localDay(f.start) === item.lastDone) return new Date(f.start).getTime() > doneAt;
      return localDay(f.start) >= item.lastDone;
    });
  }

  // How far along each limit is: [{ label, used, limit, frac, text }], plus the overall state.
  function progress(item) {
    const since = flightsSince(item);
    const hours = since.reduce((t, f) => t + (f.duration || 0), 0) / 3600;
    const days = Math.max(0, Math.floor((new Date(`${todayText()}T12:00:00`) - new Date(`${item.lastDone}T12:00:00`)) / 86400000));
    const parts = [];
    if (item.everyHours) parts.push({ label: 'Flying', frac: hours / item.everyHours, text: `${hours.toFixed(1)} of ${item.everyHours} hours` });
    if (item.everyFlights) parts.push({ label: 'Flights', frac: since.length / item.everyFlights, text: `${since.length} of ${item.everyFlights} flights` });
    if (item.everyDays) parts.push({ label: 'Time', frac: days / item.everyDays, text: `${plural(days, 'day')} of ${item.everyDays}` });
    const worst = Math.max(0, ...parts.map((p) => p.frac));
    return { parts, worst, state: worst >= 1 ? 'due' : worst >= 0.8 ? 'soon' : 'ok' };
  }

  // How many jobs are due for one drone (reminders for "All drones" count for every drone).
  function dueFor(key) {
    return items.filter((it) => (it.drone === 'all' || it.drone === key) && progress(it).state === 'due').length;
  }

  // ---------- drawing ----------
  function droneName(key) {
    if (key === 'all') return 'All drones';
    return Stats.droneList().find((d) => d.key === key)?.label || key;
  }

  function cardHtml(item) {
    const p = progress(item);
    const tag = { due: 'Due', soon: 'Soon', ok: 'OK' }[p.state];
    const bars = p.parts.map((part) => `<div class="mt-limit">
        <div class="mt-limit-text"><span>${esc(part.label)}</span>${esc(part.text)}</div>
        <div class="mt-bar ${part.frac >= 1 ? 'due' : part.frac >= 0.8 ? 'soon' : ''}"><i style="width:${Math.min(100, Math.round(part.frac * 100))}%"></i></div>
      </div>`).join('');
    return `<article class="st-card mt-card ${p.state}" data-id="${esc(item.id)}">
      <div class="st-card-head"><h4>${esc(item.name)}</h4><span class="tag mt-${p.state}">${tag}</span></div>
      <div class="flown-in">For: ${esc(droneName(item.drone))} · last done ${esc(dayName(item.lastDone))}</div>
      ${bars}
      ${item.notes ? `<p class="mt-notes">${esc(item.notes)}</p>` : ''}
      <div class="actions">
        <button type="button" class="chip accent" data-act="done">Mark done</button>
        <button type="button" class="chip" data-act="edit">Edit</button>
        <button type="button" class="chip" data-act="delete">Delete</button>
      </div>
    </article>`;
  }

  function formHtml(item) {
    const v = item || { name: '', drone: defaultDrone(), everyHours: null, everyFlights: null, everyDays: null, lastDone: todayText(), notes: '' };
    const drones = [{ key: 'all', label: 'All drones' }, ...Stats.droneList()];
    if (!drones.some((d) => d.key === v.drone)) drones.push({ key: v.drone, label: v.drone });
    const num = (id, value, step) => `<input id="${id}" type="number" min="0" step="${step}" value="${value ?? ''}" placeholder="–">`;
    return `<form class="st-card mt-form" id="mt-form" novalidate>
      <h4>${item ? 'Edit reminder' : 'New reminder'}</h4>
      <label>What to do<input id="mt-name" type="text" maxlength="60" value="${esc(v.name)}" placeholder="e.g. Propellers: replace"></label>
      <label>Drone<select id="mt-drone">${drones.map((d) => `<option value="${esc(d.key)}"${d.key === v.drone ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>
      <div class="mt-every">Due after <small>(fill in one or more; it is due when the first is reached)</small></div>
      <div class="mt-limits">
        <label>Flying hours${num('mt-hours', v.everyHours, '0.5')}</label>
        <label>Flights${num('mt-flights', v.everyFlights, '1')}</label>
        <label>Days${num('mt-days', v.everyDays, '1')}</label>
      </div>
      <label>Last done<input id="mt-last" type="date" max="${todayText()}" value="${esc(v.lastDone || todayText())}"></label>
      <label>Notes<textarea id="mt-notes" maxlength="500" rows="2">${esc(v.notes || '')}</textarea></label>
      <p class="mt-error hidden" id="mt-error" role="alert"></p>
      <div class="actions">
        <button type="submit" class="chip accent">Save</button>
        <button type="button" class="chip" data-act="cancel">Cancel</button>
      </div>
    </form>`;
  }

  // New reminders start on the only drone there is, or on "All drones".
  function defaultDrone() {
    const drones = Stats.droneList();
    return drones.length === 1 ? drones[0].key : 'all';
  }

  function render() {
    const el = box();
    if (!el || !loaded) return;
    const order = { due: 0, soon: 1, ok: 2 };
    const sorted = items.slice().sort((a, b) => order[progress(a).state] - order[progress(b).state] || a.name.localeCompare(b.name));
    const due = items.filter((it) => progress(it).state === 'due').length;
    $('#maint-count').textContent = due ? String(due) : '';
    $('#maint-count').classList.toggle('due', due > 0);
    let html = `<p class="plans-disclaimer" role="note"><b>Reminders only.</b> Keep doing DJI's checks before every
      flight (propellers, battery, motors, gimbal). DJI doesn't publish fixed times for these jobs: the numbers are yours to choose.</p>`;
    if (editing === 'new') html += formHtml(null);
    else html += '<button type="button" class="chip accent new-plan" data-act="new">＋ Add a reminder</button>';
    if (!items.length && editing !== 'new') {
      html += `<div class="empty">No reminders yet.<br>
        <button type="button" class="chip" data-act="examples">Add examples</button>
        <small class="st-hint">Adds 4 examples you can change or delete: propellers (every 10 hours), clean the motors
        (every 20 flights), firmware updates and the gimbal (every 30 days).</small></div>`;
    }
    for (const it of sorted) html += editing === it.id ? formHtml(it) : cardHtml(it);
    el.innerHTML = html;
    $('#mt-name')?.focus();
  }

  // ---------- buttons ----------
  function readForm() {
    const n = (id) => { const t = $(id).value.trim(); return t === '' ? null : Number(t); };
    return {
      name: $('#mt-name').value.trim(), drone: $('#mt-drone').value,
      everyHours: n('#mt-hours'), everyFlights: n('#mt-flights'), everyDays: n('#mt-days'),
      lastDone: $('#mt-last').value, notes: $('#mt-notes').value.trim(),
    };
  }

  async function save(e) {
    e.preventDefault();
    const body = readForm();
    const err = $('#mt-error');
    try {
      const res = await send('PUT', `api/maintenance/${editing === 'new' ? 'new' : encodeURIComponent(editing)}`, body);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server answered ${res.status}`);
    } catch (ex) {
      err.textContent = `Not saved: ${ex.message}`;
      err.classList.remove('hidden');
      return;
    }
    editing = null;
    await load();
  }

  async function act(name, id) {
    const item = items.find((it) => it.id === id);
    try {
      if (name === 'done') {
        if (!confirm(`Mark "${item.name}" as done today?\n\nCounting starts again from now. (To pick another day, use Edit → Last done.)`)) return;
        const res = await send('POST', `api/maintenance/${encodeURIComponent(id)}/done`, { date: todayText() });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `server answered ${res.status}`);
      } else if (name === 'delete') {
        if (!confirm(`Delete the reminder "${item.name}"?`)) return;
        const res = await send('DELETE', `api/maintenance/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`server answered ${res.status}`);
      } else if (name === 'examples') {
        for (const ex of EXAMPLES) {
          const res = await send('PUT', 'api/maintenance/new', { drone: defaultDrone(), lastDone: todayText(), notes: 'Example: change the numbers to suit you.', ...ex });
          if (!res.ok) throw new Error(`server answered ${res.status}`);
        }
      }
    } catch (ex) {
      alert(`That didn't work: ${ex.message}`);
    }
    await load();
  }

  function wire() {
    const el = box();
    el.addEventListener('submit', save);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const name = btn.dataset.act;
      const id = btn.closest('[data-id]')?.dataset.id;
      if (name === 'new') { editing = 'new'; render(); return; }
      if (name === 'edit') { editing = id; render(); return; }
      if (name === 'cancel') { editing = null; render(); return; }
      act(name, id);
    });
  }
  wire();
  load();

  // The "due" line on a drone's card opens this tab.
  function show() {
    document.querySelector('.tabs button[data-tab=maint]').click();
  }

  // New flights arrived: redraw, unless a reminder is being typed (that would wipe it).
  function refresh() { if (!editing) render(); }

  return { render, refresh, load, dueFor, show };
})();
