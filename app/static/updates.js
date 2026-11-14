'use strict';
/*
  Update checks, shared by the map page and the settings page.

  The server tells us which version is installed. We download the newest
  app/version.json from GitHub and compare the two numbers. The answer is
  remembered for 6 hours so GitHub isn't asked on every page load.
*/
window.Updates = (() => {
  const COMMAND = 'cd /root/dji-flightmap && bash deploy/update-ct.sh';
  const CACHE_KEY = 'updateCheck';
  const CACHE_MS = 6 * 60 * 60 * 1000;

  // "1.10.0" is newer than "1.9.2": compare number by number.
  function isNewer(latest, installed) {
    const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(installed).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
  }
  function writeCache(value) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* ignore */ }
  }

  // Returns { installed, latest, notes, released, available, checkedAt } or
  // { error } if GitHub couldn't be reached.
  async function check(installed, url, { force = false } = {}) {
    const cached = readCache();
    if (!force && cached && cached.url === url && Date.now() - cached.checkedAt < CACHE_MS) {
      return { ...cached, installed, available: isNewer(cached.latest, installed) };
    }
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const data = await res.json();
      const info = {
        url,
        latest: String(data.version || '0.0.0').slice(0, 20),
        released: String(data.released || '').slice(0, 20),
        notes: (Array.isArray(data.notes) ? data.notes : []).slice(0, 10).map((n) => String(n).slice(0, 200)),
        checkedAt: Date.now(),
      };
      writeCache(info);
      return { ...info, installed, available: isNewer(info.latest, installed) };
    } catch (err) {
      return { installed, error: err.message, checkedAt: Date.now() };
    }
  }

  // Copy text. navigator.clipboard only works on https:// pages, so fall
  // back to the older method, which also works on plain http://.
  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* try the fallback */ }
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    box.remove();
    return ok;
  }

  // Hook up a "Copy" button: shows "Copied ✓" (or tells you to copy by hand).
  function wireCopyButton(button, text = COMMAND) {
    button.addEventListener('click', async () => {
      const ok = await copy(text);
      const before = button.dataset.label || button.textContent;
      button.dataset.label = before;
      button.textContent = ok ? 'Copied ✓' : 'Select the text and copy it';
      setTimeout(() => { button.textContent = before; }, 2500);
    });
  }

  return { COMMAND, check, copy, isNewer, wireCopyButton };
})();
