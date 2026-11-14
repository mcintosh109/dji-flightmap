'use strict';
/*
  The version number next to "Flight Map", the green "Update available"
  notice, and the Updates window. The check itself is in updates.js.
*/

// ---------- updates ----------
// Installed version comes from the server; the newest from GitHub (updates.js).
// force: the "Check again" button (checks even if automatic checks are off).
// fresh: ask GitHub now instead of using the remembered answer (page load).
async function checkForUpdates({ force = false, fresh = false } = {}) {
  const app = state.lastData?.app;
  if (!app) return;
  $('#btn-version').textContent = `v${app.version}`;
  if (!state.settings.checkUpdates && !force) {
    state.update = { installed: app.version, disabled: true };
  } else if (app.updateUrl) {
    state.update = await Updates.check(app.version, app.updateUrl, { force: force || fresh });
  }
  const u = state.update || {};
  $('#update-banner').classList.toggle('hidden', !u.available);
  $('#btn-version').classList.toggle('has-update', !!u.available);
  if (u.available) $('#upd-banner-version').textContent = `version ${u.latest}`;
  if ($('#update-dialog').open) fillUpdateDialog();
}

function fillUpdateDialog() {
  const u = state.update || {};
  const status = $('#upd-status');
  let notesTitle = '';
  if (u.error) {
    status.textContent = `You have version ${u.installed}. Couldn't reach GitHub to check for a newer one (${u.error}).`;
    status.className = 'upd-status warn';
  } else if (u.disabled) {
    status.textContent = `You have version ${u.installed}. Automatic checks are off (see Update settings).`;
    status.className = 'upd-status';
  } else if (u.available) {
    status.innerHTML = `<b>Version ${esc(u.latest)}</b> is available${u.released ? ` (released ${esc(u.released)})` : ''}. You have version ${esc(u.installed)}.`;
    status.className = 'upd-status available';
    notesTitle = `What's new in ${u.latest}`;
  } else if (u.latest) {
    status.textContent = `You're up to date: version ${u.installed}.`;
    status.className = 'upd-status ok';
    notesTitle = `In this version`;
  } else {
    status.textContent = 'Checking…';
    status.className = 'upd-status';
  }
  const notes = (u.notes || []);
  $('#upd-notes').innerHTML = notesTitle && notes.length
    ? `<h3>${esc(notesTitle)}</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
}

function openUpdateDialog() {
  $('#upd-cmd').textContent = Updates.COMMAND;
  fillUpdateDialog();
  $('#update-dialog').showModal();
  if (!state.update || state.update.error) checkForUpdates({ force: true });
}

// ---------- buttons ----------
$('#btn-version').addEventListener('click', openUpdateDialog);
$('#update-banner').addEventListener('click', openUpdateDialog);
$('#upd-check').addEventListener('click', () => { $('#upd-status').textContent = 'Checking…'; checkForUpdates({ force: true }); });
Updates.wireCopyButton($('#upd-copy'));
